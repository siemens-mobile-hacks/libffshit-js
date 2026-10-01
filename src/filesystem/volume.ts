import { concat } from "../bytes.js";
import { FFSError } from "../errors.js";
import { dateToFatTime, fatTimeToDate } from "./fattime.js";
import { isDirectory, WritableFormat, type Format, type Header, type Part } from "./format.js";
import type { Records } from "./records.js";
import { firmwareSpace } from "./space.js";

// Where a directory lists an entry: the id of its header, in a record of the directory's entries
interface EntryRef {
    record: number;
    offset: number;
    id: number;
}

export interface Child {
    entry: EntryRef;
    header: Header;
    name: string;
}

// The records a header's data is in
interface Chain {
    data: number[];
    parts: number[];
    // The header or part that ends it, which a directory grows after
    last: number;
    // What breaks it
    problem?: string;
    // The ids it names that no record has
    missing: number[];
}

interface Listing {
    entries: EntryRef[];
    free: EntryRef | undefined;
    last: number;
    problem?: string;
}

const FORBIDDEN = "\\/:*?\"<>|";

function isPieceSize(size: number): boolean {
    return size >= 256 && size <= 4096 && (size & (size - 1)) === 0;
}

// In bytes
export interface Space {
    size: number;
    free: number;
}

// What is read of a partition's filesystem
export interface Filesystem {
    readonly name: string;
    // What it holds, headers and indexes included, and how much of that is free
    space(): Space;
    // Undefined when there is none. Throws when it is too short.
    root(): Header | undefined;
    // The size of a file's data, or what breaks it
    size(header: Header): number | string;
    read(header: Header): Uint8Array;
    // The entries of a directory whose headers are there. What is not is reported.
    children(dir: Header, report?: (problem: string) => void): Child[];
    // As the firmware finds names: without regard to case, as far as it folds it
    find(dir: Header, name: string): Child | undefined;
    // The same for two names find() takes for the same one
    fold(name: string): string;
    timestamp(header: Header): Date;
    // What writes to it, once it is checked that it can be written to
    writable(): Volume;
}

// The filesystem of one partition, read from its records whenever it is asked for anything
export class Volume implements Filesystem {
    // What writing to it takes, read on the first write
    private chunkSize = 0;
    private missingReserved = false;

    constructor(
        readonly name: string,
        private readonly records: Records,
        private readonly format: Format,
        // Why it cannot be written to
        private readonly readOnly?: string,
    ) {
    }

    root(): Header | undefined {
        return this.format.header(this.format.rootId);
    }

    // As the firmware reckons it where that is known, else in bytes of the flash
    space(): Space {
        const format = this.format;

        if (format instanceof WritableFormat && format.space) {
            const pieceSize = this.pieceSize(format);

            if (pieceSize) {
                return firmwareSpace(format.space, this.records.usage(), pieceSize);
            }
        }

        return this.records.space();
    }

    // Of the configuration record, when it is there and tells a size the library knows
    private pieceSize(format: WritableFormat): number | undefined {
        const size = this.records.has(format.configId) ? format.chunkSize(this.records.read(format.configId)) : 0;

        return isPieceSize(size) ? size : undefined;
    }

    // Of the parts that name the record before them as theirs: one that does not is another's, which
    // a part that was missing when it was written leads to
    private chain(header: Header): Chain {
        const none              = this.format.none;
        const chain: Chain      = { data: [], parts: [], last: header.id, missing: [] };
        const visited           = new Set<number>();

        // A file without data is empty, but a directory always has a record of entries
        if (this.records.has(header.dataId)) {
            chain.data.push(header.dataId);
        } else {
            chain.missing.push(header.dataId);

            if (header.nextPart !== none || isDirectory(header)) {
                chain.problem = `its data record ${header.dataId} is missing`;
            }
        }

        for (let next = header.nextPart; next !== none;) {
            if (visited.has(next)) {
                chain.problem = "its parts loop";

                break;
            }

            visited.add(next);

            let part: Part | undefined;

            try {
                part = this.format.part(next);
            } catch (e) {
                if (!(e instanceof FFSError)) {
                    throw e;
                }

                chain.problem = e.message;

                break;
            }

            if (!part) {
                chain.problem = `its part ${next} is missing`;
                chain.missing.push(next);

                break;
            }

            if (part.id !== next) {
                chain.problem = `record ${next} holds the part of ${part.id}`;

                break;
            }

            if (part.prev !== chain.last) {
                chain.problem = `record ${next} is not its part`;

                break;
            }

            chain.parts.push(next);
            chain.last = next;

            if (this.records.has(part.dataId)) {
                chain.data.push(part.dataId);
            } else {
                chain.problem ??= `the data record ${part.dataId} of its part ${next} is missing`;
                chain.missing.push(part.dataId);
            }

            next = part.next;
        }

        return chain;
    }

    private dataSize(chain: Chain): number {
        return chain.data.reduce((size, id) => size + this.records.size(id), 0);
    }

    size(header: Header): number | string {
        const chain = this.chain(header);

        return chain.problem ?? this.dataSize(chain);
    }

    read(header: Header): Uint8Array {
        const chain = this.chain(header);

        if (chain.problem) {
            throw new FFSError(chain.problem);
        }

        return concat(chain.data.map((id) => this.records.read(id)));
    }

    private list(dir: Header, chain = this.chain(dir)): Listing {
        const { entrySize, none }   = this.format;
        const listing: Listing      = { entries: [], free: undefined, last: chain.last, problem: chain.problem };

        for (const record of chain.data) {
            const data = this.records.read(record);

            for (let offset = 0; offset + entrySize <= data.length; offset += entrySize) {
                const id = this.format.entryId(data, offset);

                if (id === none) {
                    listing.free ??= { record, offset, id };
                } else if (id !== 0) {
                    listing.entries.push({ record, offset, id });
                }
            }
        }

        return listing;
    }

    children(dir: Header, report: (problem: string) => void = () => {}): Child[] {
        const listing   = this.list(dir);
        const children: Child[] = [];

        if (listing.problem) {
            report(listing.problem);
        }

        for (const entry of listing.entries) {
            const header = this.entryHeader(entry, report);

            if (header) {
                children.push({ entry, header, name: this.format.name(header) });
            }
        }

        return children;
    }

    // The header an entry leads to, unless it leads to none, which is reported
    private entryHeader(entry: EntryRef, report: (problem: string) => void = () => {}): Header | undefined {
        let header: Header | undefined;

        try {
            header = this.format.header(entry.id);
        } catch (e) {
            if (!(e instanceof FFSError)) {
                throw e;
            }

            report(e.message);

            return undefined;
        }

        if (!header) {
            report(`record ${entry.id} is missing`);
        } else if (header.id !== entry.id) {
            report(`record ${entry.id} holds the header of ${header.id}`);
        } else {
            return header;
        }

        return undefined;
    }

    find(dir: Header, name: string): Child | undefined {
        const key = this.fold(name);

        return this.children(dir).find((child) => this.fold(child.name) === key);
    }

    fold(name: string): string {
        return this.format.fold(name);
    }

    // The broken files of a directory that holds nothing else but entries that lead to no header,
    // or undefined when it holds anything else
    private brokenContents(dir: Header): Header[] | undefined {
        const broken: Header[] = [];

        for (const entry of this.list(dir).entries) {
            const header = this.entryHeader(entry);

            if (!header) {
                continue;
            }

            if (isDirectory(header) || !this.chain(header).problem) {
                return undefined;
            }

            broken.push(header);
        }

        return broken;
    }

    // Whether it holds nothing but what is broken, which delete() removes with it
    isEmpty(dir: Header): boolean {
        return this.brokenContents(dir) !== undefined;
    }

    // What breaks the records of a directory's entries, which it would grow after
    directoryProblem(dir: Header): string | undefined {
        return this.list(dir).problem;
    }

    timestamp(header: Header): Date {
        return fatTimeToDate(header.fatTime, this.format.utc);
    }

    fatTime(timestamp: Date | number): number {
        return dateToFatTime(timestamp, this.format.utc);
    }

    // =========================================================================
    // Writing

    // Checks that the volume can be written to, the first time
    private prepareWrite(): WritableFormat {
        const format = this.format;

        if (this.readOnly !== undefined || !(format instanceof WritableFormat)) {
            throw new FFSError(`${this.name}: ${this.readOnly ?? "read only"}`);
        }

        if (this.chunkSize) {
            return format;
        }

        if (this.records.problems.length) {
            throw new FFSError(`${this.name} is broken, not writing to it: ${this.records.problems[0]}`);
        }

        if (!this.records.has(format.configId)) {
            throw new FFSError(`${this.name} has no configuration record, not writing to it`);
        }

        const chunkSize = format.chunkSize(this.records.read(format.configId));

        if (!isPieceSize(chunkSize)) {
            throw new FFSError(`${this.name}: unknown chunk size ${chunkSize}, not writing to it`);
        }

        // Read as one whatever its attributes, but whether the firmware would write to it is not known
        if (!isDirectory(this.root()!)) {
            throw new FFSError(`${this.name}: its root does not have the directory attribute, not writing to it`);
        }

        this.chunkSize = chunkSize;

        return format;
    }

    // What the headers and entries from the directory down name that no record has
    private reserveMissing(dir: Header, visited: Set<number>): void {
        const chain = this.chain(dir);

        visited.add(dir.id);
        chain.missing.forEach((id) => this.records.reserve(id));

        for (const entry of this.list(dir, chain).entries) {
            if (!this.records.has(entry.id)) {
                this.records.reserve(entry.id);

                continue;
            }

            const header = this.entryHeader(entry);

            if (!header || visited.has(header.id)) {
                continue;
            }

            if (isDirectory(header)) {
                this.reserveMissing(header, visited);
            } else {
                visited.add(header.id);
                this.chain(header).missing.forEach((id) => this.records.reserve(id));
            }
        }
    }

    writable(): Volume {
        this.prepareWrite();

        return this;
    }

    // The name as a header would keep it, of a path, so neither empty, "." nor "..". Throws when it is
    // none the firmware takes.
    encodeName(name: string): Uint8Array {
        for (const c of name) {
            if (c.charCodeAt(0) < 0x20 || c === "\x7F" || FORBIDDEN.includes(c)) {
                throw new FFSError(`Invalid name '${name}': no control characters and none of ${FORBIDDEN}`);
            }
        }

        return this.prepareWrite().encodeName(name);
    }

    // Everything the operation writes, or on an error nothing. Before the first, what the filesystem
    // names without a record is reserved, while all of it is where the root leads.
    transaction(operation: () => void): void {
        if (!this.missingReserved) {
            this.reserveMissing(this.root()!, new Set());
            this.missingReserved = true;
        }

        this.records.transaction(operation);
    }

    // A file is a header, its data in pieces of the chunk size, and a part for every piece after
    // the first. The attributes are of Attributes, the directory's aside.
    createFile(dir: Header, name: Uint8Array, data: Uint8Array, fatTime: number, attributes = 0): void {
        const format    = this.prepareWrite();
        const chunkSize = this.chunkSize;
        const pieces    = Math.ceil(data.length / chunkSize);
        const id        = this.allocate();
        const partIds   = Array.from({ length: Math.max(pieces - 1, 0) }, () => this.allocate());

        const header: Header = {
            id,
            parentId:   dir.id,
            dataId:     id + 1,
            nextPart:   partIds[0] ?? format.none,
            fatTime,
            attributes: (format.fileAttributes | attributes) >>> 0,
            size:       data.length,
            name,
        };

        for (let i = 0; i < pieces; ++i) {
            const piece = data.subarray(i * chunkSize, (i + 1) * chunkSize);

            if (i === 0) {
                this.records.add(header.dataId, piece);

                continue;
            }

            const part: Part = {
                id:     partIds[i - 1],
                dataId: partIds[i - 1] + 1,
                prev:   i === 1 ? id : partIds[i - 2],
                next:   partIds[i] ?? format.none,
            };

            this.records.add(part.dataId, piece);
            this.records.add(part.id, format.encodePart(part, header));
        }

        this.records.add(id, format.encodeHeader(header));
        this.addEntry(dir, id, name);
    }

    createDirectory(dir: Header, name: Uint8Array, fatTime: number, attributes = 0): void {
        const format = this.prepareWrite();
        const id     = this.allocate();

        const header: Header = {
            id,
            parentId:   dir.id,
            dataId:     id + 1,
            nextPart:   format.none,
            fatTime,
            attributes: (format.directoryAttributes | attributes) >>> 0,
            size:       0,
            name,
        };

        this.records.add(header.dataId, this.emptyDirectoryRecord(format));
        this.records.add(id, format.encodeHeader(header));
        this.addEntry(dir, id, name);
    }

    // Removes the file's or directory's records and its entry, and the broken files of a directory,
    // which must hold nothing else
    delete(child: Child): void {
        this.prepareWrite();

        if (isDirectory(child.header)) {
            for (const header of this.brokenContents(child.header) ?? []) {
                this.removeRecords(header);
            }
        }

        this.removeRecords(child.header);
        this.removeEntry(child.entry);
    }

    // Moves the file or directory into the directory under the name. Only its header changes: the
    // firmware does not keep its parts' copies of their owner's parent id up to date either.
    move(child: Child, dir: Header, name: Uint8Array): void {
        const format = this.prepareWrite();
        const header = { ...child.header, parentId: dir.id, name };

        this.removeEntry(child.entry);
        this.records.remove(header.id);
        this.records.add(header.id, format.encodeHeader(header));
        this.addEntry(dir, header.id, name);
    }

    // Removes the entries that lead to no record from the directory and the ones in it, and tells
    // how many it removed
    removeStaleEntries(dir: Header, visited = new Set<number>()): number {
        let removed = 0;

        this.prepareWrite();

        visited.add(dir.id);

        for (const entry of this.list(dir).entries) {
            const header = this.entryHeader(entry);

            if (!this.records.has(entry.id)) {
                this.removeEntry(entry);

                ++removed;
            } else if (header && isDirectory(header) && !visited.has(header.id)) {
                removed += this.removeStaleEntries(header, visited);
            }
        }

        return removed;
    }

    // Its header, and the records of its data and parts that are its own
    private removeRecords(header: Header): void {
        const chain = this.chain(header);

        for (const id of [header.id, ...chain.data, ...chain.parts]) {
            if (this.records.has(id)) {
                this.records.remove(id);
            }
        }
    }

    private removeEntry(entry: EntryRef): void {
        const format = this.format as WritableFormat;

        this.records.patch(entry.record, entry.offset, format.deletedEntry(this.records.read(entry.record), entry.offset));
    }

    private allocate(): number {
        return this.records.allocatePair((this.format as WritableFormat).firstId);
    }

    private emptyDirectoryRecord(format: WritableFormat): Uint8Array {
        return new Uint8Array(format.directoryRecordSize).fill(0xFF);
    }

    // Into the first free entry, or a new part after the directory's last when it is full
    private addEntry(dir: Header, id: number, name: Uint8Array): void {
        const format    = this.prepareWrite();
        const listing   = this.list(dir);
        const entry     = format.encodeEntry(id, name);

        if (listing.free) {
            this.records.patch(listing.free.record, listing.free.offset, entry);

            return;
        }

        const partId    = this.allocate();
        const part      = { id: partId, dataId: partId + 1, prev: listing.last, next: format.none };
        const record    = this.emptyDirectoryRecord(format);

        record.set(entry, 0);

        this.records.add(part.dataId, record);
        this.records.add(part.id, format.encodePart(part, dir));
        this.records.patch(listing.last, format.nextOffset, format.encodeId(partId));
    }
}

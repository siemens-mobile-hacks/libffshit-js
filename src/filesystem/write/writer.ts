import { BaseError, FilesystemError } from "../../errors.js";
import type { Partitions } from "../../partition/partitions.js";
import type { PlatformType } from "../../platform/types.js";
import { readString, readU16, readU32, slice, toBinaryString } from "../../rawdata.js";
import { sgoldNameFromUtf8 } from "../codepage.js";
import { foldCase8bit, foldCaseUtf16, nameHash8bit, nameHashUtf16 } from "../hash.js";
import { Records } from "./records.js";

// A file's or directory's header
export interface Header {
    id: number;
    parentId: number;
    dataId: number;
    nextPart: number;
    size: number;
    fatTime: number;
    attributes: number;
    // as the header keeps it: UTF-16LE, or 8-bit
    name: Uint8Array;
}

// Where the data goes on: the next piece of a file, or the next record of a directory's entries
export interface Part {
    id: number;
    dataId: number;
    prev: number;
    next: number;
}

interface Entry {
    // the record of directory entries holding it, and where
    record: number;
    offset: number;
    id: number;
}

interface Listing {
    entries: Entry[];
    free: Entry | undefined;
    // the header, or the part, that ends the directory
    lastId: number;
    lastIsPart: boolean;
}

interface Found {
    header: Header;
    entry: Entry;
}

function emptyHeader(): Header {
    return { id: 0, parentId: 0, dataId: 0, nextPart: 0, size: 0, fatTime: 0, attributes: 0, name: new Uint8Array(0) };
}

function isDirectory(header: Header): boolean {
    return (header.attributes & 0x10) !== 0;
}

function u16(value: number): Uint8Array {
    return Uint8Array.of(value & 0xFF, (value >>> 8) & 0xFF);
}

function u32(value: number): Uint8Array {
    return Uint8Array.of(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let   offset = 0;

    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }

    return result;
}

function join(path: readonly string[]): string {
    return path.join("/");
}

// Files and directories on the records of one partition. A file is a header, its data in pieces
// of the partition's chunk size, and a part for every piece after the first. A directory is a
// header and records of entries, each the id of a header and the hash of its name, which grow by
// parts too.
export abstract class Writer {
    protected readonly records: Records;
    protected chunkSize = 0;

    // SGOLD keeps names in the codepage
    static build(platform: PlatformType, partitions: Partitions, partitionName: string, codepage: string): Writer {
        const records = Records.build(platform, partitions, partitionName);

        switch (platform) {
            case "SGOLD":       return new SgoldWriter(records, codepage);
            case "SGOLD2":
            case "SGOLD2_ELKA": return new NewSgoldWriter(records);
            default: {
                throw new FilesystemError("Writing is not supported on this platform");
            }
        }
    }

    protected constructor(records: Records) {
        this.records = records;
    }

    // Checks the partition and reads its chunk size. Called by the formats once they are built.
    protected init(): void {
        if (!this.records.contains(0)) {
            throw new FilesystemError("The filesystem has no configuration record. Not writing to it");
        }

        this.chunkSize = this.readChunkSize(this.records.read(0));

        if (this.chunkSize < 256 || this.chunkSize > 4096 || (this.chunkSize & (this.chunkSize - 1))) {
            throw new FilesystemError(`Unknown chunk size ${this.chunkSize}. Not writing to the filesystem`);
        }

        if (!this.records.contains(this.rootId()) || !isDirectory(this.readHeader(this.rootId()))) {
            throw new FilesystemError(`The filesystem has no root directory with id ${this.rootId()}. A prototype's? Not writing to it`);
        }
    }

    getRecords(): Records {
        return this.records;
    }

    // Whether the firmware takes the names for the same one
    sameName(a: string, b: string): boolean {
        try {
            return this.folded(this.toStored(a)) === this.folded(this.toStored(b));
        } catch (e) {
            if (e instanceof BaseError) {
                return a === b;
            }

            throw e;
        }
    }

    // The paths are below the partition's root directory
    writeFile(path: readonly string[], data: Uint8Array, fatTime: number): void {
        const parent    = this.resolveDirectory(path.slice(0, -1));
        const stored    = this.newName(path[path.length - 1]);
        const existing  = this.find(parent, stored);

        if (existing) {
            if (isDirectory(existing.header)) {
                throw new FilesystemError(`${join(path)} is a directory`);
            }

            this.deleteRecords(existing.header);
            this.deleteEntry(existing.entry);
        }

        const size      = data.length;
        const pieces    = Math.floor((size + this.chunkSize - 1) / this.chunkSize);

        const header    = emptyHeader();

        header.id           = this.allocate();
        header.parentId     = parent.id;
        header.dataId       = header.id + 1;
        header.size         = size;
        header.fatTime      = fatTime;
        header.attributes   = this.fileAttributes();
        header.name         = stored;

        const partIds: number[] = [];

        for (let i = 1; i < pieces; ++i) {
            partIds.push(this.allocate());
        }

        header.nextPart = partIds.length ? partIds[0] : this.none();

        for (let i = 0; i < pieces; ++i) {
            const piece = slice(data, i * this.chunkSize, Math.min(this.chunkSize, size - i * this.chunkSize));

            if (i === 0) {
                this.records.add(header.dataId, piece);

                continue;
            }

            const part: Part = {
                id:     partIds[i - 1],
                dataId: partIds[i - 1] + 1,
                prev:   i === 1 ? header.id : partIds[i - 2],
                next:   i < partIds.length ? partIds[i] : this.none(),
            };

            this.records.add(part.dataId, piece);
            this.records.add(part.id, this.encodePart(part, header));
        }

        this.records.add(header.id, this.encodeHeader(header));

        this.addEntry(parent, header.id, stored);
    }

    createDirectory(path: readonly string[], fatTime: number): void {
        const parent = this.resolveDirectory(path.slice(0, -1));
        const stored = this.newName(path[path.length - 1]);

        if (this.find(parent, stored)) {
            throw new FilesystemError(`${join(path)} exists already`);
        }

        const header = emptyHeader();

        header.id           = this.allocate();
        header.parentId     = parent.id;
        header.dataId       = header.id + 1;
        header.nextPart     = this.none();
        header.fatTime      = fatTime;
        header.attributes   = this.directoryAttributes();
        header.name         = stored;

        this.records.add(header.dataId, this.emptyDirectoryRecord());
        this.records.add(header.id, this.encodeHeader(header));

        this.addEntry(parent, header.id, stored);
    }

    remove(path: readonly string[]): void {
        const parent    = this.resolveDirectory(path.slice(0, -1));
        const found     = this.find(parent, this.toStored(path[path.length - 1]));

        if (!found) {
            throw new FilesystemError(`${join(path)} not found`);
        }

        if (isDirectory(found.header) && this.list(found.header).entries.length) {
            throw new FilesystemError(`Directory ${join(path)} is not empty`);
        }

        this.deleteRecords(found.header);
        this.deleteEntry(found.entry);
    }

    private readHeader(id: number): Header {
        return this.decodeHeader(this.records.read(id));
    }

    private resolveDirectory(path: readonly string[]): Header {
        let directory = this.readHeader(this.rootId());

        for (let i = 0; i < path.length; ++i) {
            const subPath   = join(path.slice(0, i + 1));
            const found     = this.find(directory, this.toStored(path[i]));

            if (!found) {
                throw new FilesystemError(`Directory ${subPath} not found`);
            }

            if (!isDirectory(found.header)) {
                throw new FilesystemError(`${subPath} is not a directory`);
            }

            directory = found.header;
        }

        return directory;
    }

    private list(directory: Header): Listing {
        const listing: Listing  = { entries: [], free: undefined, lastId: directory.id, lastIsPart: false };
        const visited           = new Set<number>();
        let   dataId            = directory.dataId;
        let   next              = directory.nextPart;

        for (;;) {
            if (this.records.contains(dataId)) {
                const record = this.records.read(dataId);

                for (let offset = 0; offset + this.entrySize() <= record.length; offset += this.entrySize()) {
                    const id = this.entryId(record, offset);

                    if (id === this.none()) {
                        listing.free ??= { record: dataId, offset, id };
                    } else if (id !== 0) {
                        listing.entries.push({ record: dataId, offset, id });
                    }
                }
            }

            // A broken chain ends where it breaks
            if (next === this.none() || visited.has(next)) {
                break;
            }

            visited.add(next);

            if (!this.records.contains(next)) {
                break;
            }

            const part = this.decodePart(this.records.read(next));

            listing.lastId      = part.id;
            listing.lastIsPart  = true;

            dataId  = part.dataId;
            next    = part.next;
        }

        return listing;
    }

    private find(directory: Header, stored: Uint8Array): Found | undefined {
        const key = this.folded(stored);

        for (const entry of this.list(directory).entries) {
            let header: Header;

            // An entry that points nowhere, or at no header, names nothing
            try {
                header = this.readHeader(entry.id);
            } catch (e) {
                if (e instanceof BaseError) {
                    continue;
                }

                throw e;
            }

            if (header.id === entry.id && this.folded(header.name) === key) {
                return { header, entry };
            }
        }

        return undefined;
    }

    private newName(name: string): Uint8Array {
        const forbidden = "\\/:*?\"<>|";

        if (name === "" || name === "." || name === "..") {
            throw new FilesystemError(`Invalid name '${name}'`);
        }

        for (const c of name) {
            if (c.charCodeAt(0) < 0x20 || forbidden.includes(c)) {
                throw new FilesystemError(`Invalid name '${name}': no control characters and none of ${forbidden}`);
            }
        }

        const stored = this.toStored(name);

        this.checkNewName(stored);

        return stored;
    }

    private allocate(): number {
        return this.records.allocatePair(this.firstId());
    }

    private emptyDirectoryRecord(): Uint8Array {
        return new Uint8Array(this.directoryRecordSize()).fill(0xFF);
    }

    private addEntry(directory: Header, id: number, stored: Uint8Array): void {
        const listing   = this.list(directory);
        const entry     = this.encodeEntry(id, stored);

        if (listing.free) {
            this.records.patch(listing.free.record, listing.free.offset, entry);

            return;
        }

        // The directory is full: it goes on in a new part after its last
        const partId    = this.allocate();
        const part: Part = {
            id:     partId,
            dataId: partId + 1,
            prev:   listing.lastId,
            next:   this.none(),
        };

        const record = this.emptyDirectoryRecord();

        record.set(entry, 0);

        this.records.add(part.dataId, record);
        this.records.add(part.id, this.encodePart(part, directory));
        this.records.patch(listing.lastId, listing.lastIsPart ? this.partNextOffset() : this.headerNextOffset(), this.encodeId(part.id));
    }

    private deleteEntry(entry: Entry): void {
        this.records.patch(entry.record, entry.offset, this.deletedEntry(this.records.read(entry.record), entry.offset));
    }

    private deleteRecords(header: Header): void {
        const visited   = new Set<number>();
        let   next      = header.nextPart;

        this.records.remove(header.id);

        if (this.records.contains(header.dataId)) {
            this.records.remove(header.dataId);
        }

        while (next !== this.none() && !visited.has(next)) {
            visited.add(next);

            if (!this.records.contains(next)) {
                break;
            }

            const part = this.decodePart(this.records.read(next));

            this.records.remove(next);

            if (this.records.contains(part.dataId)) {
                this.records.remove(part.dataId);
            }

            next = part.next;
        }
    }

    // What differs between the formats
    protected abstract rootId(): number;
    // The first id that is neither the firmware's own record nor the root's
    protected abstract firstId(): number;
    // The id that is none: no next part, a free directory entry
    protected abstract none(): number;
    protected abstract readChunkSize(config: Uint8Array): number;

    protected abstract decodeHeader(data: Uint8Array): Header;
    protected abstract encodeHeader(header: Header): Uint8Array;
    protected abstract decodePart(data: Uint8Array): Part;
    protected abstract encodePart(part: Part, owner: Header): Uint8Array;
    protected abstract headerNextOffset(): number;
    protected abstract partNextOffset(): number;
    protected abstract encodeId(id: number): Uint8Array;

    protected abstract fileAttributes(): number;
    protected abstract directoryAttributes(): number;

    protected abstract directoryRecordSize(): number;
    protected abstract entrySize(): number;
    // none() for a free entry, 0 for a deleted one
    protected abstract entryId(record: Uint8Array, offset: number): number;
    protected abstract encodeEntry(id: number, name: Uint8Array): Uint8Array;
    protected abstract deletedEntry(record: Uint8Array, offset: number): Uint8Array;

    // A name as a header keeps it
    protected abstract toStored(name: string): Uint8Array;
    // Throws when the firmware could not take the name
    protected abstract checkNewName(stored: Uint8Array): void;
    // The same for two names the firmware takes for the same one
    protected abstract folded(stored: Uint8Array): string;
}

// =========================================================================

const NEW_SGOLD_HEADER_SIZE     = 28;
// Keeps a header inline in an ELKA FIT, where it can be changed in place
const NEW_SGOLD_NAME_LENGTH_MAX = (0x200 - NEW_SGOLD_HEADER_SIZE) / 2;

function utf16Units(stored: Uint8Array): number[] {
    const units: number[] = [];

    for (let i = 0; i + 1 < stored.length; i += 2) {
        units.push(stored[i] | (stored[i + 1] << 8));
    }

    return units;
}

// SGOLD2 and SGOLD2_ELKA: 32-bit ids, UTF-16 names, a file's data under the id after its header's
//
// Header: id, 0xFFFFFFFF, next part, parent id, size, FAT time (32 bits each), attributes, the
//         name's length (16 bits each), the name
// Part:   id, previous part or header, next part (32 bits each)
// Directory entry: id, 0xFFFF0000 | name hash (32 bits each), in records of 256 bytes
class NewSgoldWriter extends Writer {
    constructor(records: Records) {
        super(records);

        this.init();
    }

    protected rootId(): number {
        return 10;
    }

    protected firstId(): number {
        return 12;
    }

    protected none(): number {
        return 0xFFFFFFFF;
    }

    protected readChunkSize(config: Uint8Array): number {
        return readU32(config, 4);
    }

    protected decodeHeader(data: Uint8Array): Header {
        if (data.length < NEW_SGOLD_HEADER_SIZE) {
            throw new FilesystemError(`A header of ${data.length} bytes`);
        }

        const header = emptyHeader();

        header.id           = readU32(data, 0);
        header.nextPart     = readU32(data, 8);
        header.parentId     = readU32(data, 12);
        header.size         = readU32(data, 16);
        header.fatTime      = readU32(data, 20);
        header.attributes   = readU16(data, 24);
        header.dataId       = (header.id + 1) >>> 0;

        const nameSize = Math.min(readU16(data, 26) * 2, data.length - NEW_SGOLD_HEADER_SIZE);

        header.name = new Uint8Array(data.subarray(NEW_SGOLD_HEADER_SIZE, NEW_SGOLD_HEADER_SIZE + nameSize));

        return header;
    }

    protected encodeHeader(header: Header): Uint8Array {
        return concat(
            u32(header.id),
            u32(0xFFFFFFFF),
            u32(header.nextPart),
            u32(header.parentId),
            u32(header.size),
            u32(header.fatTime),
            u16(header.attributes),
            u16(header.name.length >>> 1),
            header.name,
        );
    }

    protected decodePart(data: Uint8Array): Part {
        const id = readU32(data, 0);

        return {
            id,
            prev:   readU32(data, 4),
            next:   readU32(data, 8),
            dataId: (id + 1) >>> 0,
        };
    }

    protected encodePart(part: Part): Uint8Array {
        return concat(u32(part.id), u32(part.prev), u32(part.next));
    }

    protected headerNextOffset(): number {
        return 8;
    }

    protected partNextOffset(): number {
        return 8;
    }

    protected encodeId(id: number): Uint8Array {
        return u32(id);
    }

    protected fileAttributes(): number {
        return 0x0000;
    }

    protected directoryAttributes(): number {
        return 0x0010;
    }

    protected directoryRecordSize(): number {
        return 256;
    }

    protected entrySize(): number {
        return 8;
    }

    protected entryId(record: Uint8Array, offset: number): number {
        return readU32(record, offset);
    }

    protected encodeEntry(id: number, name: Uint8Array): Uint8Array {
        return concat(u32(id), u32((0xFFFF0000 | nameHashUtf16(utf16Units(name))) >>> 0));
    }

    protected deletedEntry(record: Uint8Array, offset: number): Uint8Array {
        return concat(u32(0), u32((readU32(record, offset + 4) & 0xFFFF0000) >>> 0));
    }

    protected toStored(name: string): Uint8Array {
        const stored = new Uint8Array(name.length * 2);

        for (let i = 0; i < name.length; ++i) {
            const unit = name.charCodeAt(i);

            if (unit >= 0xD800 && unit <= 0xDFFF) {
                const pair = unit <= 0xDBFF ? name.charCodeAt(i + 1) : unit;

                if (unit > 0xDBFF || !(pair >= 0xDC00 && pair <= 0xDFFF)) {
                    throw new FilesystemError(`'${name}' is not UTF-8`);
                }

                stored[i * 2]       = unit & 0xFF;
                stored[i * 2 + 1]   = unit >>> 8;

                ++i;

                stored[i * 2]       = pair & 0xFF;
                stored[i * 2 + 1]   = pair >>> 8;

                continue;
            }

            stored[i * 2]       = unit & 0xFF;
            stored[i * 2 + 1]   = unit >>> 8;
        }

        return stored;
    }

    protected checkNewName(stored: Uint8Array): void {
        if ((stored.length >>> 1) > NEW_SGOLD_NAME_LENGTH_MAX) {
            throw new FilesystemError(`Names are up to ${NEW_SGOLD_NAME_LENGTH_MAX} UTF-16 characters long`);
        }
    }

    protected folded(stored: Uint8Array): string {
        return utf16Units(stored).map((unit) => String.fromCharCode(foldCaseUtf16(unit))).join("");
    }
}

// =========================================================================

const SGOLD_HEADER_SIZE     = 16;
const SGOLD_NAME_SIZE_MAX   = 255;

// SGOLD: 16-bit ids, 8-bit names in the phone's codepage, or 0x1F and UTF-8
//
// Header: id, parent id (16 bits), FAT time (32), data id (16), attributes with the upper 16 bits
//         set (32), next part (16), the name ending in a 0
// Part:   id, the owner's parent id (16), the owner's FAT time (32), data id, the owner's
//         attributes, previous part or header, next part (16 each)
// Directory entry: id, name hash (16 bits each), in records of 128 bytes
class SgoldWriter extends Writer {
    private readonly codepage: string;

    constructor(records: Records, codepage: string) {
        super(records);

        this.codepage = codepage;

        this.init();
    }

    protected rootId(): number {
        return 6;
    }

    protected firstId(): number {
        return 10;
    }

    protected none(): number {
        return 0xFFFF;
    }

    protected readChunkSize(config: Uint8Array): number {
        return readU16(config, 2);
    }

    protected decodeHeader(data: Uint8Array): Header {
        if (data.length < SGOLD_HEADER_SIZE) {
            throw new FilesystemError(`A header of ${data.length} bytes`);
        }

        return {
            id:         readU16(data, 0),
            parentId:   readU16(data, 2),
            fatTime:    readU32(data, 4),
            dataId:     readU16(data, 8),
            attributes: readU32(data, 10),
            nextPart:   readU16(data, 14),
            size:       0,
            name:       readString(data, SGOLD_HEADER_SIZE),
        };
    }

    protected encodeHeader(header: Header): Uint8Array {
        return concat(
            u16(header.id),
            u16(header.parentId),
            u32(header.fatTime),
            u16(header.dataId),
            u32(header.attributes),
            u16(header.nextPart),
            header.name,
            Uint8Array.of(0),
        );
    }

    protected decodePart(data: Uint8Array): Part {
        return {
            id:     readU16(data, 0),
            dataId: readU16(data, 8),
            prev:   readU16(data, 12),
            next:   readU16(data, 14),
        };
    }

    protected encodePart(part: Part, owner: Header): Uint8Array {
        return concat(
            u16(part.id),
            u16(owner.parentId),
            u32(owner.fatTime),
            u16(part.dataId),
            u16(owner.attributes & 0xFFFF),
            u16(part.prev),
            u16(part.next),
        );
    }

    protected headerNextOffset(): number {
        return 14;
    }

    protected partNextOffset(): number {
        return 14;
    }

    protected encodeId(id: number): Uint8Array {
        return u16(id);
    }

    protected fileAttributes(): number {
        return 0xFFFF0000;
    }

    protected directoryAttributes(): number {
        return 0xFFFF0010;
    }

    protected directoryRecordSize(): number {
        return 128;
    }

    protected entrySize(): number {
        return 4;
    }

    protected entryId(record: Uint8Array, offset: number): number {
        return readU16(record, offset);
    }

    protected encodeEntry(id: number, name: Uint8Array): Uint8Array {
        return concat(u16(id), u16(nameHash8bit(name)));
    }

    protected deletedEntry(): Uint8Array {
        return new Uint8Array(4);
    }

    protected toStored(name: string): Uint8Array {
        return sgoldNameFromUtf8(name, this.codepage);
    }

    protected checkNewName(stored: Uint8Array): void {
        if (stored.length > SGOLD_NAME_SIZE_MAX) {
            throw new FilesystemError(`Names are up to ${SGOLD_NAME_SIZE_MAX} bytes long`);
        }
    }

    // The firmware folds ASCII letters only: "Ärger" and "ärger" are two names to it
    protected folded(stored: Uint8Array): string {
        return toBinaryString(stored.map(foldCase8bit));
    }
}

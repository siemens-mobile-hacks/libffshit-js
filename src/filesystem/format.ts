import { FFSError } from "../errors.js";
import type { Records } from "./records.js";
import type { SpaceConstants } from "./space.js";

export const Attributes = {
    READONLY:   0x01,
    HIDDEN:     0x02,
    SYSTEM:     0x04,
    DIRECTORY:  0x10,
} as const;

// A file's or directory's header. The ids are the records': of the header, of its first data
// record, of its first part.
export interface Header {
    id: number;
    parentId: number;
    dataId: number;
    nextPart: number;
    fatTime: number;
    attributes: number;
    // The size NewSGOLD headers keep
    size: number;
    // As the header keeps it
    name: Uint8Array;
}

// Where the data goes on: the next piece of a file, or the next record of a directory's entries
export interface Part {
    id: number;
    dataId: number;
    prev: number;
    next: number;
}

export function isDirectory(header: Header): boolean {
    return (header.attributes & Attributes.DIRECTORY) !== 0;
}

// The records of a filesystem: headers, parts, and directories, whose data are entries, each the id
// of a header and the hash of its name
export abstract class Format {
    abstract readonly rootId: number;
    // The id that is none: no next part, a free directory entry
    abstract readonly none: number;
    abstract readonly entrySize: number;
    // Whether the timestamps are in UTC, or in the phone's local time
    abstract readonly utc: boolean;

    constructor(protected readonly records: Records) {
    }

    // Undefined when there is no such record. Throws when it is too short.
    abstract header(id: number): Header | undefined;
    abstract part(id: number): Part | undefined;

    // `none` for a free entry, 0 for a deleted one
    abstract entryId(record: Uint8Array, offset: number): number;

    abstract name(header: Header): string;
    // The same for two names the firmware takes for the same one
    abstract fold(name: string): string;

    protected record(id: number, minSize: number, what: string): Uint8Array | undefined {
        if (!this.records.has(id)) {
            return undefined;
        }

        const data = this.records.read(id);

        if (data.length < minSize) {
            throw new FFSError(`record ${id} of ${data.length} bytes is too short for a ${what}`);
        }

        return data;
    }
}

// A format the library writes, whose first record keeps the size of the pieces files are cut in
export abstract class WritableFormat extends Format {
    // The first id that is neither the firmware's own record nor the root's
    abstract readonly firstId: number;
    // The record that keeps the size of the pieces
    abstract readonly configId: number;
    // Where headers and parts keep the next part
    abstract readonly nextOffset: number;
    abstract readonly directoryRecordSize: number;
    abstract readonly fileAttributes: number;
    abstract readonly directoryAttributes: number;
    // How the firmware reckons capacity and free space, where that is known
    abstract readonly space: SpaceConstants | undefined;

    abstract chunkSize(config: Uint8Array): number;
    // The name as a header keeps it. Throws when the firmware could not take it.
    abstract encodeName(name: string): Uint8Array;
    abstract encodeHeader(header: Header): Uint8Array;
    abstract encodePart(part: Part, owner: Header): Uint8Array;
    abstract encodeId(id: number): Uint8Array;
    abstract encodeEntry(id: number, name: Uint8Array): Uint8Array;
    abstract deletedEntry(record: Uint8Array, offset: number): Uint8Array;
}

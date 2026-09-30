// The records of an EGOLD filesystem: SGOLD's, every record under its id plus 6000, the headers and
// parts of the size the configuration record gives, and the names hashed as 7-bit characters.
// The configuration record: its version, the size of the pieces, the entries of a directory record,
// the size of directory records, the size of headers, the size of the record after it, ? (16 bits
// each). Version 1, the S46's, has no size of directory records, and its directory entries are the
// ids alone, without the names' hashes.

import { u16 } from "../bytes.js";
import { nameHash7bit } from "./hash.js";
import { EGOLD_ID_OFFSET, type Records } from "./records.js";
import { SgoldFormat } from "./sgold.js";

const VERSION_1 = 0x100;

// Headers of 16 bytes, or 20 with 4 of 0xFF before the name, and directory records of 128 bytes,
// unless the configuration record tells other sizes that make sense
function configuration(records: Records): { version1: boolean, headerSize: number, directoryRecordSize: number } {
    const config    = records.has(EGOLD_ID_OFFSET) ? records.read(EGOLD_ID_OFFSET) : new Uint8Array(0);
    const field     = (offset: number) => config.length >= offset + 2 ? u16(config, offset) : 0;
    const version1  = field(0) === VERSION_1;
    const header    = field(version1 ? 6 : 8);
    const directory = version1 ? 0 : field(6);

    return {
        version1,
        headerSize:             header >= 16 && header <= 32 ? header : 16,
        directoryRecordSize:    directory >= 16 && directory <= 1024 && directory % 4 === 0 ? directory : 128,
    };
}

export class EgoldFormat extends SgoldFormat {
    override readonly entrySize: number;
    override readonly directoryRecordSize: number;
    // Its directory entries are 2 bytes, which the library does not write
    readonly version1: boolean;
    // Its firmware runs on the C166, which no emulator runs, so it is counted in bytes of the flash
    override readonly space = undefined;
    // Longer than any of the phones' own is not known to work
    protected override readonly nameSizeMax = 62;

    constructor(records: Records) {
        const { version1, headerSize, directoryRecordSize } = configuration(records);

        super(records, EGOLD_ID_OFFSET, headerSize);

        this.version1               = version1;
        this.entrySize              = version1 ? 2 : 4;
        this.directoryRecordSize    = directoryRecordSize;
    }

    protected override nameHash(name: Uint8Array): number {
        return nameHash7bit(name);
    }
}

// The records of an EGOLD filesystem: SGOLD's, every record under its id plus 6000, the headers and
// parts of the size the configuration record gives, and the names hashed as 7-bit characters.
// The configuration record: its version, the size of the pieces, the entries of a directory record,
// the size of directory records, the size of headers, the size of the record after it, ? (16 bits
// each). Version 1, the S46's, has no size of directory records, and its directory entries are the
// ids alone, without the names' hashes.

import { u16 } from "../bytes.js";
import { nameHash7bit } from "./hash.js";
import type { Records } from "./records.js";
import { SgoldFormat } from "./sgold.js";

export const EGOLD_ID_OFFSET = 6000;

const VERSION_1 = 0x100;

// Headers of 16 bytes, or 20 with 4 of 0xFF before the name, and entries of 4 bytes, or 2
function sizes(records: Records): { headerSize: number, entrySize: number } {
    const config    = records.has(EGOLD_ID_OFFSET) ? records.read(EGOLD_ID_OFFSET) : undefined;
    const version1  = config !== undefined && config.length >= 2 && u16(config, 0) === VERSION_1;
    const at        = version1 ? 6 : 8;
    const size      = config && config.length >= at + 2 ? u16(config, at) : 16;

    return { headerSize: size >= 16 && size <= 32 ? size : 16, entrySize: version1 ? 2 : 4 };
}

export class EgoldFormat extends SgoldFormat {
    override readonly entrySize: number;
    // Its firmware runs on the C166, which no emulator runs, so it is counted in bytes of the flash
    override readonly space = undefined;
    // Longer than any of the phones' own is not known to work
    protected override readonly nameSizeMax = 62;

    constructor(records: Records) {
        const { headerSize, entrySize } = sizes(records);

        super(records, EGOLD_ID_OFFSET, headerSize);

        this.entrySize = entrySize;
    }

    protected override nameHash(name: Uint8Array): number {
        return nameHash7bit(name);
    }
}

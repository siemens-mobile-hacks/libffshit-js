// The records of an EGOLD filesystem: SGOLD's, every record under its id plus 6000, the headers and
// parts of the size the configuration record gives, and the names hashed as 7-bit characters.
// The configuration record: ?, the size of the pieces, ?, the size of directory records, the size
// of headers, the size of the record after it, ? (16 bits each)

import { u16 } from "../bytes.js";
import { nameHash7bit } from "./hash.js";
import type { Records } from "./records.js";
import { SgoldFormat } from "./sgold.js";

export const EGOLD_ID_OFFSET = 6000;

// 16 bytes, or 20 with 4 of 0xFF before the name
function headerSize(records: Records): number {
    const config    = records.has(EGOLD_ID_OFFSET) ? records.read(EGOLD_ID_OFFSET) : undefined;
    const size      = config && config.length >= 10 ? u16(config, 8) : 16;

    return size >= 16 && size <= 32 ? size : 16;
}

export class EgoldFormat extends SgoldFormat {
    // Longer than any of the phones' own is not known to work
    protected override readonly nameSizeMax = 62;

    constructor(records: Records) {
        super(records, EGOLD_ID_OFFSET, headerSize(records));
    }

    protected override nameHash(name: Uint8Array): number {
        return nameHash7bit(name);
    }
}

// The records of an EGOLD filesystem, which is only read. Its FIT keeps records under 16-bit ids, the
// even ones files' headers, which are known by an id of their own:
//
// Header: id, parent id (16 bits), FAT time (32), data id, attributes, ?, next part (16 each),
//         0xFFFFFFFF on newer phones, the name ending in a 0
// Directory entry: id, name hash (16 bits each)
//
// A file's data is the record under its data id plus 6000. A part is a header too, of which the
// data is the record after its own.

import { cString, u16, u32 } from "../bytes.js";
import { decodeName } from "./codepage.js";
import { Format, type Header, type Part } from "./format.js";
import type { Records } from "./records.js";
import { foldAscii } from "./sgold.js";

const HEADER_SIZE   = 16;
const DATA_ID_ADD   = 6000;
const NONE          = 0xFFFF;

interface File {
    record: number;
    header: Header;
}

export class EgoldFormat extends Format {
    readonly rootId     = 6;
    readonly none       = NONE;
    readonly entrySize  = 4;

    private readonly files = new Map<number, File>();

    constructor(records: Records, private readonly codepage: string, report: (problem: string) => void) {
        super(records);

        for (const record of records.ids()) {
            const data = records.read(record);

            if (record & 1 || data.length < HEADER_SIZE) {
                continue;
            }

            const header = decodeHeader(data);

            if (this.files.has(header.id)) {
                report(`${records.partition}: two files with id ${header.id}`);

                continue;
            }

            this.files.set(header.id, { record, header });
        }
    }

    header(id: number): Header | undefined {
        return this.files.get(id)?.header;
    }

    part(id: number): Part | undefined {
        const file = this.files.get(id);

        return file && { id, dataId: file.record + 1, prev: file.header.parentId, next: file.header.nextPart };
    }

    entryId(record: Uint8Array, offset: number): number {
        return u16(record, offset);
    }

    name(header: Header): string {
        return decodeName(header.name, this.codepage);
    }

    fold(name: string): string {
        return foldAscii(name);
    }
}

function decodeHeader(data: Uint8Array): Header {
    const nameOffset = data.length > 20 && u32(data, 16) === 0xFFFFFFFF ? 20 : 16;

    return {
        id:         u16(data, 0),
        parentId:   u16(data, 2),
        fatTime:    u32(data, 4),
        dataId:     u16(data, 8) + DATA_ID_ADD,
        attributes: u16(data, 10),
        nextPart:   u16(data, 14),
        size:       0,
        name:       cString(data, nameOffset).slice(),
    };
}

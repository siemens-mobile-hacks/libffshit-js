// The records of an SGOLD filesystem: 16-bit ids, names in the phone's codepage, or 0x1F and UTF-8
//
// Header: id, parent id (16 bits), FAT time (32), data id (16), attributes with the upper 16 bits
//         set (32), next part (16), the name ending in a 0
// Part:   id, the owner's parent id (16), the owner's FAT time (32), data id, the owner's
//         attributes, previous part or header, next part (16 each)
// Directory entry: id, name hash (16 bits each), in records of 128 bytes
//
// Prototypes keep every record under its id plus 6000.

import { concat, cString, le16, le32, u16, u32 } from "../bytes.js";
import { FFSError } from "../errors.js";
import { decodeName, encodeName } from "./codepage.js";
import { WritableFormat, type Header, type Part } from "./format.js";
import { foldCase8bit, nameHash8bit } from "./hash.js";
import type { Records } from "./records.js";

const HEADER_SIZE   = 16;
const NAME_SIZE_MAX = 255;
const NONE          = 0xFFFF;

export const PROTOTYPE_ID_OFFSET = 6000;

// The name folded as the firmware folds it, its ASCII letters only: "Ärger" and "ärger" differ
export function foldAscii(name: string): string {
    return name.replace(/[a-z]/g, (c) => String.fromCharCode(foldCase8bit(c.charCodeAt(0))));
}

export class SgoldFormat extends WritableFormat {
    readonly rootId: number;
    readonly none                   = NONE;
    readonly entrySize              = 4;
    readonly firstId                = 10;
    readonly nextOffset             = 14;
    readonly directoryRecordSize    = 128;
    readonly fileAttributes         = 0xFFFF0000;
    readonly directoryAttributes    = 0xFFFF0010;

    constructor(records: Records, private readonly codepage: string, readonly idOffset: number) {
        super(records);

        this.rootId = 6 + idOffset;
    }

    private id(stored: number): number {
        return stored === NONE ? NONE : stored + this.idOffset;
    }

    header(id: number): Header | undefined {
        const data = this.record(id, HEADER_SIZE, "header");

        return data && {
            id:         this.id(u16(data, 0)),
            parentId:   this.id(u16(data, 2)),
            fatTime:    u32(data, 4),
            dataId:     this.id(u16(data, 8)),
            attributes: u32(data, 10),
            nextPart:   this.id(u16(data, 14)),
            size:       0,
            name:       cString(data, HEADER_SIZE).slice(),
        };
    }

    part(id: number): Part | undefined {
        const data = this.record(id, 16, "part");

        return data && {
            id:     this.id(u16(data, 0)),
            dataId: this.id(u16(data, 8)),
            prev:   this.id(u16(data, 12)),
            next:   this.id(u16(data, 14)),
        };
    }

    entryId(record: Uint8Array, offset: number): number {
        const id = u16(record, offset);

        return id === 0 ? 0 : this.id(id);
    }

    name(header: Header): string {
        return decodeName(header.name, this.codepage);
    }

    fold(name: string): string {
        return foldAscii(name);
    }

    chunkSize(config: Uint8Array): number {
        return u16(config, 2);
    }

    encodeName(name: string): Uint8Array {
        const stored = encodeName(name, this.codepage);

        if (stored.length > NAME_SIZE_MAX) {
            throw new FFSError(`Names are up to ${NAME_SIZE_MAX} bytes long`);
        }

        return stored;
    }

    encodeHeader(header: Header): Uint8Array {
        return concat([
            le16(header.id),
            le16(header.parentId),
            le32(header.fatTime),
            le16(header.dataId),
            le32(header.attributes),
            le16(header.nextPart),
            header.name,
            Uint8Array.of(0),
        ]);
    }

    encodePart(part: Part, owner: Header): Uint8Array {
        return concat([
            le16(part.id),
            le16(owner.parentId),
            le32(owner.fatTime),
            le16(part.dataId),
            le16(owner.attributes & 0xFFFF),
            le16(part.prev),
            le16(part.next),
        ]);
    }

    encodeId(id: number): Uint8Array {
        return le16(id);
    }

    encodeEntry(id: number, name: Uint8Array): Uint8Array {
        return concat([le16(id), le16(nameHash8bit(name))]);
    }

    deletedEntry(): Uint8Array {
        return new Uint8Array(4);
    }
}

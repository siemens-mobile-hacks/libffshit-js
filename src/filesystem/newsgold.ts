// The records of SGOLD2 and SGOLD2_ELKA filesystems: 32-bit ids, UTF-16 names, a file's data under
// the id after its header's
//
// Header: id, 0xFFFFFFFF, next part, parent id, size, FAT time (32 bits each), attributes, the
//         name's length (16 bits each), the name
// Part:   id, previous part or header, next part (32 bits each)
// Directory entry: id, 0xFFFF0000 | name hash (32 bits each), in records of 256 bytes. An entry
//                  whose upper half of the hash is not 0xFFFF is taken for deleted.

import { concat, le16, le32, u16, u32 } from "../bytes.js";
import { FFSError } from "../errors.js";
import { WritableFormat, type Header, type Part } from "./format.js";
import { foldCaseUtf16, nameHashUtf16 } from "./hash.js";
import { NEW_SGOLD_SPACE } from "./space.js";

const HEADER_SIZE       = 28;
// Keeps a header inline in an ELKA FIT, where it can be changed in place
const NAME_LENGTH_MAX   = (0x200 - HEADER_SIZE) / 2;
const NONE              = 0xFFFFFFFF;

// A name may start with U+FEFF, which is no byte order mark in it
const utf16Decoder = new TextDecoder("utf-16le", { ignoreBOM: true });

export class NewSgoldFormat extends WritableFormat {
    readonly rootId                 = 10;
    readonly none                   = NONE;
    readonly entrySize              = 8;
    readonly utc                    = true;
    readonly firstId                = 12;
    readonly configId               = 0;
    readonly nextOffset             = 8;
    readonly directoryRecordSize    = 256;
    readonly fileAttributes         = 0x0000;
    readonly directoryAttributes    = 0x0010;
    readonly space                  = NEW_SGOLD_SPACE;

    header(id: number): Header | undefined {
        const data = this.record(id, HEADER_SIZE, "header");

        return data && {
            id:         u32(data, 0),
            nextPart:   u32(data, 8),
            parentId:   u32(data, 12),
            size:       u32(data, 16),
            fatTime:    u32(data, 20),
            attributes: u16(data, 24),
            dataId:     (u32(data, 0) + 1) >>> 0,
            // All of its length, 0s too: the firmware hashes them, and keeps "inbox.lst" and
            // "inbox.lst\0" apart
            name:       data.slice(HEADER_SIZE, HEADER_SIZE + u16(data, 26) * 2),
        };
    }

    part(id: number): Part | undefined {
        const data = this.record(id, 12, "part");

        return data && {
            id:     u32(data, 0),
            prev:   u32(data, 4),
            next:   u32(data, 8),
            dataId: (u32(data, 0) + 1) >>> 0,
        };
    }

    entryId(record: Uint8Array, offset: number): number {
        const id = u32(record, offset);

        return id === NONE || u16(record, offset + 6) === 0xFFFF ? id : 0;
    }

    name(header: Header): string {
        return utf16Decoder.decode(header.name);
    }

    fold(name: string): string {
        return String.fromCharCode(...Array.from({ length: name.length }, (_, i) => foldCaseUtf16(name.charCodeAt(i))));
    }

    chunkSize(config: Uint8Array): number {
        return u32(config, 4);
    }

    encodeName(name: string): Uint8Array {
        if (!name.isWellFormed()) {
            throw new FFSError(`'${name}' is not valid Unicode`);
        }

        if (name.length > NAME_LENGTH_MAX) {
            throw new FFSError(`Names are up to ${NAME_LENGTH_MAX} UTF-16 characters long`);
        }

        const stored = new Uint8Array(name.length * 2);

        for (let i = 0; i < name.length; ++i) {
            stored[i * 2]       = name.charCodeAt(i) & 0xFF;
            stored[i * 2 + 1]   = name.charCodeAt(i) >>> 8;
        }

        return stored;
    }

    encodeHeader(header: Header): Uint8Array {
        return concat([
            le32(header.id),
            le32(0xFFFFFFFF),
            le32(header.nextPart),
            le32(header.parentId),
            le32(header.size),
            le32(header.fatTime),
            le16(header.attributes),
            le16(header.name.length >>> 1),
            header.name,
        ]);
    }

    encodePart(part: Part): Uint8Array {
        return concat([le32(part.id), le32(part.prev), le32(part.next)]);
    }

    encodeId(id: number): Uint8Array {
        return le32(id);
    }

    encodeEntry(id: number, name: Uint8Array): Uint8Array {
        return concat([le32(id), le32((0xFFFF0000 | nameHashUtf16(utf16Decoder.decode(name))) >>> 0)]);
    }

    deletedEntry(record: Uint8Array, offset: number): Uint8Array {
        return concat([le32(0), le32((u32(record, offset + 4) & 0xFFFF0000) >>> 0)]);
    }
}

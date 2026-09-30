// SGOLD and EGOLD phones keep a name in CP1252 when it has all of its characters, whatever their
// language, and else as 0x1F followed by the name in UTF-8. A name without the 0x1F they read in
// CP1252, even one in UTF-8.

import { FFSError } from "../errors.js";

const UTF8_PREFIX = 0x1F;

// The characters of the bytes 0x80 to 0x9F, where Latin-1 has control characters. The firmware
// reads the five CP1252 has none for as spaces.
const CP1252_80_9F = [
    0x20AC, 0x0020, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x0020, 0x017D, 0x0020,
    0x0020, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x0020, 0x017E, 0x0178,
];

// The bytes of the characters CP1252 has there
const CP1252_BYTES = new Map(CP1252_80_9F.flatMap((c, i) => c === 0x20 ? [] : [[c, 0x80 + i]]));

const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const utf8Encoder = new TextEncoder();

// Undefined when CP1252 has no such character
function cp1252Byte(c: number): number | undefined {
    return c < 0x80 || (c >= 0xA0 && c <= 0xFF) ? c : CP1252_BYTES.get(c);
}

// The name as a header keeps it
export function encodeName(name: string): Uint8Array {
    if (!name.isWellFormed()) {
        throw new FFSError(`'${name}' is not valid Unicode`);
    }

    const bytes: number[] = [];

    for (let i = 0; i < name.length; ++i) {
        const byte = cp1252Byte(name.charCodeAt(i));

        if (byte === undefined) {
            return Uint8Array.from([UTF8_PREFIX, ...utf8Encoder.encode(name)]);
        }

        bytes.push(byte);
    }

    return Uint8Array.from(bytes);
}

export function decodeName(stored: Uint8Array): string {
    if (stored.length >= 2 && stored[0] === UTF8_PREFIX) {
        return utf8Decoder.decode(stored.subarray(1));
    }

    let name = "";

    for (const byte of stored) {
        name += String.fromCharCode(byte >= 0x80 && byte < 0xA0 ? CP1252_80_9F[byte - 0x80] : byte);
    }

    return name;
}

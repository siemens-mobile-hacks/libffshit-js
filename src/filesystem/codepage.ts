// SGOLD keeps a name in the 8-bit codepage of the phone's language when the codepage has all of
// its characters, and else as 0x1F followed by the name in UTF-8.
//
// The codepages are glibc's, which the C++ library converts with through iconv: the single-byte
// ones in codepages.ts, and UTF-8. iconv knows more, which are unknown here.

import { FilesystemError } from "../errors.js";
import { decodeUtf8, toBinaryString } from "../rawdata.js";
import { CODEPAGE_ALIASES, CODEPAGE_TABLES } from "./codepages.js";

const UTF8_NAME_PREFIX = 0x1F;
const UTF8 = "UTF-8";

interface Codepage {
    decode: readonly number[];
    encode: Map<number, number>;
}

const codepages = new Map<string, Codepage>();

function canonicalName(codepage: string): string | undefined {
    const name = codepage.toUpperCase();

    if (name === UTF8 || name === "UTF8") {
        return UTF8;
    }

    if (name in CODEPAGE_TABLES) {
        return name;
    }

    return CODEPAGE_ALIASES[name];
}

function getCodepage(name: string): Codepage {
    let codepage = codepages.get(name);

    if (!codepage) {
        const decode = CODEPAGE_TABLES[name];
        const encode = new Map<number, number>();

        decode.forEach((codePoint, byte) => {
            if (codePoint >= 0) {
                encode.set(codePoint, byte);
            }
        });

        codepage = { decode, encode };
        codepages.set(name, codepage);
    }

    return codepage;
}

function isAscii(name: string): boolean {
    return /^[\x00-\x7F]*$/.test(name);
}

// Whether the string is valid UTF-16, which is what it takes to be valid UTF-8
function isWellFormed(name: string): boolean {
    return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name);
}

// The name of the codepage the library knows it by. Throws when the codepage is unknown.
export function checkCodepage(codepage: string): string {
    const name = canonicalName(codepage);

    if (name === undefined) {
        throw new FilesystemError(`Unknown codepage ${codepage}`);
    }

    return name;
}

// The name in the codepage, or undefined when the codepage lacks one of its characters
function encode(name: string, codepage: string): Uint8Array | undefined {
    if (codepage === UTF8) {
        return new TextEncoder().encode(name);
    }

    const table = getCodepage(codepage).encode;
    const bytes: number[] = [];

    for (const c of name) {
        const byte = table.get(c.codePointAt(0)!);

        if (byte === undefined) {
            return undefined;
        }

        bytes.push(byte);
    }

    return Uint8Array.from(bytes);
}

// The name from the codepage, or undefined when a byte is not one of its characters
function decode(stored: Uint8Array, codepage: string): string | undefined {
    if (codepage === UTF8) {
        try {
            return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stored);
        } catch {
            return undefined;
        }
    }

    const table = getCodepage(codepage).decode;
    let   name  = "";

    for (const byte of stored) {
        if (table[byte] < 0) {
            return undefined;
        }

        name += String.fromCodePoint(table[byte]);
    }

    return name;
}

// The name as an SGOLD header keeps it. Throws when the name is not valid Unicode.
export function sgoldNameFromUtf8(name: string, codepage: string): Uint8Array {
    if (isAscii(name)) {
        return Uint8Array.from(name, (c) => c.charCodeAt(0));
    }

    if (!isWellFormed(name)) {
        throw new FilesystemError(`'${name}' is not UTF-8`);
    }

    const stored = encode(name, codepage);

    if (stored) {
        return stored;
    }

    const utf8   = new TextEncoder().encode(name);
    const result = new Uint8Array(utf8.length + 1);

    result[0] = UTF8_NAME_PREFIX;
    result.set(utf8, 1);

    return result;
}

// The name as a string. A name the codepage cannot decode is taken for UTF-8, as the C++ library
// leaves it as it is.
export function sgoldNameToUtf8(stored: Uint8Array, codepage: string): string {
    if (stored.length >= 2 && stored[0] === UTF8_NAME_PREFIX) {
        return decodeUtf8(stored.subarray(1));
    }

    if (stored.every((byte) => byte < 0x80)) {
        return toBinaryString(stored);
    }

    return decode(stored, codepage) ?? decodeUtf8(stored);
}

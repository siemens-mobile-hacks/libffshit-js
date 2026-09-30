// SGOLD and EGOLD keep a name in the 8-bit codepage of the phone's language when the codepage has
// all of its characters, and else as 0x1F followed by the name in UTF-8.
//
// The codepages are glibc's single-byte ones, and UTF-8.

import { latin1 } from "../bytes.js";
import { FFSError } from "../errors.js";
import { CODEPAGE_ALIASES, CODEPAGE_TABLES } from "./codepages.js";

const UTF8_PREFIX = 0x1F;
const UTF8 = "UTF-8";

interface Codepage {
    // Of the bytes from 0x80 on
    decode: readonly number[];
    encode: Map<number, number>;
}

const codepages = new Map<string, Codepage>();
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const utf8Encoder = new TextEncoder();

function table(name: string): Codepage {
    let codepage = codepages.get(name);

    if (!codepage) {
        const decode = CODEPAGE_TABLES[name];
        const encode = new Map<number, number>();

        decode.forEach((codePoint, i) => {
            if (codePoint >= 0) {
                encode.set(codePoint, 0x80 + i);
            }
        });

        codepage = { decode, encode };
        codepages.set(name, codepage);
    }

    return codepage;
}

function isAscii(bytes: Uint8Array): boolean {
    return bytes.every((byte) => byte < 0x80);
}

// The canonical name of a codepage, which may be given by any name iconv knows it by, e.g. "cp1251",
// "windows-1251", "latin1"
export function resolveCodepage(codepage: string): string {
    const name = codepage.toUpperCase();

    if (name === UTF8 || name === "UTF8") {
        return UTF8;
    }

    const canonical = name in CODEPAGE_TABLES ? name : CODEPAGE_ALIASES[name];

    if (canonical === undefined) {
        throw new FFSError(`Unknown codepage ${codepage}`);
    }

    return canonical;
}

// The name in the codepage, or undefined when the codepage lacks one of its characters
function encode(name: string, codepage: string): Uint8Array | undefined {
    if (codepage === UTF8) {
        return utf8Encoder.encode(name);
    }

    const { encode } = table(codepage);
    const bytes: number[] = [];

    for (const c of name) {
        const codePoint = c.codePointAt(0)!;
        const byte      = codePoint < 0x80 ? codePoint : encode.get(codePoint);

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

    const { decode } = table(codepage);
    let   name = "";

    for (const byte of stored) {
        const codePoint = byte < 0x80 ? byte : decode[byte - 0x80];

        if (codePoint < 0) {
            return undefined;
        }

        name += String.fromCodePoint(codePoint);
    }

    return name;
}

// The name as a header keeps it
export function encodeName(name: string, codepage: string): Uint8Array {
    if (!name.isWellFormed()) {
        throw new FFSError(`'${name}' is not valid Unicode`);
    }

    const stored = encode(name, codepage);

    if (stored) {
        return stored;
    }

    const utf8   = utf8Encoder.encode(name);
    const result = new Uint8Array(utf8.length + 1);

    result[0] = UTF8_PREFIX;
    result.set(utf8, 1);

    return result;
}

// The name as a string. A name the codepage cannot decode is taken for UTF-8.
export function decodeName(stored: Uint8Array, codepage: string): string {
    if (stored.length >= 2 && stored[0] === UTF8_PREFIX) {
        return utf8Decoder.decode(stored.subarray(1));
    }

    if (isAscii(stored)) {
        return latin1(stored);
    }

    return decode(stored, codepage) ?? utf8Decoder.decode(stored);
}

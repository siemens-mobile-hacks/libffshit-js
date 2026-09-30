import { PatternsError } from "../errors.js";

// Words as they are in memory, byte by byte: "?? ?? ?? A?" is a little endian word whose upper
// nibble is 0xA. A word of a pattern of bytes is a single byte, "0?".
export type Readable = readonly string[];

interface RawPart {
    value: number;
    mask: number;
}

// std::stoul(str, nullptr, 16), for the hex digits a pattern has
function parseHex(str: string): number {
    const value = parseInt(str, 16);

    if (Number.isNaN(value)) {
        throw new PatternsError("stoul");
    }

    return value >>> 0;
}

// A pattern of 8 or 32 bit words, matched against little endian data
export class Pattern {
    private readonly raw: RawPart[] = [];
    private readonly wordSize: number;
    private patternStr = "";

    constructor(readable: Readable, wordSize: 1 | 4) {
        this.wordSize = wordSize;

        for (const word of readable) {
            const bytes = wordSize > 1 ? word.split(" ") : [word];

            if (bytes.length !== wordSize) {
                throw new PatternsError("Broken pattern");
            }

            if (wordSize > 1) {
                bytes.reverse();
            }

            let valueStr = "";
            let maskStr  = "";

            for (const byte of bytes) {
                this.patternStr += byte;

                for (const c of byte) {
                    if (c === "?") {
                        valueStr += "0";
                        maskStr  += "0";
                    } else {
                        valueStr += c;
                        maskStr  += "F";
                    }
                }
            }

            this.raw.push({ value: parseHex(valueStr), mask: parseHex(maskStr) });

            this.patternStr += " ";
        }
    }

    toString(): string {
        return this.patternStr;
    }

    // The first word, to rule most addresses out quickly
    getFirst(): { value: number, mask: number } {
        return this.raw[0];
    }

    // Past its end the data reads as zeros, as the C++ library's spare allocation does
    match(data: Uint8Array, offset: number): boolean {
        for (let i = 0; i < this.raw.length; ++i) {
            const word = this.wordSize === 4 ? readWord(data, offset + i * 4) : (data[offset + i] ?? 0);
            const part = this.raw[i];

            if (((word & part.mask) >>> 0) !== part.value) {
                return false;
            }
        }

        return true;
    }
}

function readWord(data: Uint8Array, offset: number): number {
    if (offset + 4 <= data.length) {
        return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
    }

    let word = 0;

    for (let i = 3; i >= 0; --i) {
        word = (word * 256) + (data[offset + i] ?? 0);
    }

    return word;
}

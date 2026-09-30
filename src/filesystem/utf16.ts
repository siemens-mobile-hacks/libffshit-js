import { hex } from "../format.js";
import { Logger } from "../log.js";

// The name after a NewSGOLD header: glibc's iconv() from UTF-16LE to UTF-8 of everything after the
// header, up to the first 0. The C++ library gives iconv as many bytes to write to as it reads, so
// a name that takes more in UTF-8 fails too, as do a lone surrogate and an odd byte at the end.
// Undefined when iconv fails.
export function decodeUtf16Name(bytes: Uint8Array): string | undefined {
    const outLimit  = bytes.length;
    let   outSize   = 0;
    let   name      = "";
    let   ended     = false;
    let   i         = 0;

    for (; i + 1 < bytes.length; i += 2) {
        const unit = bytes[i] | (bytes[i + 1] << 8);
        let   size: number;

        if (unit >= 0xD800 && unit <= 0xDBFF) {
            if (i + 3 >= bytes.length) {
                return undefined;
            }

            const low = bytes[i + 2] | (bytes[i + 3] << 8);

            if (low < 0xDC00 || low > 0xDFFF) {
                return undefined;
            }

            size = 4;

            if (!ended) {
                name += String.fromCharCode(unit, low);
            }

            i += 2;
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
            return undefined;
        } else {
            size = unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;

            if (unit === 0) {
                ended = true;
            } else if (!ended) {
                name += String.fromCharCode(unit);
            }
        }

        outSize += size;

        if (outSize > outLimit) {
            return undefined;
        }
    }

    return i < bytes.length ? undefined : name;
}

// The name a header gets whose name does not convert, numbered across every fullflash loaded
export function brokenName(bytes: Uint8Array, counter: { value: number }): string {
    const name = `broken_name_${counter.value++}`;

    Logger.warn(`Broken name: ${Array.from(bytes, (byte) => `${hex(byte, 2)} `).join("")} -> ${name}`);

    return name;
}

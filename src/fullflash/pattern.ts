// Bytes in memory order, "??" for any byte and "A?" for a byte whose upper nibble is 0xA, e.g.
// "?? ?? ?? A?" for a little endian address in 0xA0000000..0xAFFFFFFF
export class Pattern {
    readonly length: number;
    // Only the bytes that are not "??", as [index, mask, value]
    private readonly checks: [number, number, number][] = [];

    constructor(readable: string) {
        const bytes = readable.trim().split(/\s+/);

        this.length = bytes.length;

        bytes.forEach((byte, i) => {
            const mask  = parseInt(byte.replace(/[0-9A-F]/gi, "F").replace(/\?/g, "0"), 16);
            const value = parseInt(byte.replace(/\?/g, "0"), 16);

            if (mask) {
                this.checks.push([i, mask, value]);
            }
        });
    }

    matches(data: Uint8Array, offset: number): boolean {
        if (offset < 0 || offset + this.length > data.length) {
            return false;
        }

        for (const [i, mask, value] of this.checks) {
            if ((data[offset + i] & mask) !== value) {
                return false;
            }
        }

        return true;
    }

    // Where it matches, at every `step`th byte
    *find(data: Uint8Array, step: number): Generator<number> {
        for (let offset = 0; offset + this.length <= data.length; offset += step) {
            if (this.matches(data, offset)) {
                yield offset;
            }
        }
    }
}

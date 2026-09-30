// The fullflash's bytes, shared by everything that reads or writes them. They stay the caller's
// buffer until the first write, which works on a copy: the caller's buffer is never changed.
export class Image {
    private data: Uint8Array;
    private owned: boolean;

    constructor(data: Uint8Array, owned = false) {
        this.data  = data;
        this.owned = owned;
    }

    getData(): Uint8Array {
        return this.data;
    }

    getWritableData(): Uint8Array {
        if (!this.owned) {
            // A copy even of a Buffer, whose slice() is a view
            this.data  = new Uint8Array(this.data);
            this.owned = true;
        }

        return this.data;
    }

    // `size` bytes from `offset`. Past the end they read as zeros, as they do from the spare room
    // the C++ library allocates after the fullflash.
    view(offset: number, size: number): Uint8Array {
        if (offset + size <= this.data.length) {
            return this.data.subarray(offset, offset + size);
        }

        const padded = new Uint8Array(size);

        if (offset < this.data.length) {
            padded.set(this.data.subarray(offset));
        }

        return padded;
    }
}

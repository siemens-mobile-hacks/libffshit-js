// The fullflash's bytes. They stay the caller's buffer until the first write, which copies them:
// the caller's buffer is never changed.
export class Image {
    private bytes: Uint8Array;
    private owned = false;

    constructor(bytes: Uint8Array) {
        this.bytes = bytes;
    }

    get data(): Uint8Array {
        return this.bytes;
    }

    writable(): Uint8Array {
        if (!this.owned) {
            this.bytes = this.bytes.slice();
            this.owned = true;
        }

        return this.bytes;
    }
}

import type { Image } from "../image.js";
import { decodeUtf8 } from "../rawdata.js";

export interface BlockHeader {
    // char[8]: the name, and zeros after it
    name: Uint8Array;
    unknown1: number;
    unknown2: number;
    unknown3: number;
    // x55
    unknown4: number;
}

export function emptyBlockHeader(): BlockHeader {
    return { name: new Uint8Array(8), unknown1: 0, unknown2: 0, unknown3: 0, unknown4: 0 };
}

// The name of a block header as a C string. The C++ library keeps it in a struct, where an
// 8 byte name without a 0 runs on into the fields after it.
export function blockHeaderNameBytes(header: BlockHeader): Uint8Array {
    const bytes = new Uint8Array(18);
    const view  = new DataView(bytes.buffer);

    bytes.set(header.name.subarray(0, 8));
    view.setUint16(8, header.unknown1, true);
    view.setUint16(10, header.unknown2, true);
    view.setUint32(12, header.unknown3, true);
    view.setUint16(16, header.unknown4, true);

    const end = bytes.indexOf(0);

    return bytes.slice(0, end < 0 ? bytes.length : end);
}

export function blockHeaderName(header: BlockHeader): string {
    return decodeUtf8(blockHeaderNameBytes(header));
}

// A flash block of a partition. Its data is a view of the fullflash, so it shows what was
// written to the fullflash since.
export class Block {
    private readonly header: BlockHeader;
    private readonly image: Image;
    private readonly addr: number;
    private readonly size: number;

    constructor(header: BlockHeader, image: Image, addr: number, size: number) {
        this.header = header;
        this.image  = image;
        this.addr   = addr;
        this.size   = size;
    }

    getHeader(): BlockHeader {
        return this.header;
    }

    getAddr(): number {
        return this.addr;
    }

    getSize(): number {
        return this.size;
    }

    getData(): Uint8Array {
        return this.image.view(this.addr, this.size);
    }
}

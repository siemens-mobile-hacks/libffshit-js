// RawData's reads, with its checks and messages. The data is a Uint8Array; a slice of it is a view
// where the C++ library copies, as nothing writes to what these return.

import { FullflashError } from "./errors.js";
import { dec } from "./format.js";

// A view of `size` bytes of `data` from `offset`: RawData(prev, offset, size)
export function slice(data: Uint8Array, offset: number, size: number): Uint8Array {
    if (data.length === 0) {
        throw new FullflashError("RawData() form prev. with offset, size. prev.size == 0");
    }

    if (size === 0) {
        throw new FullflashError("RawData() form prev. with offset, size. data_size == 0");
    }

    if (offset < 0 || offset + size > data.length) {
        throw new FullflashError("RawData() offset + size > prev. size");
    }

    return data.subarray(offset, offset + size);
}

// Where `read_size` bytes at `offset` can be read: RawData::read()
export function checkRead(data: Uint8Array, offset: number, readSize: number): void {
    if (readSize === 0) {
        throw new FullflashError("RawData::read() read_size == 0");
    }

    if (offset < 0 || offset >= data.length) {
        throw new FullflashError(`RawData::read() Offset >= data size. Offset: ${dec(offset)}, Data size: ${data.length}`);
    }

    if (offset + readSize > data.length) {
        throw new FullflashError(`RawData::read() Read size + offset > data size; Offset: ${offset}, Read size: ${readSize}, Data size: ${data.length}`);
    }
}

export function readU16(data: Uint8Array, offset: number): number {
    checkRead(data, offset, 2);

    return data[offset] | (data[offset + 1] << 8);
}

export function readU32(data: Uint8Array, offset: number): number {
    checkRead(data, offset, 4);

    return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

export function readBytes(data: Uint8Array, offset: number, size: number): Uint8Array {
    checkRead(data, offset, size);

    return new Uint8Array(data.subarray(offset, offset + size));
}

// The bytes from `offset` up to a 0 or the end, every `step`th: RawData::read_string()
export function readString(data: Uint8Array, offset: number, step = 1): Uint8Array {
    const bytes: number[] = [];

    for (let i = offset; i >= 0 && i < data.length && data[i] !== 0; i += step) {
        bytes.push(data[i]);
    }

    return Uint8Array.from(bytes);
}

// A record inline in an ELKA FIT: its bytes are the first 16 of each 32 byte slot, the slots
// going down from the FIT entry at `offset`, the first slot holding the last bytes.
// RawData::read_aligned()
export function readAligned(data: Uint8Array, offset: number, readSize: number): Uint8Array {
    if (readSize === 0) {
        throw new FullflashError("RawData::read_aligned() read_size == 0");
    }

    if (offset >= data.length) {
        throw new FullflashError(`RawData::read_aligned(). offset '${offset}' >= data size '${data.length}'`);
    }

    const result  = new Uint8Array(readSize);
    let   ptr     = offset;
    let   toRead  = readSize;

    while (toRead > 0) {
        const skip = toRead <= 16 ? 16 - toRead : 0;

        ptr -= 32;

        // The C++ library reads whatever lies before the data here
        if (ptr < 0) {
            throw new FullflashError(`RawData::read_aligned(). offset '${offset}' - read_size '${readSize}' < 0`);
        }

        toRead -= 16 - skip;
        result.set(data.subarray(ptr + skip, ptr + 16), toRead);
    }

    return result;
}

// Appends pieces into one new buffer: RawData::add()
export class ByteBuilder {
    private chunks: Uint8Array[] = [];
    private size = 0;

    add(data: Uint8Array): void {
        if (data.length === 0) {
            return;
        }

        this.chunks.push(data);
        this.size += data.length;
    }

    getSize(): number {
        return this.size;
    }

    // Always a copy: the pieces may be views of the fullflash
    build(): Uint8Array {
        const result = new Uint8Array(this.size);
        let   offset = 0;

        for (const chunk of this.chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        return result;
    }
}

// Bytes as a string of the same char codes, for comparing and hashing byte strings
export function toBinaryString(bytes: Uint8Array): string {
    let str = "";

    for (let i = 0; i < bytes.length; i += 0x2000) {
        str += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
    }

    return str;
}

const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

// A std::string of the C++ library as a JavaScript string: its bytes as UTF-8, where invalid
// sequences become U+FFFD
export function decodeUtf8(bytes: Uint8Array): string {
    return utf8Decoder.decode(bytes);
}

// C's isprint() in the C locale
export function isPrint(byte: number): boolean {
    return byte >= 0x20 && byte <= 0x7E;
}

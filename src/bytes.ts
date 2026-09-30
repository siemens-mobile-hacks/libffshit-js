import { FFSError } from "./errors.js";

function check(data: Uint8Array, offset: number, size: number): void {
    if (offset < 0 || offset + size > data.length) {
        throw new FFSError(`${size} bytes at ${offset} are past the end of ${data.length}`);
    }
}

export function u16(data: Uint8Array, offset: number): number {
    check(data, offset, 2);

    return data[offset] | (data[offset + 1] << 8);
}

export function u32(data: Uint8Array, offset: number): number {
    check(data, offset, 4);

    return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

export function le16(value: number): Uint8Array {
    return Uint8Array.of(value & 0xFF, (value >>> 8) & 0xFF);
}

export function le32(value: number): Uint8Array {
    return Uint8Array.of(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let   offset = 0;

    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }

    return result;
}

// The bytes from `offset` up to a 0 or the end, at most `max`
export function cString(data: Uint8Array, offset: number, max = Infinity): Uint8Array {
    if (offset < 0 || offset >= data.length) {
        return new Uint8Array(0);
    }

    const limit = Math.min(data.length, offset + max);
    let   end   = offset;

    while (end < limit && data[end] !== 0) {
        ++end;
    }

    return data.subarray(offset, end);
}

// Bytes as the string of the same char codes
export function latin1(bytes: Uint8Array): string {
    let str = "";

    for (let i = 0; i < bytes.length; i += 0x2000) {
        str += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
    }

    return str;
}

export function isPrintable(bytes: Uint8Array): boolean {
    return bytes.every((byte) => byte >= 0x20 && byte <= 0x7E);
}

export function hex(value: number): string {
    return value.toString(16).toUpperCase().padStart(8, "0");
}

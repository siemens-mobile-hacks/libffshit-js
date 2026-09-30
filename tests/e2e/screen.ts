// What a phone's display shows: QEMU's screendumps, and the images of the screens the phones show
// once they have booted

import fs from "node:fs";
import zlib from "node:zlib";

export interface Screen {
    width:  number;
    height: number;
    // 3 bytes a pixel, row after row
    rgb:    Uint8Array;
}

// A pixel differs when a channel does by more than this, which leaves out the blending of
// antialiased text
const CHANNEL_TOLERANCE = 48;

// The binary PPM of HMP's screendump
export function parsePpm(data: Buffer): Screen {
    const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(data.toString("latin1", 0, 64));

    if (!header) {
        throw new Error("not a screendump");
    }

    const width     = Number(header[1]);
    const height    = Number(header[2]);
    const offset    = header[0].length;

    return { width, height, rgb: data.subarray(offset, offset + width * height * 3) };
}

function paeth(a: number, b: number, c: number): number {
    const p     = a + b - c;
    const pa    = Math.abs(p - a);
    const pb    = Math.abs(p - b);
    const pc    = Math.abs(p - c);

    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// 8-bit RGB or RGBA, not interlaced
export function readPng(file: string): Screen {
    const data = fs.readFileSync(file);
    const idat: Buffer[] = [];
    let   width = 0, height = 0, channels = 0;

    for (let offset = 8; offset < data.length;) {
        const length    = data.readUInt32BE(offset);
        const type      = data.toString("latin1", offset + 4, offset + 8);
        const body      = data.subarray(offset + 8, offset + 8 + length);

        if (type === "IHDR") {
            width       = body.readUInt32BE(0);
            height      = body.readUInt32BE(4);
            channels    = body[9] === 2 ? 3 : body[9] === 6 ? 4 : 0;

            if (body[8] !== 8 || !channels || body[12] !== 0) {
                throw new Error(`${file}: only 8-bit RGB and RGBA PNGs without interlacing are read`);
            }
        } else if (type === "IDAT") {
            idat.push(body);
        }

        offset += 12 + length;
    }

    const raw       = zlib.inflateSync(Buffer.concat(idat));
    const stride    = width * channels;
    const pixels    = new Uint8Array(stride * height);

    for (let y = 0; y < height; ++y) {
        const filter    = raw[y * (stride + 1)];
        const line      = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const row       = y * stride;

        for (let x = 0; x < stride; ++x) {
            const a = x >= channels ? pixels[row + x - channels] : 0;
            const b = y > 0 ? pixels[row - stride + x] : 0;
            const c = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0;

            pixels[row + x] = line[x] + [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
        }
    }

    const rgb = new Uint8Array(width * height * 3);

    for (let i = 0; i < width * height; ++i) {
        rgb.set(pixels.subarray(i * channels, i * channels + 3), i * 3);
    }

    return { width, height, rgb };
}

function crc32(data: Buffer): number {
    let crc = ~0;

    for (const byte of data) {
        crc ^= byte;

        for (let bit = 0; bit < 8; ++bit) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
        }
    }

    return ~crc >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
    const data = Buffer.alloc(body.length + 12);

    data.writeUInt32BE(body.length, 0);
    data.write(type, 4, "latin1");
    body.copy(data, 8);
    data.writeUInt32BE(crc32(data.subarray(4, body.length + 8)), body.length + 8);

    return data;
}

export function writePng(file: string, screen: Screen): void {
    const header    = Buffer.alloc(13);
    const stride    = screen.width * 3;
    const raw       = Buffer.alloc((stride + 1) * screen.height);

    header.writeUInt32BE(screen.width, 0);
    header.writeUInt32BE(screen.height, 4);
    header.set([8, 2, 0, 0, 0], 8);

    for (let y = 0; y < screen.height; ++y) {
        raw.set(screen.rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }

    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk("IHDR", header),
        chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]));
}

// The share of the pixels that differ, 1 for screens of different sizes
export function difference(a: Screen, b: Screen): number {
    if (a.width !== b.width || a.height !== b.height) {
        return 1;
    }

    let differing = 0;

    for (let i = 0; i < a.rgb.length; i += 3) {
        if (Math.abs(a.rgb[i] - b.rgb[i]) > CHANNEL_TOLERANCE || Math.abs(a.rgb[i + 1] - b.rgb[i + 1]) > CHANNEL_TOLERANCE || Math.abs(a.rgb[i + 2] - b.rgb[i + 2]) > CHANNEL_TOLERANCE) {
            ++differing;
        }
    }

    return differing / (a.width * a.height);
}

// Fullflashes made up for the tests, of every platform: what the detector looks for, a partition
// table the search finds, formatted blocks, and filesystems with what the loaders have to cope with.
// They are small, and not the phones' firmware, so they can be part of the repository's tests.

import { encodeName } from "../../src/filesystem/codepage.js";
import { nameHash7bit, nameHash8bit, nameHashUtf16 } from "../../src/filesystem/hash.js";
import { Records } from "../../src/filesystem/records.js";
import type { Platform } from "../../src/fullflash/detector.js";
import { Image } from "../../src/image.js";

function setU16(data: Uint8Array, offset: number, value: number): void {
    data[offset]     = value & 0xFF;
    data[offset + 1] = (value >>> 8) & 0xFF;
}

function setU32(data: Uint8Array, offset: number, value: number): void {
    setU16(data, offset, value & 0xFFFF);
    setU16(data, offset + 2, (value >>> 16) & 0xFFFF);
}

function setString(data: Uint8Array, offset: number, str: string): void {
    data.set(Buffer.from(str, "latin1"), offset);
}

function concat(...parts: Uint8Array[]): Uint8Array {
    return Uint8Array.from(Buffer.concat(parts));
}

function u16(value: number): Uint8Array {
    return Uint8Array.of(value & 0xFF, (value >>> 8) & 0xFF);
}

function u32(value: number): Uint8Array {
    return Uint8Array.of(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
}

export function fatTime(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
    return (((year - 1980) << 25) | (month << 21) | (day << 16) | (hour << 11) | (minute << 5) | (second >> 1)) >>> 0;
}

// =========================================================================
// Partition tables and formatted blocks

export interface PartitionLayout {
    name: string;
    blocks: number;
    // indexes of blocks left unformatted
    unformatted?: number[];
    // EGOLD: a multiple of 32 KiB, else the layout's
    blockSize?: number;
}

export interface ImageLayout {
    platform: Platform;
    size: number;
    blockSize: number;
    partitions: PartitionLayout[];
    model?: string;
    imei?: string;
    // no "OTP\0" pointing at the table, which is then searched for by its pattern
    noPointer?: boolean;
    // where the blocks start in the image, and what the table adds to their addresses
    blocksAddr?: number;
    blockAddressOffset?: number;
    // the model and the IMEI written somewhere else than the detector reads them first
    detectorFallbacks?: boolean;
    // EGOLD: where the image starts in the phone's address space, 16 MiB before its end by default
    base?: number;
}

const POINTER_ADDR  = 0x1000;
const TABLE_ADDR    = 0x2000;
const NAMES_ADDR    = 0x3000;
const LISTS_ADDR    = 0x3800;
const BLOCKS_ADDR   = 0x100000;

// An image with the partition table, and each partition's blocks erased and formatted
export function formattedImage(layout: ImageLayout): Uint8Array {
    const data   = new Uint8Array(layout.size);
    const elka   = layout.platform === "SGOLD2_ELKA";
    const model  = layout.model ?? "SYN";
    const imei   = layout.imei ?? "490154203237518";

    switch (layout.platform) {
        case "SGOLD": {
            setString(data, 0x870, "BC65");
            setString(data, 0x210, model);
            // The x65's IMEI, or the x7x's
            setString(data, layout.detectorFallbacks ? 0x660 : 0x65C, imei);

            break;
        }

        case "SGOLD2": {
            setString(data, 0x870, "BC75");
            setString(data, 0x210, layout.detectorFallbacks ? "\x01" : model);
            setString(data, 0x660, imei);

            break;
        }

        case "EGOLD_CE":
        case "EGOLD": {
            // The flash configuration block: the language pack, the model and the vendor
            setString(data, 0x80000 - 0xA0, "lg1");
            setString(data, 0x80000 - 0x90, model);
            setString(data, 0x80000 - 0x80, "SIEMENS");

            egoldTable(data, layout);

            return data;
        }

        case "SGOLD2_ELKA": {
            setString(data, 0xC70, "BC85");

            // An unprintable model and IMEI, with the model and IMEI 16 bytes further on
            if (layout.detectorFallbacks) {
                setString(data, 0x3E000, "\x02\x03");
                setString(data, 0x3E010, model);
                setString(data, 0x3E410, "\x04");
                setString(data, 0x3E420, imei);
            } else {
                setString(data, 0x3E000, model);
                setString(data, 0x3E410, imei);
            }

            break;
        }
    }

    // "OTP\0" and where the table is
    if (!layout.noPointer) {
        setString(data, POINTER_ADDR, "OTP\0");
        setU32(data, POINTER_ADDR + 4, 0xA0000000 | TABLE_ADDR);
    }

    const structSize = layout.platform === "SGOLD" ? 0x2C : 0x34;
    let   blockAddr  = layout.blocksAddr ?? BLOCKS_ADDR;

    layout.partitions.forEach((partition, i) => {
        const entry     = TABLE_ADDR + i * structSize;
        const nameAddr  = NAMES_ADDR + i * 16;
        const listAddr  = LISTS_ADDR + i * 0x100;

        setString(data, nameAddr, `${partition.name}\0`);

        if (layout.platform === "SGOLD") {
            // name, 0, 0, pointer, 0, table size, table, ?, pointer, pointer, ?
            setU32(data, entry + 0x00, 0xA0000000 | nameAddr);
            setU32(data, entry + 0x0C, 0xA0000000);
            setU32(data, entry + 0x14, partition.blocks);
            setU32(data, entry + 0x18, 0xA0000000 | listAddr);
            setU32(data, entry + 0x20, 0xA0000000);
            setU32(data, entry + 0x24, 0xA0000000);
        } else {
            // name, 0, 0, ?, ?, ?, pointer, 0, table size, table, ?, pointer, ?
            setU32(data, entry + 0x00, 0xA0000000 | nameAddr);
            setU32(data, entry + 0x18, 0xA0000000);
            setU32(data, entry + 0x20, partition.blocks);
            setU32(data, entry + 0x24, 0xA0000000 | listAddr);
            setU32(data, entry + 0x2C, 0xA0000000);
        }

        for (let j = 0; j < partition.blocks; ++j) {
            setU32(data, listAddr + j * 8, (0xA0000000 | ((layout.blockAddressOffset ?? 0) + blockAddr)) >>> 0);
            setU32(data, listAddr + j * 8 + 4, layout.blockSize);

            data.fill(0xFF, blockAddr, blockAddr + layout.blockSize);

            if (!partition.unformatted?.includes(j)) {
                const header = elka ? blockAddr + layout.blockSize - 0x20 : blockAddr;

                data.fill(0, header, header + 8);
                setString(data, header, partition.name.slice(0, 8));
                setU16(data, header + 8, 1 + j);
                setU16(data, header + 10, 0);
                setU32(data, header + 12, 0xFFFFFFF0);
            }

            blockAddr += layout.blockSize;
        }
    });

    return data;
}

function egoldBase(layout: ImageLayout): number {
    return layout.base ?? 0x1000000 - layout.size;
}

// EGOLD's: a pointer to a table of records of blocks, each with where the block's address is, whose
// header names the partition: at 0x80 with Card-Explorer, at 0x10 without
function egoldTable(data: Uint8Array, layout: ImageLayout): void {
    const base      = egoldBase(layout);
    const blocks    = layout.partitions.flatMap((partition) => Array.from({ length: partition.blocks }, (_, i) => ({ name: partition.name, number: i, size: partition.blockSize ?? layout.blockSize })));
    const header    = layout.platform === "EGOLD_CE" ? 0x80 : 0x10;
    let   blockAddr = layout.blocksAddr ?? BLOCKS_ADDR;

    // Addresses are segment:offset, with 16 KiB segments
    const segment = (offset: number): number => {
        const page = base + offset;

        return ((Math.floor(page / 0x4000) << 16) | (page % 0x4000)) >>> 0;
    };

    setU32(data, POINTER_ADDR, blocks.length);
    setU16(data, POINTER_ADDR + 4, 1);
    setU32(data, POINTER_ADDR + 6, segment(TABLE_ADDR));

    blocks.forEach((block, i) => {
        // Of sectors of 128, 64 or 32 KiB, whose size in KiB the table has
        const sector = [0x20000, 0x10000, 0x8000].find((size) => block.size % size === 0)!;

        setU16(data, TABLE_ADDR + i * 6, block.size / sector);
        setU32(data, TABLE_ADDR + i * 6 + 2, segment(LISTS_ADDR + i * 6));
        setU32(data, LISTS_ADDR + i * 6, base + blockAddr);
        setU16(data, LISTS_ADDR + i * 6 + 4, sector / 0x400);

        data.fill(0xFF, blockAddr, blockAddr + block.size);

        // FE FE, the name, 1, the block's number, what the phones have there, FE FE
        setU16(data, blockAddr + header, 0xFEFE);
        data.fill(0, blockAddr + header + 2, blockAddr + header + 8);
        setString(data, blockAddr + header + 2, block.name);
        setU16(data, blockAddr + header + 8, 1);
        setU16(data, blockAddr + header + 10, block.number);
        setU16(data, blockAddr + header + 12, 0xFFA0);
        setU16(data, blockAddr + header + 14, 0xFEFE);

        blockAddr += block.size;
    });
}

// Of an EGOLD image made by formattedImage(), as a dump of the flash from after it has it
export function removeEgoldTable(data: Uint8Array): void {
    data.fill(0, POINTER_ADDR, POINTER_ADDR + 10);
}

// An image made by formattedImage(), and records added to its partitions' formatted blocks, where
// the library would write them
export class RecordsBuilder {
    private readonly image: Image;
    private readonly records = new Map<string, Records>();

    constructor(private readonly layout: ImageLayout) {
        this.image = new Image(formattedImage(layout));
    }

    add(partition: string, id: number, data: Uint8Array): void {
        let records = this.records.get(partition);

        if (!records) {
            const unformatted   = this.layout.partitions.find((p) => p.name === partition)?.unformatted ?? [];
            const blocks        = layoutBlocks(this.layout, partition).filter((_, i) => !unformatted.includes(i));

            records = Records.open(this.layout.platform, this.image, { name: partition, blocks }, egoldBase(this.layout));
            this.records.set(partition, records);
        }

        records.add(id, data);
    }

    build(): Uint8Array {
        return this.image.data;
    }
}

// Changes a FIT entry of a record in any of the blocks: its flags, or its id, e.g. to one another
// record has
export function patchFitEntry(image: Uint8Array, platform: Platform, blocks: { addr: number, size: number }[], id: number, field: "flags" | "id" | "size", value: number): void {
    const elka = platform === "SGOLD2_ELKA";

    // The state, 0, the size, the address, the id, a tag and the state again
    if (platform === "EGOLD_CE" || platform === "EGOLD") {
        for (const block of blocks) {
            for (let at = block.addr + block.size - 12; at > block.addr && image[at] !== 0xFF; at -= 12) {
                if ((image[at + 8] | (image[at + 9] << 8)) !== id || image[at] !== 0xFC) {
                    continue;
                }

                if (field === "flags") {
                    image[at]      = value;
                    image[at + 11] = value;
                } else {
                    setU16(image, at + (field === "id" ? 8 : 2), value);
                }

                return;
            }
        }

        throw new Error(`No record ${id}`);
    }

    for (const block of blocks) {
        let offset = block.size - (elka ? 64 : 16);

        while (offset > 0) {
            const view      = new DataView(image.buffer, image.byteOffset + block.addr + offset, 16);
            const entryId   = view.getUint32(4, true);
            const size      = view.getUint32(8, true);

            if (view.getUint32(0, true) === 0xFFFFFFFF && (!elka || entryId === 0xFFFFFFFF)) {
                break;
            }

            if (entryId === id && view.getUint32(0, true) === 0xFFFFFFC0) {
                view.setUint32(field === "flags" ? 0 : field === "id" ? 4 : 8, value >>> 0, true);

                return;
            }

            offset -= elka ? fitStep(size) : 16;
        }
    }

    throw new Error(`No record ${id}`);
}

// The blocks of a partition of an image made by formattedImage()
export function layoutBlocks(layout: ImageLayout, partition: string): { addr: number, size: number }[] {
    let addr = layout.blocksAddr ?? BLOCKS_ADDR;

    for (const p of layout.partitions) {
        const size = p.blockSize ?? layout.blockSize;

        if (p.name === partition) {
            return Array.from({ length: p.blocks }, (_, i) => ({ addr: addr + i * size, size }));
        }

        addr += p.blocks * size;
    }

    throw new Error(`No partition ${partition}`);
}

function fitStep(size: number): number {
    const inline = (n: number) => (1 + Math.ceil(n / 16)) * 32;
    const tail   = size & 0x3FF;

    if (size <= 0x200) {
        return inline(size);
    }

    return (size & 0x1C00) && tail > 0 && tail <= 0x200 ? inline(tail) : 32;
}

// =========================================================================
// Filesystems

export interface FsFile {
    // a string, or the name's bytes as the header keeps them
    name: string | Uint8Array;
    attributes?: number;
    fat?: number;
    data?: Uint8Array;
    children?: FsFile[];
    // what goes wrong with it
    noData?: boolean;
    brokenPart?: boolean;
    headerId?: number;
}

export interface FsOptions {
    chunkSize: number;
    rootFat?: number;
    // what the root's header names it, nothing by default
    rootName?: Uint8Array;
    // added to every record's id, as SGOLD prototypes and EGOLD have them
    idOffset?: number;
    // EGOLD's headers and parts, of 16 bytes or of 20
    headerSize?: number;
    // EGOLD's version 1, the S46's: directory entries without the names' hashes
    egoldVersion?: 1 | 2;
}

interface Ids {
    next: number;
}

// The records of a filesystem, id by id, in the format of the platform
export function filesystemRecords(platform: Platform, root: FsFile[], options: FsOptions): Map<number, Uint8Array> {
    const records   = new Map<number, Uint8Array>();
    const egold     = platform === "EGOLD_CE" || platform === "EGOLD";
    const sgold     = platform === "SGOLD" || egold;
    const hashless  = options.egoldVersion === 1;
    // EGOLD's headers and parts end in 0xFF
    const padding   = new Uint8Array((options.headerSize ?? 16) - 16).fill(0xFF);
    const idOffset  = options.idOffset ?? (egold ? 6000 : 0);
    const rootId    = sgold ? 6 : 10;
    const ids: Ids  = { next: sgold ? 10 : 12 };
    const none      = sgold ? 0xFFFF : 0xFFFFFFFF;
    const chunk     = options.chunkSize;

    const allocate = (): number => {
        const id = ids.next;

        ids.next += 2;

        return id;
    };

    const storedName = (name: string | Uint8Array): Uint8Array => {
        if (typeof name !== "string") {
            return name;
        }

        if (sgold) {
            return encodeName(name);
        }

        return Uint8Array.from(Buffer.from(name, "utf16le"));
    };

    const header = (id: number, parentId: number, dataId: number, nextPart: number, size: number, fat: number, attributes: number, name: Uint8Array): Uint8Array => {
        if (sgold) {
            return concat(u16(id), u16(parentId), u32(fat), u16(dataId), u32((0xFFFF0000 | attributes) >>> 0), u16(nextPart), padding, name, Uint8Array.of(0));
        }

        return concat(u32(id), u32(0xFFFFFFFF), u32(nextPart), u32(parentId), u32(size), u32(fat), u16(attributes), u16(name.length >> 1), name);
    };

    const part = (id: number, dataId: number, prev: number, next: number, owner: { parentId: number, fat: number, attributes: number }): Uint8Array => {
        if (sgold) {
            return concat(u16(id), u16(owner.parentId), u32(owner.fat), u16(dataId), u16(owner.attributes), u16(prev), u16(next), padding);
        }

        return concat(u32(id), u32(prev), u32(next));
    };

    // Data in pieces: the first under the data id, the others under parts
    const store = (id: number, pieces: Uint8Array[], owner: { parentId: number, fat: number, attributes: number }, brokenPart: boolean): number => {
        const partIds = pieces.slice(1).map(() => allocate());

        if (pieces.length) {
            records.set(id + 1, pieces[0]);
        }

        partIds.forEach((partId, i) => {
            const next = i + 1 < partIds.length ? partIds[i + 1] : none;

            records.set(partId, part(partId, partId + 1, i ? partIds[i - 1] : id, brokenPart && i === partIds.length - 1 ? 0x7777 : next, owner));
            records.set(partId + 1, pieces[i + 1]);
        });

        return partIds.length ? partIds[0] : none;
    };

    const directory = (id: number, parentId: number, children: FsFile[], fat: number, attributes: number, name: Uint8Array): void => {
        const entrySize = hashless ? 2 : sgold ? 4 : 8;
        const perRecord = hashless ? 32 : (sgold ? 128 : 256) / entrySize;
        const entries: Uint8Array[] = [];

        for (const child of children) {
            const childId = child.headerId ?? allocate();
            const stored  = storedName(child.name);
            const hash    = egold ? nameHash7bit(stored) : sgold ? nameHash8bit(stored) : nameHashUtf16(String.fromCharCode(...Array.from({ length: stored.length >> 1 }, (_, i) => stored[i * 2] | (stored[i * 2 + 1] << 8))));

            entries.push(hashless ? u16(childId) : sgold ? concat(u16(childId), u16(hash)) : concat(u32(childId), u32((0xFFFF0000 | hash) >>> 0)));

            if (child.children) {
                directory(childId, id, child.children, child.fat ?? fatTime(2008, 1, 2, 3, 4, 6), 0x10 | (child.attributes ?? 0), stored);
            } else {
                const data      = child.data ?? new Uint8Array(0);
                const pieces    = child.noData ? [] : Array.from({ length: Math.ceil(data.length / chunk) }, (_, i) => data.subarray(i * chunk, (i + 1) * chunk));
                const owner     = { parentId: id, fat: child.fat ?? fatTime(2009, 5, 6, 7, 8, 10), attributes: child.attributes ?? 0 };
                const nextPart  = store(childId, pieces, owner, child.brokenPart ?? false);

                records.set(childId, header(childId, id, childId + 1, nextPart, data.length, owner.fat, owner.attributes, stored));
            }
        }

        // Entries in records of a fixed size, 0xFF where they are free
        const pieces: Uint8Array[] = [];

        for (let i = 0; i === 0 || i < entries.length; i += perRecord) {
            const record = new Uint8Array(perRecord * entrySize).fill(0xFF);

            entries.slice(i, i + perRecord).forEach((entry, j) => record.set(entry, j * entrySize));
            pieces.push(record);
        }

        const owner    = { parentId, fat, attributes };
        const nextPart = store(id, pieces, owner, false);

        records.set(id, header(id, parentId, id + 1, nextPart, 0, fat, attributes, name));
    };

    // The configuration record: the chunk size, and EGOLD's the other sizes as the phones have them
    if (hashless) {
        records.set(0, concat(u16(0x100), u16(chunk), u16(0x20), u16(options.headerSize ?? 16), u16(0x3C)));
        records.set(1, new Uint8Array(0x3C).fill(0xFF));
    } else if (egold) {
        records.set(0, concat(u16(0x200), u16(chunk), u16(0x20), u16(0x80), u16(options.headerSize ?? 16), u16(0x3C), u16(0x80)));
        records.set(1, new Uint8Array(0x3C).fill(0xFF));
    } else {
        records.set(0, sgold ? concat(u16(1), u16(chunk), new Uint8Array(12)) : concat(u32(1), u32(chunk), new Uint8Array(8)));
    }

    directory(rootId, rootId, root, options.rootFat ?? fatTime(2007, 6, 5, 4, 3, 2), 0x10, options.rootName ?? new Uint8Array(0));

    if (idOffset) {
        return new Map([...records].map(([id, data]) => [id + idOffset, data]));
    }

    return records;
}

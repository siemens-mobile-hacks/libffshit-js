// Fullflashes made up for the tests, of every platform: what the detector looks for, a partition
// table the search finds, formatted blocks, and filesystems with what the loaders have to cope with.
// They are small, and not the phones' firmware, so they can be part of the repository's tests.

import { nameHash8bit, nameHashUtf16 } from "../../src/filesystem/hash.js";
import { Records } from "../../src/filesystem/records.js";
import { detect } from "../../src/fullflash/detector.js";
import { findPartitions, type Partition } from "../../src/fullflash/partitions.js";
import { Image } from "../../src/image.js";
import { Log } from "../../src/log.js";

type RecordPlatform = "SGOLD" | "SGOLD2" | "SGOLD2_ELKA";

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
}

export interface ImageLayout {
    platform: RecordPlatform;
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

// Adds records to a formatted image's partitions, where the library would write them
export class RecordsBuilder {
    private readonly image: Image;
    private readonly partitions: Partition[];
    private readonly records = new Map<string, Records>();

    constructor(data: Uint8Array, private readonly platform: RecordPlatform) {
        this.image      = new Image(data);
        this.partitions = findPartitions(data, platform, detect(data, platform).sl75, new Log()).partitions;
    }

    add(partition: string, id: number, data: Uint8Array): void {
        let records = this.records.get(partition);

        if (!records) {
            records = Records.open(this.platform, this.image, this.partitions.find((p) => p.name === partition)!);
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
export function patchFitEntry(image: Uint8Array, platform: RecordPlatform, blocks: { addr: number, size: number }[], id: number, field: "flags" | "id" | "size", value: number): void {
    const elka = platform === "SGOLD2_ELKA";

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
        if (p.name === partition) {
            return Array.from({ length: p.blocks }, (_, i) => ({ addr: addr + i * layout.blockSize, size: layout.blockSize }));
        }

        addr += p.blocks * layout.blockSize;
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
    // added to every record's id, as SGOLD prototypes have them
    idOffset?: number;
}

interface Ids {
    next: number;
}

// The records of a filesystem, id by id, in the format of the platform
export function filesystemRecords(platform: RecordPlatform, root: FsFile[], options: FsOptions): Map<number, Uint8Array> {
    const records   = new Map<number, Uint8Array>();
    const sgold     = platform === "SGOLD";
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
            return /^[\x00-\x7F]*$/.test(name) ? Uint8Array.from(Buffer.from(name, "latin1")) : concat(Uint8Array.of(0x1F), Uint8Array.from(Buffer.from(name, "utf8")));
        }

        return Uint8Array.from(Buffer.from(name, "utf16le"));
    };

    const header = (id: number, parentId: number, dataId: number, nextPart: number, size: number, fat: number, attributes: number, name: Uint8Array): Uint8Array => {
        if (sgold) {
            return concat(u16(id), u16(parentId), u32(fat), u16(dataId), u32((0xFFFF0000 | attributes) >>> 0), u16(nextPart), name, Uint8Array.of(0));
        }

        return concat(u32(id), u32(0xFFFFFFFF), u32(nextPart), u32(parentId), u32(size), u32(fat), u16(attributes), u16(name.length >> 1), name);
    };

    const part = (id: number, dataId: number, prev: number, next: number, owner: { parentId: number, fat: number, attributes: number }): Uint8Array => {
        if (sgold) {
            return concat(u16(id), u16(owner.parentId), u32(owner.fat), u16(dataId), u16(owner.attributes), u16(prev), u16(next));
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
        const entrySize = sgold ? 4 : 8;
        const perRecord = (sgold ? 128 : 256) / entrySize;
        const entries: Uint8Array[] = [];

        for (const child of children) {
            const childId = child.headerId ?? allocate();
            const stored  = storedName(child.name);
            const hash    = sgold ? nameHash8bit(stored) : nameHashUtf16(String.fromCharCode(...Array.from({ length: stored.length >> 1 }, (_, i) => stored[i * 2] | (stored[i * 2 + 1] << 8))));

            entries.push(sgold ? concat(u16(childId), u16(hash)) : concat(u32(childId), u32((0xFFFF0000 | hash) >>> 0)));

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

    // The configuration record: the chunk size
    records.set(0, sgold ? concat(u16(1), u16(chunk), new Uint8Array(12)) : concat(u32(1), u32(chunk), new Uint8Array(8)));

    directory(rootId, rootId, root, options.rootFat ?? fatTime(2007, 6, 5, 4, 3, 2), 0x10, options.rootName ?? new Uint8Array(0));

    if (options.idOffset) {
        return new Map([...records].map(([id, data]) => [id + options.idOffset!, data]));
    }

    return records;
}

// =========================================================================
// EGOLD: FIT entries of 12 bytes at the end of 64 KiB blocks, found through a table of blocks
// that a pointer in the firmware leads to

export interface EgoldFile {
    id: number;
    parentId: number;
    name: Uint8Array;
    attributes: number;
    fat: number;
    data?: Uint8Array;
    // the id of the file record of the next part, and that part's data
    parts?: Uint8Array[];
    wtfField?: boolean;
}

export interface EgoldLayout {
    size: number;
    blocks: number;
    model?: string;
    // wtf 0x80: blocks of 128 KiB
    newEgold?: boolean;
    files: EgoldFile[];
    // broken FIT entries: [block id, size]
    extraEntries?: { blockId: number, size: number, marker1?: number, marker2?: number, data?: Uint8Array }[];
}

export function egoldImage(layout: EgoldLayout): Uint8Array {
    const data          = new Uint8Array(layout.size);
    const base          = 16777216 - layout.size;
    const infoOffset    = 0x400300;
    const blockSize     = layout.newEgold ? 0x20000 : 0x10000;
    const blocksAddr    = 0x100000;

    setString(data, infoOffset + 0x0C, layout.model ?? "SYNE");
    setString(data, infoOffset + 0x1C, "SIEMENS");

    const segment = (offset: number): number => {
        const page = (base + offset) >>> 0;

        return (((Math.floor(page / 0x4000) & 0xFFFF) << 16) | (page % 0x4000)) >>> 0;
    };

    // The pointer: the number of records, the first record's blocks count and where the table is
    const pointer   = 0x1000;
    const table     = 0x2000;
    const pages     = 0x3000;

    setU32(data, pointer, layout.blocks);
    setU16(data, pointer + 4, 1);
    setU32(data, pointer + 6, segment(table));

    for (let i = 0; i < layout.blocks; ++i) {
        const blockAddr = blocksAddr + i * blockSize;

        setU16(data, table + i * 6, 1);
        setU32(data, table + i * 6 + 2, segment(pages + i * 6));
        setU32(data, pages + i * 6, (base + blockAddr) >>> 0);
        setU16(data, pages + i * 6 + 4, layout.newEgold ? 0x80 : 0);

        data.fill(0xFF, blockAddr, blockAddr + blockSize);
        // Between FE FE and FE FE, where the old search finds it
        setU16(data, blockAddr + 0x80, 0xFEFE);
        setString(data, blockAddr + 0x82, "FFS\0\0\0");
        setU16(data, blockAddr + 0x88, i);
        setU16(data, blockAddr + 0x8A, 0);
        setU16(data, blockAddr + 0x8C, 0);
        setU16(data, blockAddr + 0x8E, 0xFEFE);
    }

    // Records go into the blocks one after the other, after the header, their FIT entries down
    // from the block's end
    let block       = 0;
    let dataOffset  = 0x100;
    let fitOffset   = blockSize - 12;

    const add = (blockId: number, record: Uint8Array, marker1 = 0x00FC, marker2 = 0xFC00): void => {
        if (dataOffset + record.length + 0x100 > fitOffset) {
            ++block;
            dataOffset  = 0x100;
            fitOffset   = blockSize - 12;
        }

        const blockAddr = blocksAddr + block * blockSize;

        data.set(record, blockAddr + dataOffset);
        setU16(data, blockAddr + fitOffset, marker1);
        setU16(data, blockAddr + fitOffset + 2, record.length);
        setU32(data, blockAddr + fitOffset + 4, (base + blockAddr + dataOffset) >>> 0);
        setU16(data, blockAddr + fitOffset + 8, blockId);
        setU16(data, blockAddr + fitOffset + 10, marker2);

        dataOffset  += (record.length + 3) & ~3;
        fitOffset   -= 12;
    };

    let headerBlockId = 2;
    let dataBlockId   = 6001;

    for (const file of layout.files) {
        const pieces = file.data ? [file.data, ...(file.parts ?? [])] : [];
        // The file records of the parts after the first, and their data
        const partIds = pieces.slice(1).map((_, i) => 0x4000 + file.id * 16 + i);
        const dataId  = pieces.length ? dataBlockId - 6000 : 0x7000;

        if (pieces.length) {
            add(dataBlockId, pieces[0]);
            dataBlockId += 2;
        }

        const record = concat(
            u16(file.id), u16(file.parentId), u32(file.fat), u16(dataId), u16(file.attributes), u16(0xFFFF),
            u16(partIds.length ? partIds[0] : 0xFFFF),
            ...(file.wtfField ? [u32(0xFFFFFFFF)] : []),
            file.name, Uint8Array.of(0),
        );

        add(headerBlockId, record);
        headerBlockId += 2;

        partIds.forEach((partId, i) => {
            const partRecord = concat(u16(partId), u16(file.id), u32(file.fat), u16(0), u16(0), u16(0xFFFF), u16(i + 1 < partIds.length ? partIds[i + 1] : 0xFFFF));

            add(headerBlockId, partRecord);
            add(headerBlockId + 1, pieces[i + 1]);
            headerBlockId += 2;
        });
    }

    for (const entry of layout.extraEntries ?? []) {
        add(entry.blockId, entry.data ?? new Uint8Array(entry.size), entry.marker1, entry.marker2);
    }

    return data;
}

// A directory's data on EGOLD: the ids of its entries, each with a name hash
export function egoldDirectory(ids: number[]): Uint8Array {
    return concat(...ids.map((id) => concat(u16(id), u16(0x1234))), new Uint8Array(8).fill(0xFF));
}


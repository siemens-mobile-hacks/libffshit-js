// Made-up fullflashes of every platform, with the files and the breakage the library has to cope with
import { concat } from "../../src/bytes.js";
import { pattern } from "./data.js";
import { breakTable, fatRecords, fatTime, filesystemRecords, layoutBlocks, patchFitEntry, RecordsBuilder, removeEgoldTable, type FatOptions, type FsFile, type ImageLayout } from "./synthetic.js";

const bytes = (...values: number[]) => Uint8Array.from(values);
export const utf16 = (str: string) => Uint8Array.from(Buffer.from(str, "utf16le"));

// Files of the sizes around the chunk size, names of every kind, attributes and timestamps
function sampleTree(sgold: boolean): FsFile[] {
    return [
        { name: "empty.bin", data: new Uint8Array(0) },
        { name: "one.bin", data: pattern(1, 1), attributes: 0x01 },
        { name: "chunk-1.bin", data: pattern(1023, 2), attributes: 0x02 },
        { name: "chunk.bin", data: pattern(1024, 3), attributes: 0x04 },
        { name: "chunk+1.bin", data: pattern(1025, 4), attributes: 0x07 },
        { name: "parts.bin", data: pattern(5000, 5), fat: fatTime(2107, 12, 31, 23, 59, 58) },
        { name: "big.bin", data: pattern(20000, 6), fat: 0 },
        {
            name: "Misc",
            children: [
                { name: "Ärger.txt", data: pattern(30, 8) },
                { name: "файл.txt", data: pattern(40, 9) },
                { name: "中文.txt", data: pattern(50, 10) },
                { name: "sub", children: [{ name: "deep.txt", data: pattern(60, 11) }], attributes: 0x02 },
                { name: "empty dir", children: [] },
            ],
        },
        ...(sgold ? [
            // In CP1252, bytes CP1252 lacks, UTF-8, broken UTF-8
            { name: bytes(0xC4, 0x72, 0x67, 0x65, 0x72, 0x2E, 0x62, 0x69, 0x6E), data: pattern(5, 12) },
            { name: bytes(0x81, 0x41, 0x8D), data: pattern(6, 13) },
            { name: bytes(0x1F, 0xD1, 0x84, 0xD0, 0xB0), data: pattern(7, 14) },
            { name: bytes(0x1F, 0xFF, 0xFE), data: pattern(8, 15) },
        ] : [
            // A surrogate pair, an odd byte, a lone surrogate, more UTF-8 than UTF-16 bytes, zeros,
            // a U+FEFF that is no byte order mark
            { name: utf16("😀 emoji.txt"), data: pattern(5, 12) },
            { name: bytes(0x41, 0x00, 0x42), data: pattern(6, 13) },
            { name: bytes(0x00, 0xD8, 0x41, 0x00), data: pattern(7, 14) },
            { name: utf16("中中中"), data: pattern(8, 15) },
            { name: concat([utf16("name"), bytes(0, 0), utf16("after")]), data: pattern(10, 17) },
            { name: utf16("﻿bom.txt"), data: pattern(11, 19) },
            // As the firmware's data exchange leaves them: two names, which it hashes apart
            { name: "inbox.lst", data: new Uint8Array(0) },
            { name: concat([utf16("inbox.lst"), bytes(0, 0)]), data: pattern(426, 18) },
        ]),
    ];
}

// A filesystem of the platform in a formatted image, its records added where the library would
export function recordImage(layout: ImageLayout, trees: Record<string, { files: FsFile[], idOffset?: number, headerSize?: number, egoldVersion?: 1 | 2 }>, patch?: (image: Uint8Array) => void): Uint8Array {
    const builder = new RecordsBuilder(layout);

    for (const [partition, tree] of Object.entries(trees)) {
        for (const [id, data] of filesystemRecords(layout.platform, tree.files, { chunkSize: 1024, idOffset: tree.idOffset, headerSize: tree.headerSize, egoldVersion: tree.egoldVersion })) {
            builder.add(partition, id, data);
        }
    }

    const image = builder.build();

    patch?.(image);

    return image;
}

// A filesystem of the partition, its records by id changed before they are added
function changedImage(layout: ImageLayout, partition: string, files: FsFile[], change: (records: Map<number, Uint8Array>) => void): Uint8Array {
    const builder = new RecordsBuilder(layout);
    const records = filesystemRecords(layout.platform, files, { chunkSize: 1024 });

    change(records);

    for (const [id, data] of records) {
        builder.add(partition, id, data);
    }

    return builder.build();
}

// The x45's LBA_FS, a FAT disk, its sectors added where the library would
function fatImage(files: FsFile[], options?: FatOptions): Uint8Array {
    const builder = new RecordsBuilder(LBA_FS_LAYOUT);

    for (const [sector, data] of fatRecords(files, options)) {
        builder.add("LBA_FS", sector, data);
    }

    return builder.build();
}

// Names short and long, of every case, as bytes in CP1252, and a directory of more
// than a cluster
const FAT_TREE: FsFile[] = [
    { name: "EMPTY.BIN", data: new Uint8Array(0) },
    { name: "one.bin", data: pattern(1, 1), attributes: 0x01 },
    { name: "sector.bin", data: pattern(512, 2), attributes: 0x02 },
    { name: "Sector+1.bin", data: pattern(513, 3), attributes: 0x04 },
    { name: "parts.bin", data: pattern(5000, 5), fat: fatTime(2107, 12, 31, 23, 59, 58) },
    { name: "big.bin", data: pattern(20000, 6) },
    { name: bytes(0xC4, 0x52, 0x47, 0x45, 0x52, 0x20, 0x20, 0x20, 0x42, 0x49, 0x4E), data: pattern(5, 12) },
    { name: bytes(0x05, 0x42, 0x43, 0x20, 0x20, 0x20, 0x20, 0x20, 0x42, 0x49, 0x4E), data: pattern(6, 13) },
    { name: "Thirteen1.txt", data: pattern(13, 14) },
    { name: "Address book", children: [{ name: "5F02.adr", data: pattern(700, 7) }] },
    {
        name: "Misc",
        children: [
            { name: "Ärger.txt", data: pattern(30, 8) },
            { name: "файл.txt", data: pattern(40, 9) },
            { name: "😀 a name of more than 26 characters.txt", data: pattern(50, 10) },
            { name: "\uFEFFbom.txt", data: pattern(15, 15) },
            { name: "sub", children: [{ name: "deep.txt", data: pattern(60, 11) }], attributes: 0x02 },
            { name: "empty dir", children: [] },
        ],
    },
    { name: "Many", children: Array.from({ length: 20 }, (_, i) => ({ name: `file ${i}.txt`, data: pattern(i + 1, 20 + i) })) },
];

export const SGOLD_LAYOUT: ImageLayout  = { platform: "SGOLD", size: 0x800000, blockSize: 0x10000, partitions: [{ name: "FFS", blocks: 8 }] };
export const SGOLD2_LAYOUT: ImageLayout = { platform: "SGOLD2", size: 0x800000, blockSize: 0x10000, partitions: [{ name: "FFS_0", blocks: 8 }, { name: "FFS_C", blocks: 3 }] };
export const ELKA_LAYOUT: ImageLayout   = { platform: "SGOLD2_ELKA", size: 0x800000, blockSize: 0x20000, partitions: [{ name: "FFS_0", blocks: 6 }, { name: "FFS_C", blocks: 3 }] };
export const EGOLD_LAYOUT: ImageLayout  = { platform: "EGOLD_CE", size: 0x800000, blockSize: 0x10000, partitions: [{ name: "FFS", blocks: 8 }] };
// Without Card-Explorer: the C55's, with the EEPROM's blocks after the filesystem's
const OLD_EGOLD_LAYOUT: ImageLayout = { platform: "EGOLD", size: 0x800000, blockSize: 0x20000, partitions: [{ name: "FFS", blocks: 4 }, { name: "EEFULL", blocks: 2 }] };
// The x45's: a FAT disk, and the EEPROM's filesystem, which is none
const LBA_FS_LAYOUT: ImageLayout = { platform: "EGOLD", size: 0x800000, blockSize: 0x10000, partitions: [{ name: "LBA_FS", blocks: 8 }, { name: "EE_FS", blocks: 2 }] };

const CACHE = [{ name: "cache.bin", data: pattern(2000, 1) }];

export const SCENARIOS = {
    "sgold": () => recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true) } }),
    "sgold2": () => recordImage(SGOLD2_LAYOUT, { FFS_0: { files: sampleTree(false) }, FFS_C: { files: CACHE } }),
    "elka": () => recordImage(ELKA_LAYOUT, {
        FFS_0: { files: [...sampleTree(false), ...[0x200, 0x201, 0x400, 0x401, 0x600, 0x601, 0x7FF, 0x800, 0xC00, 0xE00].map((size, i) => ({ name: `size-${size}.bin`, data: pattern(size, 20 + i) }))] },
        FFS_C: { files: CACHE },
    }),
    "sgold broken": () => recordImage(SGOLD_LAYOUT, { FFS: { files: [
        { name: "fine.bin", data: pattern(100, 1) },
        { name: "no data.bin", data: pattern(100, 2), noData: true },
        { name: "broken part.bin", data: pattern(3000, 3), brokenPart: true },
        { name: "missing header", data: pattern(10, 4), headerId: 0x6666 },
        { name: "Dir", children: [{ name: "inner.bin", data: pattern(10, 5) }, { name: "missing", headerId: 0x6668 }] },
        { name: "dup.bin", data: pattern(10, 6) },
    ] } }, (image) => {
        // dup.bin's header takes the id of fine.bin's, and the configuration record is deleted
        patchFitEntry(image, "SGOLD", layoutBlocks(SGOLD_LAYOUT, "FFS"), 20, "id", 10);
        patchFitEntry(image, "SGOLD", layoutBlocks(SGOLD_LAYOUT, "FFS"), 0, "flags", 0xFFFFFF00);
    }),
    // Headers from 10 on: loop.bin's parts are 12 and 14, short part.bin's 18, no part data.bin's 22,
    // and Dir's data record 27
    "sgold broken records": () => changedImage(SGOLD_LAYOUT, "FFS", [
        { name: "loop.bin", data: pattern(3000, 1) },
        { name: "short part.bin", data: pattern(2000, 2) },
        { name: "no part data.bin", data: pattern(2000, 3) },
        { name: "other header.bin", data: pattern(10, 4) },
        { name: "Dir", children: [{ name: "a.bin", data: pattern(10, 5) }] },
        { name: "fine.bin", data: pattern(10, 6) },
    ], (records) => {
        // The last part's next part is the first, and the header of 24 says it is of 256
        records.get(14)!.set([12, 0], 14);
        records.set(18, records.get(18)!.subarray(0, 3));
        records.delete(23);
        records.get(24)!.set([0, 1], 0);
        records.delete(27);
    }),
    "sgold names no path leads to": () => recordImage(SGOLD_LAYOUT, { FFS: { files: [
        { name: bytes(), data: pattern(1, 1) },
        { name: ".", data: pattern(2, 2) },
        { name: "a/b", data: pattern(3, 3) },
        { name: "fine.bin", data: pattern(4, 4) },
    ] } }),
    "sgold loop": () => recordImage(SGOLD_LAYOUT, { FFS: { files: [{ name: "Loop", children: [{ name: "root again", headerId: 6 }, { name: "a.bin", data: pattern(10, 1) }] }] } }),
    "sgold prototype": () => recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true).slice(0, 7), idOffset: 6000 } }),
    "sgold partitions": () => recordImage({ ...SGOLD_LAYOUT, partitions: [{ name: "FFS", blocks: 4, unformatted: [1] }, { name: "FFS_B", blocks: 2, unformatted: [0, 1] }, { name: "FFS_C", blocks: 3 }, { name: "EEFULL", blocks: 1 }] }, {
        FFS: { files: [{ name: "a.bin", data: pattern(10, 1) }] },
        FFS_C: { files: [{ name: "c.bin", data: pattern(20, 2) }] },
    }),
    "sgold no root": () => recordImage(SGOLD_LAYOUT, { FFS: { files: [{ name: "a.bin", data: pattern(10, 1) }] } }, (image) => {
        patchFitEntry(image, "SGOLD", layoutBlocks(SGOLD_LAYOUT, "FFS"), 6, "id", 0x1234);
    }),
    "sgold root too short": () => recordImage(SGOLD_LAYOUT, { FFS: { files: [] } }, (image) => {
        patchFitEntry(image, "SGOLD", layoutBlocks(SGOLD_LAYOUT, "FFS"), 6, "size", 3);
    }),
    "sgold root without the directory attribute": () => changedImage(SGOLD_LAYOUT, "FFS", [{ name: "a.bin", data: pattern(10, 1) }], (records) => {
        // Its attributes are 0xFFFF0010
        records.get(6)![10] = 0;
    }),
    "sgold zero-size block": () => recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true).slice(0, 2) } }, (image) => {
        // The size of the partition's first block in the table
        image.fill(0, 0x3804, 0x3808);
    }),
    // As a dump cut short: the partition's last two blocks, at 0x160000 and 0x170000, are past its end
    "sgold cut short": () => recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true).slice(0, 4) } }).slice(0, 0x160000),
    "sgold2 with an sgold table": () => {
        const image = recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true).slice(0, 5) } });

        image.set(Buffer.from("BC75"), 0x870);

        return image;
    },
    "sgold2 elka prototype": () => {
        const image = recordImage(ELKA_LAYOUT, { FFS_0: { files: sampleTree(false).slice(0, 6) }, FFS_C: { files: CACHE } }, (image) => {
            image.fill(0, 0xC70, 0xC74);
        });

        image.set(Buffer.from("BC75"), 0x870);

        return image;
    },
    // As some E71s' dumps: the boot core's name is elsewhere or erased
    "elka without the boot core's name": () => recordImage(ELKA_LAYOUT, { FFS_0: { files: sampleTree(false).slice(0, 4) }, FFS_C: { files: CACHE } }, (image) => {
        image.fill(0xFF, 0xC70, 0xC74);
    }),
    "sgold without a table pointer": () => recordImage({ ...SGOLD_LAYOUT, noPointer: true, detectorFallbacks: true }, { FFS: { files: sampleTree(true).slice(0, 4) } }),
    "sgold2 without a table pointer": () => recordImage({ ...SGOLD2_LAYOUT, noPointer: true, detectorFallbacks: true }, { FFS_0: { files: sampleTree(false).slice(0, 4) }, FFS_C: { files: CACHE } }),
    "elka without a table pointer": () => recordImage({ ...ELKA_LAYOUT, noPointer: true, detectorFallbacks: true }, { FFS_0: { files: sampleTree(false).slice(0, 4) }, FFS_C: { files: CACHE } }),
    // Found by their blocks' headers, which are of 128 KiB, and on ELKA of 256 KiB
    "sgold with a broken table": () => recordImage({ ...SGOLD_LAYOUT, blockSize: 0x20000, partitions: [{ name: "FFS", blocks: 4 }, { name: "FFS_C", blocks: 2 }] }, { FFS: { files: sampleTree(true).slice(0, 4) }, FFS_C: { files: CACHE } }, breakTable),
    "sgold2 with a broken table": () => recordImage({ ...SGOLD2_LAYOUT, blockSize: 0x20000 }, { FFS_0: { files: sampleTree(false).slice(0, 4) }, FFS_C: { files: CACHE } }, breakTable),
    "elka with a broken table": () => recordImage({ ...ELKA_LAYOUT, blockSize: 0x40000 }, { FFS_0: { files: sampleTree(false).slice(0, 4) }, FFS_C: { files: CACHE } }, breakTable),
    "sgold2 sl75": () => recordImage({ ...SGOLD2_LAYOUT, model: "SL75", size: 0x2400000, blocksAddr: 0x2100000, blockAddressOffset: 0x2000000 }, { FFS_0: { files: sampleTree(false).slice(0, 4) }, FFS_C: { files: CACHE } }),
    "elka flags": () => recordImage(ELKA_LAYOUT, { FFS_0: { files: [{ name: "deleted.bin", data: pattern(100, 1) }, { name: "strange.bin", data: pattern(3000, 2) }] }, FFS_C: { files: CACHE } }, (image) => {
        patchFitEntry(image, "SGOLD2_ELKA", layoutBlocks(ELKA_LAYOUT, "FFS_0"), 13, "flags", 0xFFFFFF00);
        patchFitEntry(image, "SGOLD2_ELKA", layoutBlocks(ELKA_LAYOUT, "FFS_0"), 15, "flags", 0xFFFFFFFE);
    }),
    "egold": () => recordImage({ ...EGOLD_LAYOUT, partitions: [{ name: "FFS", blocks: 8 }, { name: "FFS_C", blocks: 3 }] }, { FFS: { files: sampleTree(true) }, FFS_C: { files: CACHE } }),
    // As the A31's, AF51's, AL21's, AX72's and C110's
    "egold 20-byte headers": () => recordImage(EGOLD_LAYOUT, { FFS: { files: sampleTree(true), headerSize: 20 } }),
    "egold 128 KiB blocks": () => recordImage({ ...EGOLD_LAYOUT, size: 0x1000000, blockSize: 0x20000, partitions: [{ name: "FFS", blocks: 4 }] }, { FFS: { files: sampleTree(true).slice(0, 7) } }),
    // Of an 8 MiB flash at the start of the address space, as the A60's
    "egold at another address": () => recordImage({ ...EGOLD_LAYOUT, base: 0 }, { FFS: { files: sampleTree(true).slice(0, 7) } }),
    // Of the flash from after its partition table, as a C60's with blocks of three 64 KiB sectors
    // in one partition and of one in another
    "egold without a table": () => recordImage({ ...EGOLD_LAYOUT, base: 0x200000, partitions: [{ name: "FFS", blocks: 4, blockSize: 0x30000 }, { name: "FFS_C", blocks: 3 }] }, {
        FFS: { files: sampleTree(true).slice(0, 7) },
        FFS_C: { files: CACHE },
    }, removeEgoldTable),
    "egold broken": () => recordImage(EGOLD_LAYOUT, { FFS: { files: [
        { name: "fine.bin", data: pattern(100, 1) },
        { name: "broken part.bin", data: pattern(3000, 3), brokenPart: true },
        { name: "missing header", data: pattern(10, 4), headerId: 0x2222 },
        { name: "dup.bin", data: pattern(10, 6) },
    ] } }, (image) => {
        // dup.bin's header takes the id of fine.bin's
        patchFitEntry(image, "EGOLD_CE", layoutBlocks(EGOLD_LAYOUT, "FFS"), 6018, "id", 6010);
    }),
    "egold without root": () => recordImage(EGOLD_LAYOUT, { FFS: { files: [{ name: "a.bin", data: pattern(10, 1) }] } }, (image) => {
        patchFitEntry(image, "EGOLD_CE", layoutBlocks(EGOLD_LAYOUT, "FFS"), 6006, "id", 0x1234);
    }),
    "egold without card-explorer": () => recordImage(OLD_EGOLD_LAYOUT, { FFS: { files: sampleTree(true) } }),
    // As one of the A56's
    "egold without card-explorer, 32 KiB blocks": () => recordImage({ ...OLD_EGOLD_LAYOUT, blockSize: 0x8000, partitions: [{ name: "FFS", blocks: 8 }] }, { FFS: { files: sampleTree(true).slice(0, 7) } }),
    "egold without card-explorer, without a table": () => recordImage({ ...OLD_EGOLD_LAYOUT, blockSize: 0x8000, partitions: [{ name: "FFS", blocks: 6 }, { name: "EEFULL", blocks: 1, blockSize: 0x10000 }, { name: "FFS_C", blocks: 2 }] }, {
        FFS: { files: sampleTree(true).slice(0, 7) },
        FFS_C: { files: CACHE },
    }, removeEgoldTable),
    // As the S46's: version 1, with 20-byte headers
    "egold without card-explorer, version 1": () => recordImage({ ...OLD_EGOLD_LAYOUT, blockSize: 0x10000, partitions: [{ name: "FFS", blocks: 7 }] }, { FFS: { files: sampleTree(true), headerSize: 20, egoldVersion: 1 } }),
    "egold without card-explorer, broken": () => recordImage(OLD_EGOLD_LAYOUT, { FFS: { files: [
        { name: "fine.bin", data: pattern(100, 1) },
        { name: "broken part.bin", data: pattern(3000, 3), brokenPart: true },
        { name: "missing header", data: pattern(10, 4), headerId: 0x2222 },
        { name: "dup.bin", data: pattern(10, 6) },
    ] } }, (image) => {
        // dup.bin's header takes the id of fine.bin's
        patchFitEntry(image, "EGOLD", layoutBlocks(OLD_EGOLD_LAYOUT, "FFS"), 6018, "id", 6010);
    }),
    "egold lba_fs": () => fatImage(FAT_TREE),
    "egold lba_fs without a partition table, of 2-sector clusters": () => fatImage(FAT_TREE, { start: 0, clusterSectors: 2 }),
    "egold lba_fs fat16": () => fatImage(FAT_TREE, { fat16: true }),
    "egold lba_fs broken": () => fatImage([
        { name: "fine.bin", data: pattern(100, 1) },
        { name: "broken chain.bin", data: pattern(3000, 2), brokenPart: true },
        { name: "no data.bin", data: pattern(1000, 3), noData: true },
        { name: "root again", children: [], headerId: 1 },
        { name: "nowhere", children: [], headerId: 0x800 },
    ]),
    "x65flasher": () => concat([Buffer.from("FBK\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0A\x0B\x0C\x0D"), recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true).slice(0, 6) } })]),
} satisfies Record<string, () => Uint8Array>;

export type Scenario = keyof typeof SCENARIOS;

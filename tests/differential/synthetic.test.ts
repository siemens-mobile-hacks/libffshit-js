// Made-up fullflashes of every platform, with the files and the breakage the loaders have to cope
// with, loaded and written to by the rewrite and compared with the C++ library. What the C++
// library did is kept in tests/fixtures/synthetic, so that these tests compare with it without it:
// FFSHIT_UPDATE_GOLDEN=1 runs it again and updates them.

import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { assertSame } from "../helpers/compare.js";
import { fnv1a, loadJs, loadReference, type LoadDump, type LoadOptions } from "../helpers/dump.js";
import { ROOT, referenceBinary, tempDir } from "../helpers/env.js";
import { egoldDirectory, egoldImage, fatTime, filesystemRecords, formattedImage, layoutBlocks, patchFitEntry, RecordsBuilder, type FsFile, type ImageLayout } from "../helpers/synthetic.js";
import { pattern, runJsWrite, runReferenceWrite, type Op, type WriteRun } from "../helpers/write.js";

const GOLDEN_DIR = path.join(ROOT, "tests", "fixtures", "synthetic");
const UPDATE     = process.env.FFSHIT_UPDATE_GOLDEN === "1";

const bytes = (...values: number[]) => Uint8Array.from(values);
const utf16 = (str: string) => Uint8Array.from(Buffer.from(str, "utf16le"));

interface Scenario {
    name: string;
    image: () => Uint8Array;
    loads: [string, LoadOptions][];
    writes?: [string, Op[]][];
}

// Taken for EGOLD_CE, the C++ library reads the model from where an uninitialized offset points,
// the rewrite from where the detection finds it
const UNDEFINED_MODEL = "forced";

function comparable(dump: LoadDump, name: string): LoadDump {
    return name === UNDEFINED_MODEL && dump.detector ? { ...dump, detector: { ...dump.detector, model: "(undefined)" } } : dump;
}

const DEFAULT_LOADS: [string, LoadOptions][] = [
    ["defaults", {}],
    ["skipping", { skipBroken: true, skipDup: true }],
    ["old search", { oldSearch: true, skipBroken: true, skipDup: true }],
    ["verbosely", { skipBroken: true, skipDup: true, verboseProcessing: true, verboseHeaders: true }],
];

// With hex dumps of every record, for the small ones
const VERBOSE_DATA: [string, LoadOptions] = ["dumping the data", { skipBroken: true, skipDup: true, verboseData: true }];

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
        { name: "odd time.txt", data: pattern(10, 7), fat: 0xFFFFFFFF },
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
            { name: bytes(0xC4, 0x72, 0x67, 0x65, 0x72, 0x2E, 0x62, 0x69, 0x6E), data: pattern(5, 12) },
            { name: bytes(0x81, 0x41, 0x8D), data: pattern(6, 13) },
            { name: bytes(0x1F, 0xD1, 0x84, 0xD0, 0xB0), data: pattern(7, 14) },
            { name: bytes(0x1F, 0xFF, 0xFE), data: pattern(8, 15) },
            { name: bytes(0x1F), data: pattern(9, 16) },
        ] : [
            { name: utf16("😀 emoji.txt"), data: pattern(5, 12) },
            { name: bytes(0x41, 0x00, 0x42), data: pattern(6, 13) },
            { name: bytes(0x00, 0xD8, 0x41, 0x00), data: pattern(7, 14) },
            { name: utf16("中中中中"), data: pattern(8, 15) },
            { name: concat(utf16("中中中中"), bytes(0, 0, 0, 0)), data: pattern(9, 16) },
            { name: concat(utf16("name"), bytes(0, 0), utf16("after")), data: pattern(10, 17) },
            { name: new Uint8Array(0), data: pattern(11, 18) },
        ]),
    ];
}

function concat(...parts: Uint8Array[]): Uint8Array {
    return Uint8Array.from(Buffer.concat(parts));
}

// A filesystem of the platform in a formatted image, its records added by the writer's layout
function recordImage(layout: ImageLayout, trees: Record<string, { files: FsFile[], idOffset?: number, rootName?: Uint8Array }>, patch?: (image: Uint8Array) => void): Uint8Array {
    const builder = new RecordsBuilder(formattedImage(layout), layout.platform);

    for (const [partition, tree] of Object.entries(trees)) {
        const records = filesystemRecords(layout.platform, tree.files, { chunkSize: 1024, idOffset: tree.idOffset, rootName: tree.rootName });

        for (const [id, data] of records) {
            builder.add(partition, id, data);
        }
    }

    const image = builder.image().slice();

    patch?.(image);

    return image;
}

const SGOLD_LAYOUT: ImageLayout      = { platform: "SGOLD", size: 0x800000, blockSize: 0x10000, partitions: [{ name: "FFS", blocks: 8 }] };
const SGOLD2_LAYOUT: ImageLayout     = { platform: "SGOLD2", size: 0x800000, blockSize: 0x10000, partitions: [{ name: "FFS_0", blocks: 8 }, { name: "FFS_C", blocks: 3 }] };
const ELKA_LAYOUT: ImageLayout       = { platform: "SGOLD2_ELKA", size: 0x800000, blockSize: 0x20000, partitions: [{ name: "FFS_0", blocks: 6 }, { name: "FFS_C", blocks: 3 }] };

// ELKA reads a header without a name as broken, so its root has one
const ELKA_ROOT_NAME = utf16("ROOT");

const WRITES: [string, Op[]][] = [
    ["writes, replaces and removes", [
        { op: "write", path: "{P}/new.bin", size: 3000, seed: 1, time: 1715953062 },
        { op: "mkdir", path: "{P}/Misc/new dir", time: 1715953062 },
        { op: "write", path: "{P}/Misc/new dir/a.txt", size: 700, seed: 2, time: 1715953062 },
        { op: "write", path: "{P}/CHUNK.BIN", size: 100, seed: 3, time: 1715953062 },
        { op: "remove", path: "{P}/one.bin" },
        { op: "remove", path: "{P}/Misc/empty dir" },
        { op: "remove", path: "{P}/Misc" },
        { op: "write", path: "{P}/Misc/Ärger.txt", size: 5, seed: 4, time: 1715953062 },
        { op: "write", path: "{P}/big.bin", size: 60000, seed: 5, time: 1715953062 },
        { op: "reload" },
        { op: "write", path: "{P}/after-reload.bin", size: 1, seed: 6, time: 1715953062 },
    ]],
    ["fills the partition", Array.from({ length: 30 }, (_, i): Op => ({ op: "write", path: `{P}/fill-${i % 4}.bin`, size: 150000 + i * 1000, seed: i, time: 1715953062 }))],
    ["grows a directory", Array.from({ length: 70 }, (_, i): Op => ({ op: "write", path: `{P}/Misc/sub/f${i}`, size: i, seed: i, time: 1715953062 }))],
];

function writesFor(partition: string): [string, Op[]][] {
    return WRITES.map(([name, ops]) => [name, ops.map((op) => "path" in op ? { ...op, path: op.path.replace("{P}", partition) } : op)]);
}

const SCENARIOS: Scenario[] = [
    {
        name: "sgold",
        image: () => recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true) } }),
        loads: [...DEFAULT_LOADS, ["in CP1251", { codepage: "CP1251" }], ["in UTF-8", { codepage: "UTF-8" }], ["of no partition", { parts: ["FFS_X"] }]],
        writes: writesFor("FFS"),
    },
    {
        name: "sgold broken",
        image: () => recordImage(SGOLD_LAYOUT, { FFS: { files: [
            { name: "fine.bin", data: pattern(100, 1) },
            { name: "no data.bin", data: pattern(100, 2), noData: true },
            { name: "broken part.bin", data: pattern(3000, 3), brokenPart: true },
            { name: "missing header", data: pattern(10, 4), headerId: 0x6666 },
            { name: "Dir", children: [{ name: "inner.bin", data: pattern(10, 5) }, { name: "missing", headerId: 0x6668 }] },
            { name: "dup.bin", data: pattern(10, 6) },
        ] } }, (image) => {
            // dup.bin's header record takes the id of fine.bin's, and the config record is deleted
            patchFitEntry(image, "SGOLD", layoutBlocks(SGOLD_LAYOUT, "FFS"), 20, "id", 10);
            patchFitEntry(image, "SGOLD", layoutBlocks(SGOLD_LAYOUT, "FFS"), 0, "flags", 0xFFFFFF00);
        }),
        loads: [...DEFAULT_LOADS, VERBOSE_DATA],
    },
    {
        name: "sgold loop",
        image: () => recordImage(SGOLD_LAYOUT, { FFS: { files: [{ name: "Loop", children: [{ name: "root again", headerId: 6 }, { name: "a.bin", data: pattern(10, 1) }] }] } }),
        loads: [VERBOSE_DATA, ["skipping", { skipBroken: true, skipDup: true }]],
    },
    {
        name: "sgold prototype",
        image: () => recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true).slice(0, 7), idOffset: 6000 } }),
        loads: DEFAULT_LOADS,
    },
    {
        name: "sgold partitions",
        image: () => recordImage({ ...SGOLD_LAYOUT, partitions: [{ name: "FFS", blocks: 4, unformatted: [1] }, { name: "FFS_B", blocks: 2, unformatted: [0, 1] }, { name: "FFS_C", blocks: 3 }, { name: "EEFULL", blocks: 1 }] }, {
            FFS: { files: [{ name: "a.bin", data: pattern(10, 1) }] },
            FFS_C: { files: [{ name: "c.bin", data: pattern(20, 2) }] },
        }),
        loads: [...DEFAULT_LOADS, ["of FFS_C", { parts: ["FFS_C"] }]],
    },
    {
        name: "sgold no root",
        image: () => recordImage(SGOLD_LAYOUT, { FFS: { files: [{ name: "a.bin", data: pattern(10, 1) }] } }, (image) => {
            patchFitEntry(image, "SGOLD", layoutBlocks(SGOLD_LAYOUT, "FFS"), 6, "id", 0x1234);
        }),
        loads: DEFAULT_LOADS,
    },
    {
        name: "sgold zero-size block",
        image: () => recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true).slice(0, 2) } }, (image) => {
            // The size of the partition's first block in the table
            image.fill(0, 0x3804, 0x3808);
        }),
        loads: DEFAULT_LOADS,
    },
    {
        name: "sgold2",
        image: () => recordImage(SGOLD2_LAYOUT, { FFS_0: { files: sampleTree(false) }, FFS_C: { files: [{ name: "cache.bin", data: pattern(2000, 1) }] } }),
        loads: [...DEFAULT_LOADS, ["of FFS_C", { parts: ["FFS_C"] }], ["taken for SGOLD", { platform: "SGOLD", skipBroken: true }], ["taken for ELKA", { platform: "SGOLD2_ELKA", skipBroken: true }]],
        writes: writesFor("FFS_0"),
    },
    {
        name: "sgold2 with an sgold table",
        image: () => {
            const image = recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true).slice(0, 5) } });

            image.set(Buffer.from("BC75"), 0x870);

            return image;
        },
        loads: DEFAULT_LOADS,
    },
    {
        name: "sgold2 elka prototype",
        image: () => {
            const image = recordImage(ELKA_LAYOUT, { FFS_0: { files: sampleTree(false).slice(0, 6), rootName: ELKA_ROOT_NAME } }, (image) => {
                image.fill(0, 0xC70, 0xC74);
            });

            image.set(Buffer.from("BC75"), 0x870);

            return image;
        },
        loads: DEFAULT_LOADS,
    },
    {
        name: "sgold without a table pointer",
        image: () => recordImage({ ...SGOLD_LAYOUT, noPointer: true, detectorFallbacks: true }, { FFS: { files: sampleTree(true).slice(0, 4) } }),
        loads: DEFAULT_LOADS,
    },
    {
        name: "sgold2 without a table pointer",
        image: () => recordImage({ ...SGOLD2_LAYOUT, noPointer: true, detectorFallbacks: true }, { FFS_0: { files: sampleTree(false).slice(0, 4) } }),
        loads: DEFAULT_LOADS,
    },
    {
        name: "sgold2 sl75",
        // The SL75's flash is mapped from 0xA4000000, its fullflash from 0xA2000000
        image: () => recordImage({ ...SGOLD2_LAYOUT, model: "SL75", size: 0x2400000, blocksAddr: 0x2100000, blockAddressOffset: 0x2000000 }, { FFS_0: { files: sampleTree(false).slice(0, 4) } }),
        loads: DEFAULT_LOADS,
    },
    {
        name: "elka without a table pointer",
        image: () => recordImage({ ...ELKA_LAYOUT, noPointer: true, detectorFallbacks: true }, { FFS_0: { files: sampleTree(false).slice(0, 4), rootName: ELKA_ROOT_NAME } }),
        loads: DEFAULT_LOADS,
    },
    {
        name: "elka",
        image: () => recordImage(ELKA_LAYOUT, {
            FFS_0: { files: [...sampleTree(false), ...[0x200, 0x201, 0x400, 0x401, 0x600, 0x601, 0x7FF, 0x800, 0xC00, 0xE00].map((size, i) => ({ name: `size-${size}.bin`, data: pattern(size, 20 + i) }))], rootName: ELKA_ROOT_NAME },
            FFS_C: { files: [{ name: "cache.bin", data: pattern(3000, 1) }], rootName: ELKA_ROOT_NAME },
        }),
        loads: [...DEFAULT_LOADS, ["taken for SGOLD2", { platform: "SGOLD2", skipBroken: true }]],
        writes: writesFor("FFS_0"),
    },
    {
        name: "elka flags",
        image: () => recordImage(ELKA_LAYOUT, { FFS_0: { files: [{ name: "deleted.bin", data: pattern(100, 1) }, { name: "strange.bin", data: pattern(3000, 2) }], rootName: ELKA_ROOT_NAME } }, (image) => {
            patchFitEntry(image, "SGOLD2_ELKA", layoutBlocks(ELKA_LAYOUT, "FFS_0"), 13, "flags", 0xFFFFFF00);
            patchFitEntry(image, "SGOLD2_ELKA", layoutBlocks(ELKA_LAYOUT, "FFS_0"), 15, "flags", 0xFFFFFFFE);
        }),
        loads: [...DEFAULT_LOADS, VERBOSE_DATA],
    },
    {
        name: "elka nameless root",
        image: () => recordImage(ELKA_LAYOUT, { FFS_0: { files: [{ name: "a.bin", data: pattern(10, 1) }] }, FFS_C: { files: [], rootName: ELKA_ROOT_NAME } }),
        loads: DEFAULT_LOADS,
    },
    {
        name: "egold",
        image: () => egoldImage({
            size: 0x800000,
            blocks: 3,
            files: [
                { id: 6, parentId: 6, name: bytes(), attributes: 0x10, fat: fatTime(2005, 1, 1, 0, 0, 0), data: egoldDirectory([7, 8, 9, 10, 11]) },
                { id: 7, parentId: 6, name: Buffer.from("a.txt"), attributes: 0x01, fat: fatTime(2005, 2, 3, 4, 5, 6), data: pattern(100, 1) },
                { id: 8, parentId: 6, name: Buffer.from("parts.bin"), attributes: 0, fat: fatTime(2006, 2, 3, 4, 5, 6), data: pattern(3000, 2), parts: [pattern(2000, 3), pattern(10, 4)] },
                { id: 9, parentId: 6, name: Buffer.from("\x1Fname.txt"), attributes: 0x06, fat: 0, data: pattern(5, 5), wtfField: true },
                { id: 10, parentId: 6, name: Buffer.from("Dir"), attributes: 0x10, fat: fatTime(2007, 2, 3, 4, 5, 6), data: egoldDirectory([12]) },
                { id: 11, parentId: 6, name: Buffer.from("empty.bin"), attributes: 0, fat: 0 },
                { id: 12, parentId: 10, name: Buffer.from("inner.bin"), attributes: 0, fat: 0, data: pattern(64, 6) },
            ],
            extraEntries: [{ blockId: 3000, size: 20, marker1: 0x00F0, marker2: 0xF000 }],
        }),
        loads: [...DEFAULT_LOADS, ["forced", { platform: "EGOLD_CE", skipBroken: true }]],
    },
    {
        name: "egold new",
        image: () => egoldImage({
            size: 0x1000000,
            blocks: 2,
            newEgold: true,
            files: [
                { id: 6, parentId: 6, name: bytes(), attributes: 0x10, fat: 0, data: egoldDirectory([7]) },
                { id: 7, parentId: 6, name: Buffer.from("a.txt"), attributes: 0, fat: fatTime(2005, 2, 3, 4, 5, 6), data: pattern(70000, 1).subarray(0, 60000) },
            ],
        }),
        loads: DEFAULT_LOADS,
    },
    {
        name: "egold broken",
        image: () => egoldImage({
            size: 0x800000,
            blocks: 2,
            files: [
                { id: 6, parentId: 6, name: bytes(), attributes: 0x10, fat: 0, data: egoldDirectory([7, 99]) },
                { id: 7, parentId: 6, name: Buffer.from("a.txt"), attributes: 0, fat: 0, data: pattern(10, 1) },
                { id: 7, parentId: 6, name: Buffer.from("again.txt"), attributes: 0, fat: 0, data: pattern(10, 2) },
            ],
            extraEntries: [{ blockId: 2, size: 20 }],
        }),
        loads: [...DEFAULT_LOADS, VERBOSE_DATA],
    },
    {
        name: "egold without root",
        image: () => egoldImage({ size: 0x800000, blocks: 1, files: [{ id: 7, parentId: 6, name: Buffer.from("a.txt"), attributes: 0, fat: 0, data: pattern(10, 1) }] }),
        loads: DEFAULT_LOADS,
    },
    {
        name: "x65flasher",
        image: () => concat(Buffer.from("FBK\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0A\x0B\x0C\x0D"), recordImage(SGOLD_LAYOUT, { FFS: { files: sampleTree(true).slice(0, 6) } })),
        loads: DEFAULT_LOADS,
        writes: writesFor("FFS").slice(0, 1),
    },
    {
        name: "unknown platform",
        image: () => new Uint8Array(0x100000),
        loads: [["defaults", {}], ["taken for SGOLD", { platform: "SGOLD" }], ["taken for EGOLD_CE", { platform: "EGOLD_CE" }]],
    },
    {
        name: "tiny",
        image: () => Uint8Array.of(0x46, 0x42),
        loads: [["defaults", {}]],
    },
    {
        name: "x65flasher header only",
        image: () => Uint8Array.from(Buffer.from("FBK\0\0\0\0\0\0\0\0\0\0\0\0\0")),
        loads: [["defaults", {}]],
    },
];

interface Golden {
    loads: Record<string, LoadDump>;
    writes: Record<string, Omit<WriteRun, "saved"> & { saved: number | undefined }>;
}

function goldenPath(scenario: Scenario): string {
    return path.join(GOLDEN_DIR, `${scenario.name.replace(/[^a-z0-9]+/gi, "-")}.json`);
}

function withSavedHash(run: WriteRun): Golden["writes"][string] {
    return { ...run, saved: run.saved ? fnv1a(run.saved) : undefined };
}

describe("Made-up fullflashes load and are written to as with the C++ library", () => {
    const reference = referenceBinary();
    const dir       = tempDir();

    for (const scenario of SCENARIOS) {
        describe(scenario.name, () => {
            const golden: Golden = fs.existsSync(goldenPath(scenario)) && !UPDATE ? JSON.parse(fs.readFileSync(goldenPath(scenario), "utf8")) : { loads: {}, writes: {} };
            const updated: Golden = { loads: {}, writes: {} };
            let image: Uint8Array | undefined;
            let file: string | undefined;

            const prepare = () => {
                if (!image) {
                    image = scenario.image();
                    file  = path.join(dir, `${scenario.name.replace(/\W+/g, "-")}.bin`);
                    fs.writeFileSync(file, image);
                }

                return { image, file: file! };
            };

            for (const [name, options] of scenario.loads) {
                it(`loads ${name}`, (t) => {
                    const { image, file } = prepare();
                    const js = loadJs(image, options).dump;

                    if (reference) {
                        const cpp = loadReference(file, options);

                        if (!cpp.dump) {
                            t.skip(`the C++ library crashed (${cpp.run.signal})`);

                            return;
                        }

                        updated.loads[name] = cpp.dump;
                        assertSame(comparable(js, name), comparable(cpp.dump, name), "The load");
                    }

                    if (!UPDATE) {
                        if (!golden.loads[name]) {
                            t.skip("no golden result: run with FFSHIT_UPDATE_GOLDEN=1 and ffshit-ref built");

                            return;
                        }

                        assertSame(comparable(js, name), comparable(golden.loads[name], name), "The load (golden)");
                    }
                });
            }

            for (const [name, ops] of scenario.writes ?? []) {
                it(name, (t) => {
                    const { image, file } = prepare();
                    const js = withSavedHash(runJsWrite(image, ops));

                    if (reference) {
                        const cpp = runReferenceWrite(file, ops);

                        if (!cpp) {
                            t.skip("the C++ library crashed");

                            return;
                        }

                        updated.writes[name] = withSavedHash(cpp);
                        assertSame(js, updated.writes[name], "The writes");
                    }

                    if (!UPDATE) {
                        if (!golden.writes[name]) {
                            t.skip("no golden result: run with FFSHIT_UPDATE_GOLDEN=1 and ffshit-ref built");

                            return;
                        }

                        assertSame(js, golden.writes[name], "The writes (golden)");
                    }
                });
            }

            if (UPDATE) {
                it("updates its golden results", { skip: !reference && "ffshit-ref is not built" }, () => {
                    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
                    fs.writeFileSync(goldenPath(scenario), `${JSON.stringify(updated, null, 1)}\n`);
                });
            }
        });
    }
});

// Writes to fullflashes with the rewrite and with the C++ library alike, and compares what came of
// it: the fullflash saved, byte for byte, what every operation threw and logged, and the tree the
// filesystem shows afterwards. The operations are those of the C++ library's write tests, and
// long random sequences of them, which get the partitions to be compacted: FFSHIT_WRITE_SEEDS of
// them per fullflash.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSame } from "../helpers/compare.js";
import { readFullflash, type TreeDir } from "../helpers/dump.js";
import { findFullflash, SKIP_NO_REFERENCE } from "../helpers/env.js";
import { firstDifferentByte, random, runJsWrite, runReferenceWrite, type Op } from "../helpers/write.js";

interface Phone {
    name: string;
    fullflash: string;
    platform: string;
    // the partition the phone shows as /Data, and a directory in it the tests write into
    partition: string;
    dir: string;
}

const PHONES: Phone[] = [
    { name: "CX70", fullflash: "CX70v56lg3.bin",     platform: "SGOLD",       partition: "FFS",   dir: "Misc" },
    { name: "SL65", fullflash: "SL65v49lg1_TIM.bin", platform: "SGOLD",       partition: "FFS",   dir: "Misc" },
    { name: "S75",  fullflash: "S75v40lg1.bin",      platform: "SGOLD2",      partition: "FFS_0", dir: "Misc" },
    { name: "EL71", fullflash: "EL71v41lg91.bin",    platform: "SGOLD2_ELKA", partition: "FFS_0", dir: "Misc" },
];

// 2024-05-17 13:37:42 UTC
const WRITE_TIME = 1715953062;

interface Context {
    phone: Phone;
    dir: (name?: string) => string;
    // The paths of the files and directories the phone came with, sorted
    files: string[];
    dirs: string[];
    partitions: string[];
}

function collect(tree: TreeDir, prefix: string, files: string[], dirs: string[], nonEmptyDirs: string[]): void {
    for (const file of tree.f) {
        if (file.s > 0) {
            files.push(`${prefix}/${file.n}`);
        }
    }

    for (const subdir of tree.d) {
        const subdirPath = `${prefix}/${subdir.n}`;

        dirs.push(subdirPath);

        if (subdir.d.length || subdir.f.length) {
            nonEmptyDirs.push(subdirPath);
        }

        collect(subdir, subdirPath, files, dirs, nonEmptyDirs);
    }
}

const SCENARIOS: [string, (ctx: Context) => Op[]][] = [
    ["saves an unchanged fullflash byte for byte", () => []],

    ["writes files of every size", (ctx) => {
        // Around the chunk sizes (1024, 2048, 4096) and ELKA's split between inline records (up to
        // 512 bytes) and the data area (in 1 KiB units)
        const sizes = [0, 1, 15, 16, 17, 100, 511, 512, 513, 1023, 1024, 1025, 1176, 1535, 1536, 1537, 2047, 2048, 2049, 3000, 4095, 4096, 4097, 10000, 70000];

        return sizes.map((size, i) => ({ op: "write", path: ctx.dir(`ffshit-${size}.bin`), size, seed: i, time: WRITE_TIME }));
    }],

    ["creates directories", (ctx) => [
        { op: "mkdir", path: ctx.dir("ffshit-dir"), time: WRITE_TIME },
        { op: "mkdir", path: ctx.dir("ffshit-dir/sub"), time: WRITE_TIME },
        { op: "write", path: ctx.dir("ffshit-dir/a.bin"), size: 3000, seed: 1, time: WRITE_TIME },
        { op: "write", path: ctx.dir("ffshit-dir/sub/b.bin"), size: 5, seed: 2, time: WRITE_TIME },
    ]],

    ["replaces a file", (ctx) => [
        { op: "write", path: ctx.dir("ffshit-replaced.bin"), size: 5000, seed: 1, time: WRITE_TIME },
        { op: "write", path: ctx.dir("ffshit-replaced.bin"), size: 300, seed: 2, time: WRITE_TIME },
    ]],

    ["replaces files of the firmware", (ctx) => ctx.files.slice(0, 20).map((file, i) => ({ op: "write", path: file, size: 777 + i * 97, seed: 3 + i, time: WRITE_TIME }))],

    ["matches names without case", (ctx) => [
        { op: "write", path: ctx.dir("ffshit-Case.bin"), size: 100, seed: 1, time: WRITE_TIME },
        { op: "write", path: ctx.dir("FFSHIT-CASE.BIN"), size: 200, seed: 2, time: WRITE_TIME },
        { op: "write", path: `${ctx.phone.partition}/${ctx.phone.dir.toUpperCase()}/ffshit-upper.bin`, size: 10, seed: 3, time: WRITE_TIME },
    ]],

    ["removes files and empty directories", (ctx) => [
        { op: "mkdir", path: ctx.dir("ffshit-empty"), time: WRITE_TIME },
        { op: "write", path: ctx.dir("ffshit-removed.bin"), size: 4000, seed: 1, time: WRITE_TIME },
        { op: "remove", path: ctx.dir("ffshit-empty") },
        { op: "remove", path: ctx.dir("ffshit-removed.bin") },
        ...ctx.files.slice(0, 10).map((file): Op => ({ op: "remove", path: file })),
    ]],

    ["refuses to remove a directory that is not empty", (ctx) => ctx.dirs.slice(0, 5).map((dir): Op => ({ op: "remove", path: dir }))],

    ["grows a directory beyond its first record", (ctx) => [
        { op: "mkdir", path: ctx.dir("ffshit-many"), time: WRITE_TIME },
        ...Array.from({ length: 100 }, (_, i): Op => ({ op: "write", path: ctx.dir(`ffshit-many/file-${String(i).padStart(3, "0")}.txt`), size: i * 13, seed: i, time: WRITE_TIME })),
        ...Array.from({ length: 40 }, (_, i): Op => ({ op: "remove", path: ctx.dir(`ffshit-many/file-${String(i * 2).padStart(3, "0")}.txt`) })),
        ...Array.from({ length: 40 }, (_, i): Op => ({ op: "write", path: ctx.dir(`ffshit-many/again-${i}.txt`), size: 50, seed: i, time: WRITE_TIME })),
    ]],

    ["reclaims the space of what it replaced", (ctx) => Array.from({ length: 48 }, (_, i): Op => ({ op: "write", path: ctx.dir("ffshit-churn.bin"), size: 1024 * 1024, seed: i, time: WRITE_TIME }))],

    ["rejects a file that does not fit", (ctx) => [
        { op: "write", path: ctx.dir("ffshit-huge.bin"), size: 64 * 1024 * 1024, seed: 1, time: WRITE_TIME },
    ]],

    ["rejects bad paths", (ctx) => {
        const firmware  = ctx.files[0];
        const partition = ctx.phone.partition;

        return [
            { op: "write", path: "FFS_NOPE/ffshit.bin", size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: "NOPE/ffshit.bin", size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: "", size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir("ffshit-missing/ffshit.bin"), size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: `${firmware}/ffshit.bin`, size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir(), size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: partition, size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: `/${partition}/`, size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir("ffshit\\x.bin"), size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir("ffshit:x.bin"), size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir("ffshit\tx.bin"), size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir("."), size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir(".."), size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir("x".repeat(256)), size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir("y".repeat(243)), size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir("z".repeat(242)), size: 1, seed: 1, time: WRITE_TIME },
            { op: "write", path: ctx.dir("ф".repeat(200)), size: 1, seed: 1, time: WRITE_TIME },
            { op: "mkdir", path: ctx.dir(), time: WRITE_TIME },
            { op: "mkdir", path: firmware, time: WRITE_TIME },
            { op: "remove", path: ctx.dir("ffshit-missing.bin") },
            { op: "remove", path: partition },
            { op: "remove", path: `${firmware}/x` },
        ];
    }],

    ["writes names beyond ASCII", (ctx) => ["ffshit-Ärger.bin", "ffshit-файл.bin", "ffshit-中文.bin", "ffshit-😀.bin", "ffshit-€ÿ.bin", "ffshit- .bin"]
        .map((name, i): Op => ({ op: "write", path: ctx.dir(name), size: 100, seed: i, time: WRITE_TIME }))],

    ["folds the case of what the firmware folds", (ctx) => [
        { op: "write", path: ctx.dir("ffshit-ärger.bin"), size: 100, seed: 1, time: WRITE_TIME },
        { op: "write", path: ctx.dir("ffshit-Ärger.bin"), size: 200, seed: 2, time: WRITE_TIME },
        { op: "write", path: ctx.dir("ffshit-ФАЙЛ.bin"), size: 300, seed: 3, time: WRITE_TIME },
        { op: "write", path: ctx.dir("ffshit-файл.bin"), size: 400, seed: 4, time: WRITE_TIME },
        { op: "remove", path: ctx.dir("FFSHIT-ÄRGER.BIN") },
    ]],

    ["keeps SGOLD names in the phone's codepage", (ctx) => [
        { op: "codepage", codepage: "CP1251" },
        { op: "write", path: ctx.dir("ffshit-файл.bin"), size: 100, seed: 1, time: WRITE_TIME },
        { op: "write", path: ctx.dir("ffshit-Ärger.bin"), size: 100, seed: 2, time: WRITE_TIME },
        { op: "codepage", codepage: "windows-1250" },
        { op: "write", path: ctx.dir("ffshit-Łódź.bin"), size: 100, seed: 3, time: WRITE_TIME },
        { op: "codepage", codepage: "NO-SUCH-CODEPAGE" },
        { op: "write", path: ctx.dir("ffshit-ôàéë.bin"), size: 100, seed: 4, time: WRITE_TIME },
    ]],

    ["writes into every partition", (ctx) => ctx.partitions.map((partition, i): Op => ({ op: "write", path: `${partition}/ffshit-${partition}.bin`, size: 10000, seed: i, time: WRITE_TIME }))],

    ["keeps FAT timestamps in range", (ctx) => [
        { op: "write", path: ctx.dir("ffshit-1970.bin"), size: 1, seed: 1, time: 0 },
        { op: "write", path: ctx.dir("ffshit-1979.bin"), size: 1, seed: 1, time: 315532799 },
        { op: "write", path: ctx.dir("ffshit-1980.bin"), size: 1, seed: 1, time: 315532800 + 86400 },
        { op: "write", path: ctx.dir("ffshit-odd.bin"), size: 1, seed: 1, time: WRITE_TIME + 1 },
        { op: "write", path: ctx.dir("ffshit-2107.bin"), size: 1, seed: 1, time: 4354819199 - 86400 },
        { op: "write", path: ctx.dir("ffshit-2200.bin"), size: 1, seed: 1, time: 7258118400 },
        { op: "write", path: ctx.dir("ffshit-before.bin"), size: 1, seed: 1, time: -1000000 },
        { op: "mkdir", path: ctx.dir("ffshit-dir-2200"), time: 7258118400 },
    ]],

    ["shows the changes to a filesystem loaded anew", (ctx) => [
        { op: "write", path: ctx.dir("ffshit-unsaved.bin"), size: 3000, seed: 1, time: WRITE_TIME },
        { op: "reload" },
        { op: "write", path: ctx.dir("ffshit-after-reload.bin"), size: 5000, seed: 2, time: WRITE_TIME },
        { op: "remove", path: ctx.dir("ffshit-unsaved.bin") },
    ]],
];

// Random operations on a few names, of sizes around the chunk sizes up to a megabyte
function randomOps(ctx: Context, seed: number, count: number): Op[] {
    const next  = random(seed);
    const pick  = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const dirs  = [ctx.dir(), ctx.dir("ffshit-r1"), ctx.dir("ffshit-r1/ffshit-r2"), ctx.dir("ffshit-R3"), ...ctx.dirs.slice(0, 3)];
    const names = ["a.bin", "B.bin", "b.BIN", "long name with spaces.txt", "ж.txt", "Ä.dat", "x", "ffshit-r1", "ffshit-R3", "c.jpg"];
    const ops: Op[] = [];

    for (let i = 0; i < count; ++i) {
        const roll = next();
        const path = `${pick(dirs)}/${pick(names)}`;

        if (roll < 0.55) {
            const sizes = [0, 1, 511, 512, 513, 1024, 1025, 2048, 4096, 4097];
            const size  = next() < 0.5 ? pick(sizes) : next() < 0.9 ? Math.floor(next() * 20000) : Math.floor(next() * 1500000);

            ops.push({ op: "write", path, size, seed: i, time: WRITE_TIME + i * 7 });
        } else if (roll < 0.7) {
            ops.push({ op: "mkdir", path: pick(dirs.slice(1, 4)), time: WRITE_TIME + i });
        } else if (roll < 0.75) {
            ops.push({ op: "write", path: pick(ctx.files.slice(0, 30)), size: Math.floor(next() * 9000), seed: i, time: WRITE_TIME });
        } else if (roll < 0.97) {
            ops.push({ op: "remove", path: next() < 0.2 ? pick(dirs.slice(1, 4)) : path });
        } else {
            ops.push({ op: "reload" });
        }
    }

    return ops;
}

function compareRuns(file: string, ops: Op[]): void {
    const reference = runReferenceWrite(file, ops);

    assert.ok(reference, "the C++ library crashed");

    const js = runJsWrite(readFullflash(file), ops);

    assertSame(js.load, reference.load, "The load");

    for (let i = 0; i < ops.length; ++i) {
        assertSame(js.results[i], reference.results[i], `Operation ${i} (${JSON.stringify(ops[i]).slice(0, 200)})`);
    }

    assertSame(js.tree, reference.tree, "The tree after the operations");

    assert.ok(js.saved && reference.saved, "a fullflash was not saved");

    const different = firstDifferentByte(js.saved, reference.saved);

    assert.equal(different, undefined, `The saved fullflashes differ at 0x${different?.toString(16)}`);
}

const phones = PHONES.map((phone) => ({ phone, file: findFullflash(phone.fullflash) }));

describe("Writing matches the C++ library", { skip: SKIP_NO_REFERENCE }, () => {
    for (const { phone, file } of phones) {
        describe(phone.name, { skip: !file && `${phone.fullflash} not found: set FFSHIT_TEST_FULLFLASHES` }, () => {
            const context = (): Context => {
                const reference = runReferenceWrite(file!, []);
                const partitions = reference!.load.tree!.d;
                const files: string[] = [];
                const dirs: string[] = [];
                const nonEmptyDirs: string[] = [];
                const partitionTree = partitions.find((partition) => partition.n === phone.partition)!;

                collect(partitionTree, phone.partition, files, dirs, nonEmptyDirs);

                return {
                    phone,
                    dir: (name?: string) => `${phone.partition}/${phone.dir}${name === undefined ? "" : `/${name}`}`,
                    files: files.sort(),
                    dirs: nonEmptyDirs.sort(),
                    partitions: partitions.map((partition) => partition.n),
                };
            };

            let ctx: Context | undefined;

            for (const [name, scenario] of SCENARIOS) {
                it(name, () => {
                    ctx ??= context();

                    compareRuns(file!, scenario(ctx));
                });
            }

            for (let seed = 1; seed <= Number(process.env.FFSHIT_WRITE_SEEDS ?? 3); ++seed) {
                it(`runs random operations, seed ${seed}`, () => {
                    ctx ??= context();

                    compareRuns(file!, randomOps(ctx, seed * 1000 + phone.name.length, 250));
                });
            }
        });
    }
});

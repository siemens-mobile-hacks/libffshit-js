// Writes to the filesystem of a fullflash, saves it, reads it back and checks that the files are
// there and that nothing else changed. On the phones' fullflashes where there are any, and always on
// made-up ones.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { FFS, FFSError, type FFSTreeEntry, type OpenOptions, type Platform } from "../src/index.js";
import { equalBytes, pattern } from "./helpers/data.js";
import { NO_FULLFLASHES, readFullflash } from "./helpers/fullflashes.js";
import { fatTime, filesystemRecords, RecordsBuilder, type FsFile, type ImageLayout } from "./helpers/synthetic.js";

interface Phone {
    name: string;
    image: () => Uint8Array | undefined;
    platform: Platform;
    // The partition the phone shows as /Data, and a directory in it the tests write into
    partition: string;
    dir: string;
    // What a partition holds several times over
    churnSize: number;
    options?: OpenOptions;
}

// SGOLD and EGOLD keep names of 8-bit characters, and fold only their ASCII letters
function eightBit(platform: Platform): boolean {
    return platform === "SGOLD" || platform === "EGOLD_CE";
}

function syntheticPhone(platform: Platform, partition: string, headerSize?: number): Phone {
    const layout: ImageLayout = {
        platform,
        size: 0x1000000,
        blockSize: platform === "SGOLD2_ELKA" ? 0x20000 : 0x10000,
        partitions: [{ name: partition, blocks: platform === "SGOLD2_ELKA" ? 16 : 32 }, { name: "FFS_C", blocks: 4 }],
    };

    const files: FsFile[] = [
        { name: "Misc", children: [{ name: "firmware.txt", data: pattern(1500, 1) }, { name: "Sub", children: [{ name: "x.bin", data: pattern(10, 2) }] }] },
        { name: "Pictures", children: [{ name: "a.jpg", data: pattern(5000, 3), fat: fatTime(2006, 1, 2, 3, 4, 6) }] },
    ];

    return {
        name: `made-up ${platform}${headerSize ? ` with ${headerSize}-byte headers` : ""}`,
        platform,
        partition,
        dir: "Misc",
        churnSize: 256 * 1024,
        options: platform === "EGOLD_CE" ? { experimentalEgoldWrites: true } : {},
        image: () => {
            const builder = new RecordsBuilder(layout);

            for (const [name, tree] of [[partition, files], ["FFS_C", [{ name: "c.bin", data: pattern(100, 4) }]]] as const) {
                for (const [id, data] of filesystemRecords(platform, [...tree], { chunkSize: eightBit(platform) ? 1024 : 2048, headerSize })) {
                    builder.add(name, id, data);
                }
            }

            return builder.build();
        },
    };
}

function realPhone(name: string, file: string, platform: Platform, partition: string): Phone {
    return { name, platform, partition, dir: "Misc", churnSize: 1024 * 1024, image: () => readFullflash(file) };
}

const PHONES: Phone[] = [
    realPhone("CX70", "CX70v56lg3.bin", "SGOLD", "FFS"),
    realPhone("SL65", "SL65v49lg1_TIM.bin", "SGOLD", "FFS"),
    realPhone("S75", "S75v40lg1.bin", "SGOLD2", "FFS_0"),
    realPhone("EL71", "EL71v41lg91.bin", "SGOLD2_ELKA", "FFS_0"),
    syntheticPhone("SGOLD", "FFS"),
    syntheticPhone("SGOLD2", "FFS_0"),
    syntheticPhone("SGOLD2_ELKA", "FFS_0"),
    syntheticPhone("EGOLD_CE", "FFS"),
    syntheticPhone("EGOLD_CE", "FFS", 20),
];

const WRITE_TIME = new Date(2024, 4, 17, 13, 37, 42);

// What a file or directory looked like: its content (empty for a directory) and timestamp
interface Entry {
    isDirectory: boolean;
    data: string;
    timestamp: number;
}

// Every file and directory, by path
type Tree = Map<string, Entry>;

function snapshot(ffs: FFS): Tree {
    const tree: Tree = new Map();

    const add = (entry: FFSTreeEntry): void => {
        for (const child of entry.children ?? []) {
            tree.set(child.path, {
                isDirectory:    child.isDirectory,
                data:           child.isDirectory ? "" : Buffer.from(ffs.readFile(child.path)).toString("hex"),
                timestamp:      child.timestamp.getTime(),
            });

            add(child);
        }
    };

    add(ffs.tree());

    return tree;
}

function fileEntry(data: Uint8Array): Entry {
    return { isDirectory: false, data: Buffer.from(data).toString("hex"), timestamp: WRITE_TIME.getTime() };
}

function dirEntry(): Entry {
    return { isDirectory: true, data: "", timestamp: WRITE_TIME.getTime() };
}

// Lists the differences instead of dumping two trees of a thousand files
function expectTree(actual: Tree, expected: Tree): void {
    const differences: string[] = [];

    for (const [path, entry] of expected) {
        const found = actual.get(path);

        if (!found) {
            differences.push(`missing:    ${path}`);
        } else if (found.isDirectory !== entry.isDirectory || found.data !== entry.data || found.timestamp !== entry.timestamp) {
            differences.push(`different:  ${path} (${found.data.length / 2} bytes at ${found.timestamp}, expected ${entry.data.length / 2} bytes at ${entry.timestamp})`);
        }
    }

    for (const path of actual.keys()) {
        if (!expected.has(path)) {
            differences.push(`unexpected: ${path}`);
        }
    }

    assert.deepEqual(differences.slice(0, 20), [], `${differences.length} differences`);
}

// The first file with content in the partition
function firmwareFile(tree: Tree, partition: string): string {
    return [...tree.keys()].sort().find((path) => path.startsWith(`/${partition}/`) && tree.get(path)!.data !== "") ?? "";
}

// The first directory in the partition with something in it
function firmwareDirectory(tree: Tree, partition: string): string {
    const paths = [...tree.keys()].sort();

    return paths.find((path) => path.startsWith(`/${partition}/`) && tree.get(path)!.isDirectory && paths.some((other) => other.startsWith(`${path}/`))) ?? "";
}

for (const phone of PHONES) {
    const image = phone.image();

    describe(`Writing to ${phone.name}`, { skip: !image && NO_FULLFLASHES }, () => {
        let ffs: FFS;

        const dirPath       = (name?: string) => `/${phone.partition}/${phone.dir}${name ? `/${name}` : ""}`;
        const write         = (path: string, data: Uint8Array) => ffs.writeFile(path, data, WRITE_TIME);
        const reopen        = (codepage?: string) => FFS.open(ffs.save(), { ...phone.options, codepage, strict: true });
        const unchanged     = () => assert.ok(equalBytes(ffs.save(), image!), "the fullflash changed");

        beforeEach(() => {
            ffs = FFS.open(image!, { ...phone.options, strict: true });

            assert.equal(ffs.platform, phone.platform);
            assert.ok(ffs.stat(dirPath())?.isDirectory, dirPath());
        });

        it("saves an unchanged fullflash byte for byte", () => {
            unchanged();
        });

        it("leaves the buffer it was given alone", () => {
            const copy = image!.slice();

            write(dirPath("sie-ffs.bin"), pattern(5000, 1));

            assert.ok(equalBytes(image!, copy));
        });

        it("writes files of every size", () => {
            // Around the chunk sizes (1024, 2048, 4096) and ELKA's split between inline records (up
            // to 512 bytes) and the data area (in 1 KiB units)
            const sizes     = [0, 1, 15, 16, 17, 100, 511, 512, 513, 1023, 1024, 1025, 1176, 1535, 1536, 1537, 2047, 2048, 2049, 3000, 4095, 4096, 4097, 10000, 70000];
            const expected  = snapshot(ffs);

            sizes.forEach((size, i) => {
                const path = dirPath(`sie-ffs-${size}.bin`);
                const data = pattern(size, i);

                write(path, data);
                expected.set(path, fileEntry(data));
            });

            expectTree(snapshot(ffs), expected);
            expectTree(snapshot(reopen()), expected);
        });

        it("creates directories", () => {
            const expected = snapshot(ffs);

            ffs.mkdir(dirPath("sie-ffs-dir"), WRITE_TIME);
            ffs.mkdir(dirPath("sie-ffs-dir/sub"), WRITE_TIME);
            write(dirPath("sie-ffs-dir/a.bin"), pattern(3000, 1));
            write(dirPath("sie-ffs-dir/sub/b.bin"), pattern(5, 2));

            expected.set(dirPath("sie-ffs-dir"), dirEntry());
            expected.set(dirPath("sie-ffs-dir/sub"), dirEntry());
            expected.set(dirPath("sie-ffs-dir/a.bin"), fileEntry(pattern(3000, 1)));
            expected.set(dirPath("sie-ffs-dir/sub/b.bin"), fileEntry(pattern(5, 2)));

            expectTree(snapshot(reopen()), expected);
        });

        it("replaces a file", () => {
            const expected = snapshot(ffs);

            write(dirPath("sie-ffs-replaced.bin"), pattern(5000, 1));
            write(dirPath("sie-ffs-replaced.bin"), pattern(300, 2));

            expected.set(dirPath("sie-ffs-replaced.bin"), fileEntry(pattern(300, 2)));

            expectTree(snapshot(reopen()), expected);
        });

        it("replaces a file of the firmware", () => {
            const expected  = snapshot(ffs);
            const path      = firmwareFile(expected, phone.partition);

            assert.ok(path);

            write(path, pattern(777, 3));
            expected.set(path, fileEntry(pattern(777, 3)));

            expectTree(snapshot(reopen()), expected);
        });

        it("matches names without case", () => {
            const expected = snapshot(ffs);

            write(dirPath("sie-ffs-Case.bin"), pattern(100, 1));
            write(dirPath("SIE-FFS-CASE.BIN"), pattern(200, 2));

            // Under the name it was written with last
            expected.set(dirPath("SIE-FFS-CASE.BIN"), fileEntry(pattern(200, 2)));

            expectTree(snapshot(reopen()), expected);
        });

        it("removes files and empty directories", () => {
            const expected = snapshot(ffs);
            const firmware = firmwareFile(expected, phone.partition);

            assert.ok(firmware);

            ffs.mkdir(dirPath("sie-ffs-empty"), WRITE_TIME);
            write(dirPath("sie-ffs-removed.bin"), pattern(4000, 1));

            ffs.remove(dirPath("sie-ffs-empty"));
            ffs.remove(dirPath("sie-ffs-removed.bin"));
            ffs.remove(firmware);

            expected.delete(firmware);

            expectTree(snapshot(reopen()), expected);
        });

        it("refuses to remove a directory that is not empty", () => {
            const dir = firmwareDirectory(snapshot(ffs), phone.partition);

            assert.ok(dir);
            assert.throws(() => ffs.remove(dir), { name: "FFSError", message: `${dir}: directory not empty` });

            unchanged();
        });

        it("grows a directory beyond its first record", () => {
            const expected = snapshot(ffs);

            ffs.mkdir(dirPath("sie-ffs-many"), WRITE_TIME);
            expected.set(dirPath("sie-ffs-many"), dirEntry());

            for (let i = 0; i < 100; ++i) {
                const path = dirPath(`sie-ffs-many/file-${String(i).padStart(3, "0")}.txt`);
                const data = pattern(i * 13, i);

                write(path, data);
                expected.set(path, fileEntry(data));
            }

            expectTree(snapshot(reopen()), expected);
        });

        it("reclaims the space of what it replaced", () => {
            const expected = snapshot(ffs);

            // More than any of these partitions holds, so the space of the replaced copies has to
            // be reclaimed
            for (let i = 0; i < 48; ++i) {
                write(dirPath("sie-ffs-churn.bin"), pattern(phone.churnSize, i));
            }

            expected.set(dirPath("sie-ffs-churn.bin"), fileEntry(pattern(phone.churnSize, 47)));

            expectTree(snapshot(reopen()), expected);
        });

        it("rejects a file that does not fit", () => {
            // Out of space, or on the made-up ones out of ids first
            assert.throws(() => write(dirPath("sie-ffs-huge.bin"), pattern(64 * 1024 * 1024, 1)), FFSError);

            unchanged();
        });

        it("rejects bad paths", () => {
            const firmware = firmwareFile(snapshot(ffs), phone.partition);

            assert.ok(firmware);

            for (const path of ["/FFS_NOPE/sie-ffs.bin", dirPath("sie-ffs-missing/sie-ffs.bin"), `${firmware}/sie-ffs.bin`, dirPath(), `/${phone.partition}`, dirPath("sie-ffs\\x.bin"), dirPath("x".repeat(256))]) {
                assert.throws(() => write(path, pattern(1, 1)), FFSError, path);
            }

            assert.throws(() => ffs.mkdir(dirPath(), WRITE_TIME), FFSError);
            assert.throws(() => ffs.mkdir(firmware, WRITE_TIME), FFSError);
            assert.throws(() => ffs.remove(dirPath("sie-ffs-missing.bin")), FFSError);
            assert.throws(() => ffs.remove(`/${phone.partition}`), FFSError);

            unchanged();
        });

        it("writes names beyond ASCII", () => {
            const expected = snapshot(ffs);

            // On SGOLD in the codepage, and in UTF-8 when the codepage lacks a character. A U+FEFF is
            // no byte order mark.
            for (const name of ["sie-ffs-Ärger.bin", "sie-ffs-файл.bin", "sie-ffs-中文.bin", "sie-ffs-😀.bin", "﻿sie-ffs-bom.bin"]) {
                const data = pattern(100, Buffer.byteLength(name));

                write(dirPath(name), data);
                expected.set(dirPath(name), fileEntry(data));
            }

            expectTree(snapshot(reopen()), expected);
        });

        it("folds the case of what the firmware folds", () => {
            const expected = snapshot(ffs);

            write(dirPath("sie-ffs-ärger.bin"), pattern(100, 1));
            write(dirPath("sie-ffs-Ärger.bin"), pattern(200, 2));

            // SGOLD and EGOLD fold ASCII letters only: both files are there
            if (eightBit(phone.platform)) {
                expected.set(dirPath("sie-ffs-ärger.bin"), fileEntry(pattern(100, 1)));
            }

            expected.set(dirPath("sie-ffs-Ärger.bin"), fileEntry(pattern(200, 2)));

            expectTree(snapshot(reopen()), expected);
        });

        it("keeps 8-bit names in the phone's codepage", { skip: !eightBit(phone.platform) && "only SGOLD and EGOLD names are 8-bit" }, () => {
            ffs = FFS.open(image!, { ...phone.options, codepage: "CP1251" });

            write(dirPath("sie-ffs-файл.bin"), pattern(100, 1));
            // CP1251 has no Ä
            write(dirPath("sie-ffs-Ärger.bin"), pattern(100, 2));

            const cp1251 = reopen("CP1251");

            assert.ok(cp1251.stat(dirPath("sie-ffs-файл.bin")));
            assert.ok(cp1251.stat(dirPath("sie-ffs-Ärger.bin")));

            // The bytes of "файл" in CP1251 are "ôàéë" in CP1252, a name in UTF-8 reads the same in both
            const cp1252 = reopen("CP1252");

            assert.ok(cp1252.stat(dirPath("sie-ffs-ôàéë.bin")));
            assert.ok(cp1252.stat(dirPath("sie-ffs-Ärger.bin")));
        });

        it("writes into every partition", () => {
            const expected = snapshot(ffs);

            for (const partition of ffs.readDir("/")) {
                const path = `${partition.path}/sie-ffs-${partition.name}.bin`;

                write(path, pattern(10000, 1));
                expected.set(path, fileEntry(pattern(10000, 1)));
            }

            expectTree(snapshot(reopen()), expected);
        });
    });
}

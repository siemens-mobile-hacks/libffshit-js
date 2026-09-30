// The C++ library's write_test.cpp: writes to the filesystem of a fullflash, saves it, reads it back
// and checks that the files are there and that nothing else changed. On the phones' fullflashes
// where there are any, and always on made-up ones.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { BaseError, buildFilesystem, type Directory, type Filesystem, FullFlash, type PlatformType } from "../src/index.js";
import { findFullflash } from "./helpers/env.js";
import { readFullflash } from "./helpers/dump.js";
import { fatTime, filesystemRecords, formattedImage, RecordsBuilder, type FsFile, type ImageLayout } from "./helpers/synthetic.js";
import { pattern } from "./helpers/write.js";

interface Phone {
    name: string;
    image: () => Uint8Array | undefined;
    platform: PlatformType;
    // the partition the phone shows as /Data, and a directory in it the tests write into
    partition: string;
    dir: string;
    // what a partition holds several times over
    churnSize: number;
}

function syntheticPhone(platform: "SGOLD" | "SGOLD2" | "SGOLD2_ELKA", partition: string): Phone {
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
        name: `made-up ${platform}`,
        platform,
        partition,
        dir: "Misc",
        churnSize: 256 * 1024,
        image: () => {
            const builder  = new RecordsBuilder(formattedImage(layout), platform);
            const rootName = platform === "SGOLD2_ELKA" ? Uint8Array.from(Buffer.from("ROOT", "utf16le")) : undefined;

            for (const [name, tree] of [[partition, files], ["FFS_C", [{ name: "c.bin", data: pattern(100, 4) }]]] as const) {
                for (const [id, data] of filesystemRecords(platform, [...tree], { chunkSize: platform === "SGOLD" ? 1024 : 2048, rootName })) {
                    builder.add(name, id, data);
                }
            }

            return builder.image().slice();
        },
    };
}

function realPhone(name: string, file: string, platform: PlatformType, partition: string): Phone {
    return {
        name,
        platform,
        partition,
        dir: "Misc",
        churnSize: 1024 * 1024,
        image: () => {
            const path = findFullflash(file);

            return path ? readFullflash(path) : undefined;
        },
    };
}

const PHONES: Phone[] = [
    realPhone("CX70", "CX70v56lg3.bin", "SGOLD", "FFS"),
    realPhone("SL65", "SL65v49lg1_TIM.bin", "SGOLD", "FFS"),
    realPhone("S75", "S75v40lg1.bin", "SGOLD2", "FFS_0"),
    realPhone("EL71", "EL71v41lg91.bin", "SGOLD2_ELKA", "FFS_0"),
    syntheticPhone("SGOLD", "FFS"),
    syntheticPhone("SGOLD2", "FFS_0"),
    syntheticPhone("SGOLD2_ELKA", "FFS_0"),
];

const WRITE_TIME = new Date(2024, 4, 17, 13, 37, 42);

interface Loaded {
    fullflash: FullFlash;
    filesystem: Filesystem;
}

// SGOLD file names are read in the codepage
function load(data: Uint8Array, codepage = "CP1252"): Loaded {
    const fullflash = new FullFlash(data);

    fullflash.loadPartitions();

    const partitions = fullflash.getPartitions()!;
    const filesystem = buildFilesystem(partitions.getFsPlatform(), partitions);

    filesystem.setCodepage(codepage);
    filesystem.load();

    return { fullflash, filesystem };
}

// What a file or directory looked like: its content (empty for a directory) and timestamp
interface Entry {
    isDirectory: boolean;
    data: string;
    timestamp: number;
}

// Every file and directory under the root, by path, e.g. "FFS_0/Misc/photo.jpg"
type Tree = Map<string, Entry>;

function addEntry(tree: Tree, path: string, entry: Entry): void {
    let key = path;

    for (let copy = 2; tree.has(key); ++copy) {
        key = `${path}#${copy}`;
    }

    tree.set(key, entry);
}

function snapshotDir(tree: Tree, dir: Directory, path: string): void {
    for (const file of dir.getFiles()) {
        addEntry(tree, `${path}/${file.getName()}`, { isDirectory: false, data: Buffer.from(file.getData()).toString("hex"), timestamp: file.getTimestamp().getTime() });
    }

    for (const subdir of dir.getSubdirs()) {
        const subdirPath = `${path}/${subdir.getName()}`;

        addEntry(tree, subdirPath, { isDirectory: true, data: "", timestamp: subdir.getTimestamp().getTime() });
        snapshotDir(tree, subdir, subdirPath);
    }
}

function snapshot(filesystem: Filesystem): Tree {
    const tree: Tree = new Map();

    for (const partition of filesystem.getRoot().getSubdirs()) {
        addEntry(tree, partition.getName(), { isDirectory: true, data: "", timestamp: partition.getTimestamp().getTime() });
        snapshotDir(tree, partition, partition.getName());
    }

    return tree;
}

function fileEntry(data: Uint8Array): Entry {
    return { isDirectory: false, data: Buffer.from(data).toString("hex"), timestamp: WRITE_TIME.getTime() };
}

function dirEntry(): Entry {
    return { isDirectory: true, data: "", timestamp: WRITE_TIME.getTime() };
}

function findDirectory(filesystem: Filesystem, path: string): Directory | undefined {
    let dir: Directory | undefined = filesystem.getRoot();

    for (const part of path.split("/").filter(Boolean)) {
        dir = dir?.getSubdirs().find((subdir) => subdir.getName() === part);
    }

    return dir;
}

function findFile(filesystem: Filesystem, path: string) {
    const parts = path.split("/").filter(Boolean);
    const name  = parts.pop();

    return findDirectory(filesystem, parts.join("/"))?.getFiles().find((file) => file.getName() === name);
}

// Lists the differences instead of dumping two trees of a thousand files
function expectTree(actual: Tree, expected: Tree): void {
    const differences: string[] = [];

    for (const [path, entry] of expected) {
        const found = actual.get(path);

        if (!found) {
            differences.push(`missing:   ${path}`);
        } else if (found.isDirectory !== entry.isDirectory || found.data !== entry.data || found.timestamp !== entry.timestamp) {
            differences.push(`different: ${path} (${found.data.length / 2} bytes at ${found.timestamp}, expected ${entry.data.length / 2} bytes at ${entry.timestamp})`);
        }
    }

    for (const path of actual.keys()) {
        if (!expected.has(path)) {
            differences.push(`unexpected: ${path}`);
        }
    }

    assert.deepEqual(differences.slice(0, 20), [], `${differences.length} differences`);
}

// The first file with content somewhere in the partition
function firmwareFile(tree: Tree, partition: string): string {
    return [...tree.keys()].sort().find((path) => {
        const entry = tree.get(path)!;

        return path.startsWith(`${partition}/`) && !entry.isDirectory && entry.data !== "" && !path.includes("#");
    }) ?? "";
}

// The first directory in the partition with something in it
function firmwareDirectory(tree: Tree, partition: string): string {
    const paths = [...tree.keys()].sort();

    return paths.find((path) => path.startsWith(`${partition}/`) && tree.get(path)!.isDirectory && paths.some((other) => other.startsWith(`${path}/`))) ?? "";
}

for (const phone of PHONES) {
    const image = phone.image();

    describe(`Writing to ${phone.name}`, { skip: !image && "not found: set FFSHIT_TEST_FULLFLASHES" }, () => {
        let original: Loaded;

        const dirPath = (name?: string) => `${phone.partition}/${phone.dir}${name ? `/${name}` : ""}`;
        const write   = (path: string, data: Uint8Array) => original.filesystem.writeFile(path, data, WRITE_TIME);
        const saveAndReload = (codepage?: string) => load(original.fullflash.save(), codepage);

        const expectUnchangedOnDisk = () => {
            assert.ok(Buffer.from(original.fullflash.save()).equals(Buffer.from(image!)), "the fullflash changed");
        };

        beforeEach(() => {
            original = load(image!);

            assert.equal(original.fullflash.getPartitions()!.getFsPlatform(), phone.platform);
            assert.ok(findDirectory(original.filesystem, dirPath()), dirPath());
        });

        it("saves an unchanged fullflash byte for byte", () => {
            expectUnchangedOnDisk();
        });

        it("leaves the buffer it was given alone", () => {
            const copy = image!.slice();

            write(dirPath("ffshit.bin"), pattern(5000, 1));

            assert.ok(Buffer.from(image!).equals(Buffer.from(copy)));
        });

        it("writes files of every size", () => {
            // Around the chunk sizes (1024, 2048, 4096) and ELKA's split between inline records (up
            // to 512 bytes) and the data area (in 1 KiB units)
            const sizes     = [0, 1, 15, 16, 17, 100, 511, 512, 513, 1023, 1024, 1025, 1176, 1535, 1536, 1537, 2047, 2048, 2049, 3000, 4095, 4096, 4097, 10000, 70000];
            const expected  = snapshot(original.filesystem);

            sizes.forEach((size, i) => {
                const path = dirPath(`ffshit-${size}.bin`);
                const data = pattern(size, i);

                write(path, data);
                expected.set(path, fileEntry(data));
            });

            expectTree(snapshot(saveAndReload().filesystem), expected);
        });

        it("creates directories", () => {
            const expected = snapshot(original.filesystem);

            original.filesystem.createDirectory(dirPath("ffshit-dir"), WRITE_TIME);
            original.filesystem.createDirectory(dirPath("ffshit-dir/sub"), WRITE_TIME);
            write(dirPath("ffshit-dir/a.bin"), pattern(3000, 1));
            write(dirPath("ffshit-dir/sub/b.bin"), pattern(5, 2));

            expected.set(dirPath("ffshit-dir"), dirEntry());
            expected.set(dirPath("ffshit-dir/sub"), dirEntry());
            expected.set(dirPath("ffshit-dir/a.bin"), fileEntry(pattern(3000, 1)));
            expected.set(dirPath("ffshit-dir/sub/b.bin"), fileEntry(pattern(5, 2)));

            const reloaded = saveAndReload();

            expectTree(snapshot(reloaded.filesystem), expected);
            assert.ok(findDirectory(reloaded.filesystem, dirPath("ffshit-dir"))?.getAttributes().isDirectory());
        });

        it("replaces a file", () => {
            const expected = snapshot(original.filesystem);

            write(dirPath("ffshit-replaced.bin"), pattern(5000, 1));
            write(dirPath("ffshit-replaced.bin"), pattern(300, 2));

            expected.set(dirPath("ffshit-replaced.bin"), fileEntry(pattern(300, 2)));

            expectTree(snapshot(saveAndReload().filesystem), expected);
        });

        it("replaces a file of the firmware", () => {
            const expected  = snapshot(original.filesystem);
            const path      = firmwareFile(expected, phone.partition);

            assert.ok(path);

            write(path, pattern(777, 3));
            expected.set(path, fileEntry(pattern(777, 3)));

            expectTree(snapshot(saveAndReload().filesystem), expected);
        });

        it("matches names without case", () => {
            const expected = snapshot(original.filesystem);

            write(dirPath("ffshit-Case.bin"), pattern(100, 1));
            write(dirPath("FFSHIT-CASE.BIN"), pattern(200, 2));

            expected.set(dirPath("FFSHIT-CASE.BIN"), fileEntry(pattern(200, 2)));

            expectTree(snapshot(saveAndReload().filesystem), expected);
        });

        it("removes files and empty directories", () => {
            const expected = snapshot(original.filesystem);
            const firmware = firmwareFile(expected, phone.partition);

            assert.ok(firmware);

            original.filesystem.createDirectory(dirPath("ffshit-empty"), WRITE_TIME);
            write(dirPath("ffshit-removed.bin"), pattern(4000, 1));

            original.filesystem.remove(dirPath("ffshit-empty"));
            original.filesystem.remove(dirPath("ffshit-removed.bin"));
            original.filesystem.remove(firmware);

            expected.delete(firmware);

            expectTree(snapshot(saveAndReload().filesystem), expected);
        });

        it("refuses to remove a directory that is not empty", () => {
            const dir = firmwareDirectory(snapshot(original.filesystem), phone.partition);

            assert.ok(dir);
            assert.throws(() => original.filesystem.remove(dir), BaseError);

            expectUnchangedOnDisk();
        });

        it("grows a directory beyond its first record", () => {
            const expected = snapshot(original.filesystem);

            original.filesystem.createDirectory(dirPath("ffshit-many"), WRITE_TIME);
            expected.set(dirPath("ffshit-many"), dirEntry());

            for (let i = 0; i < 100; ++i) {
                const path = dirPath(`ffshit-many/file-${String(i).padStart(3, "0")}.txt`);
                const data = pattern(i * 13, i);

                write(path, data);
                expected.set(path, fileEntry(data));
            }

            expectTree(snapshot(saveAndReload().filesystem), expected);
        });

        it("reclaims the space of what it replaced", () => {
            const expected = snapshot(original.filesystem);

            // More than any of these partitions holds, so the space of the replaced copies has to
            // be reclaimed
            for (let i = 0; i < 48; ++i) {
                write(dirPath("ffshit-churn.bin"), pattern(phone.churnSize, i));
            }

            expected.set(dirPath("ffshit-churn.bin"), fileEntry(pattern(phone.churnSize, 47)));

            expectTree(snapshot(saveAndReload().filesystem), expected);
        });

        it("rejects a file that does not fit", () => {
            assert.throws(() => write(dirPath("ffshit-huge.bin"), pattern(64 * 1024 * 1024, 1)), BaseError);

            expectUnchangedOnDisk();
        });

        it("rejects bad paths", () => {
            const fs        = original.filesystem;
            const firmware  = firmwareFile(snapshot(fs), phone.partition);

            assert.ok(firmware);

            assert.throws(() => write("FFS_NOPE/ffshit.bin", pattern(1, 1)), BaseError);
            assert.throws(() => write(dirPath("ffshit-missing/ffshit.bin"), pattern(1, 1)), BaseError);
            assert.throws(() => write(`${firmware}/ffshit.bin`, pattern(1, 1)), BaseError);
            assert.throws(() => write(dirPath(), pattern(1, 1)), BaseError);
            assert.throws(() => write(phone.partition, pattern(1, 1)), BaseError);
            assert.throws(() => write(dirPath("ffshit\\x.bin"), pattern(1, 1)), BaseError);
            assert.throws(() => fs.createDirectory(dirPath(), WRITE_TIME), BaseError);
            assert.throws(() => fs.createDirectory(firmware, WRITE_TIME), BaseError);
            assert.throws(() => fs.remove(dirPath("ffshit-missing.bin")), BaseError);
            assert.throws(() => fs.remove(phone.partition), BaseError);

            expectUnchangedOnDisk();
        });

        it("writes names beyond ASCII", () => {
            const expected = snapshot(original.filesystem);

            // On SGOLD in the codepage, and in UTF-8 when the codepage lacks a character
            for (const name of ["ffshit-Ärger.bin", "ffshit-файл.bin", "ffshit-中文.bin"]) {
                const data = pattern(100, Buffer.byteLength(name));

                write(dirPath(name), data);
                expected.set(dirPath(name), fileEntry(data));
            }

            expectTree(snapshot(saveAndReload().filesystem), expected);
        });

        it("folds the case of what the firmware folds", () => {
            const expected = snapshot(original.filesystem);

            write(dirPath("ffshit-ärger.bin"), pattern(100, 1));
            write(dirPath("ffshit-Ärger.bin"), pattern(200, 2));

            // SGOLD folds ASCII letters only: both files are there
            if (phone.platform === "SGOLD") {
                expected.set(dirPath("ffshit-ärger.bin"), fileEntry(pattern(100, 1)));
            }

            expected.set(dirPath("ffshit-Ärger.bin"), fileEntry(pattern(200, 2)));

            expectTree(snapshot(saveAndReload().filesystem), expected);
        });

        it("keeps SGOLD names in the phone's codepage", { skip: phone.platform !== "SGOLD" && "only SGOLD names are 8-bit" }, () => {
            original.filesystem.setCodepage("CP1251");

            write(dirPath("ffshit-файл.bin"), pattern(100, 1));
            // CP1251 has no Ä
            write(dirPath("ffshit-Ärger.bin"), pattern(100, 2));

            const cp1251 = saveAndReload("CP1251");

            assert.ok(findFile(cp1251.filesystem, dirPath("ffshit-файл.bin")));
            assert.ok(findFile(cp1251.filesystem, dirPath("ffshit-Ärger.bin")));

            // The bytes of "файл" in CP1251 are "ôàéë" in CP1252, a name in UTF-8 reads the same in both
            const cp1252 = saveAndReload("CP1252");

            assert.ok(findFile(cp1252.filesystem, dirPath("ffshit-ôàéë.bin")));
            assert.ok(findFile(cp1252.filesystem, dirPath("ffshit-Ärger.bin")));
        });

        it("rejects an unknown codepage", () => {
            assert.throws(() => original.filesystem.setCodepage("NO-SUCH-CODEPAGE"), BaseError);
        });

        it("shows the changes before they are saved", () => {
            const expected = snapshot(original.filesystem);

            write(dirPath("ffshit-unsaved.bin"), pattern(3000, 1));
            expected.set(dirPath("ffshit-unsaved.bin"), fileEntry(pattern(3000, 1)));

            // In the tree of the filesystem that wrote it, and to a filesystem loaded anew
            expectTree(snapshot(original.filesystem), expected);

            const partitions = original.fullflash.getPartitions()!;
            const reloaded   = buildFilesystem(partitions.getFsPlatform(), partitions);

            reloaded.load();

            expectTree(snapshot(reloaded), expected);
        });

        it("writes into every partition", () => {
            const expected = snapshot(original.filesystem);

            for (const partition of original.filesystem.getRoot().getSubdirs()) {
                const path = `${partition.getName()}/ffshit-${partition.getName()}.bin`;

                write(path, pattern(10000, 1));
                expected.set(path, fileEntry(pattern(10000, 1)));
            }

            expectTree(snapshot(saveAndReload().filesystem), expected);
        });
    });
}

// Made-up fullflashes of every platform: what is found in them, and what is left out of the broken
// ones, with which warnings

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FFS, type FFSTreeEntry, type Platform } from "../src/index.js";
import { equalBytes, pattern } from "./helpers/data.js";
import { ELKA_LAYOUT, recordImage, SCENARIOS, type Scenario } from "./helpers/scenarios.js";

interface Expected {
    platform: Platform;
    model?: string;
    imei?: string;
    // "<path> <size>", "<path>/" for a directory
    tree: string[];
    warnings?: string[];
    // What strict mode throws, unless it is the first warning
    strict?: string;
}

const IMEI = "490154203237518";

const SAMPLE = ["empty.bin 0", "one.bin 1", "chunk-1.bin 1023", "chunk.bin 1024", "chunk+1.bin 1025", "parts.bin 5000", "big.bin 20000"];
const MISC   = ["Misc/", "Misc/Ärger.txt 30", "Misc/файл.txt 40", "Misc/中文.txt 50", "Misc/sub/", "Misc/sub/deep.txt 60", "Misc/empty dir/"];
const CACHE  = ["/FFS_C/", "/FFS_C/cache.bin 2000"];
// Short names in CP1252, and 0x05 for 0xE5
const FAT    = [
    "EMPTY.BIN 0", "one.bin 1", "sector.bin 512", "Sector+1.bin 513", "parts.bin 5000", "big.bin 20000", "ÄRGER.BIN 5", "åBC.BIN 6", "Thirteen1.txt 13",
    "Address book/", "Address book/5F02.adr 700",
    "Misc/", "Misc/Ärger.txt 30", "Misc/файл.txt 40", "Misc/😀 a name of more than 26 characters.txt 50", "Misc/\uFEFFbom.txt 15", "Misc/sub/", "Misc/sub/deep.txt 60", "Misc/empty dir/",
    "Many/", ...Array.from({ length: 20 }, (_, i) => `Many/file ${i}.txt ${i + 1}`),
];

const under = (dir: string, entries: string[]) => [`${dir}/`, ...entries.map((entry) => `${dir}/${entry}`)];

const EXPECTED: Record<Scenario, Expected> = {
    "sgold": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        // Bytes CP1252 has no characters for are spaces, broken UTF-8 after the 0x1F is U+FFFD
        tree: under("/FFS", [...SAMPLE, ...MISC, "Ärger.bin 5", " A  6", "фа 7", "�� 8"]),
    },
    "sgold2": {
        platform: "SGOLD2", model: "SYN", imei: IMEI,
        // An odd byte is left out, a lone surrogate is U+FFFD, a 0 and a leading U+FEFF are part of
        // the name
        tree: [...under("/FFS_0", [...SAMPLE, ...MISC, "😀 emoji.txt 5", "A 6", "�A 7", "中中中 8", "name\0after 10", "\uFEFFbom.txt 11", "inbox.lst 0", "inbox.lst\0 426"]), ...CACHE],
    },
    "elka": {
        platform: "SGOLD2_ELKA", model: "SYN", imei: IMEI,
        tree: [
            ...under("/FFS_0", [...SAMPLE, ...MISC, "😀 emoji.txt 5", "A 6", "�A 7", "中中中 8", "name\0after 10", "\uFEFFbom.txt 11", "inbox.lst 0", "inbox.lst\0 426",
                ...[0x200, 0x201, 0x400, 0x401, 0x600, 0x601, 0x7FF, 0x800, 0xC00, 0xE00].map((size) => `size-${size}.bin ${size}`)]),
            ...CACHE,
        ],
    },
    "sgold broken": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        // A file without data is empty
        tree: under("/FFS", ["fine.bin 100", "no data.bin 0", "missing header 10", "dup.bin 10"]),
        warnings: ["FFS: two records with id 10", "/FFS: record 20 is missing", "/FFS/broken part.bin: its part 30583 is missing"],
    },
    "sgold loop": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        tree: under("/FFS", ["Loop/", "Loop/a.bin 10"]),
        warnings: ["/FFS/Loop: entry 6 leads back to a directory it is in"],
    },
    "sgold prototype": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        tree: under("/FFS", SAMPLE),
    },
    "sgold partitions": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        tree: [...under("/FFS", ["a.bin 10"]), ...under("/FFS_C", ["c.bin 20"])],
        warnings: ["The block of FFS at 00110000 is not formatted", "The block of FFS_B at 00140000 is not formatted", "The block of FFS_B at 00150000 is not formatted"],
    },
    "sgold no root": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        tree: [],
        warnings: ["FFS: no root directory"],
    },
    "sgold root without the directory attribute": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        tree: under("/FFS", ["a.bin 10"]),
    },
    "sgold zero-size block": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        tree: under("/FFS", SAMPLE.slice(0, 2)),
        warnings: ["The block of FFS at 00100000 is empty"],
    },
    "sgold2 with an sgold table": {
        platform: "SGOLD", model: "SYN",
        tree: under("/FFS", SAMPLE.slice(0, 5)),
    },
    "sgold2 elka prototype": {
        platform: "SGOLD2_ELKA",
        tree: [...under("/FFS_0", SAMPLE.slice(0, 6)), ...CACHE],
    },
    // Found by its partition table
    "elka without the boot core's name": {
        platform: "SGOLD2_ELKA", model: "SYN", imei: IMEI,
        tree: [...under("/FFS_0", SAMPLE.slice(0, 4)), ...CACHE],
    },
    // The table found by its pattern, the model and IMEI where some phones have them
    "sgold without a table pointer": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        tree: under("/FFS", SAMPLE.slice(0, 4)),
    },
    "sgold2 without a table pointer": {
        platform: "SGOLD2", imei: IMEI,
        tree: [...under("/FFS_0", SAMPLE.slice(0, 4)), ...CACHE],
    },
    "elka without a table pointer": {
        platform: "SGOLD2_ELKA", model: "SYN", imei: IMEI,
        tree: [...under("/FFS_0", SAMPLE.slice(0, 4)), ...CACHE],
    },
    "sgold2 sl75": {
        platform: "SGOLD2", model: "SL75", imei: IMEI,
        tree: [...under("/FFS_0", SAMPLE.slice(0, 4)), ...CACHE],
    },
    "elka flags": {
        platform: "SGOLD2_ELKA", model: "SYN", imei: IMEI,
        tree: [...under("/FFS_0", ["deleted.bin 0"]), ...CACHE],
        warnings: ["/FFS_0/strange.bin: its data record 15 is missing"],
    },
    "egold": {
        platform: "EGOLD_CE", model: "SYN",
        tree: [...under("/FFS", [...SAMPLE, ...MISC, "Ärger.bin 5", " A  6", "фа 7", "�� 8"]), ...CACHE],
    },
    "egold 20-byte headers": {
        platform: "EGOLD_CE", model: "SYN",
        tree: under("/FFS", [...SAMPLE, ...MISC, "Ärger.bin 5", " A  6", "фа 7", "�� 8"]),
    },
    "egold 128 KiB blocks": {
        platform: "EGOLD_CE", model: "SYN",
        tree: under("/FFS", SAMPLE),
    },
    "egold at another address": {
        platform: "EGOLD_CE", model: "SYN",
        tree: under("/FFS", SAMPLE),
    },
    "egold without a table": {
        platform: "EGOLD_CE", model: "SYN",
        tree: [...under("/FFS", SAMPLE), ...CACHE],
    },
    "egold broken": {
        platform: "EGOLD_CE", model: "SYN",
        tree: under("/FFS", ["fine.bin 100", "missing header 10"]),
        warnings: ["FFS: two records with id 6010", "/FFS: record 6018 is missing", "/FFS/broken part.bin: its part 36583 is missing"],
    },
    "egold without root": {
        platform: "EGOLD_CE", model: "SYN",
        tree: [],
        warnings: ["FFS: no root directory"],
    },
    // The EEPROM's blocks are no filesystem's
    "egold without card-explorer": {
        platform: "EGOLD", model: "SYN",
        tree: under("/FFS", [...SAMPLE, ...MISC, "Ärger.bin 5", " A  6", "фа 7", "�� 8"]),
    },
    "egold without card-explorer, 32 KiB blocks": {
        platform: "EGOLD", model: "SYN",
        tree: under("/FFS", SAMPLE),
    },
    "egold without card-explorer, without a table": {
        platform: "EGOLD", model: "SYN",
        tree: [...under("/FFS", SAMPLE), ...CACHE],
    },
    "egold without card-explorer, version 1": {
        platform: "EGOLD", model: "SYN",
        tree: under("/FFS", [...SAMPLE, ...MISC, "Ärger.bin 5", " A  6", "фа 7", "�� 8"]),
    },
    "egold without card-explorer, broken": {
        platform: "EGOLD", model: "SYN",
        tree: under("/FFS", ["fine.bin 100", "missing header 10"]),
        warnings: ["FFS: two records with id 6010", "/FFS: record 6018 is missing", "/FFS/broken part.bin: its part 36583 is missing"],
    },
    // The EEPROM's filesystem is none
    "egold lba_fs": {
        platform: "EGOLD", model: "SYN",
        tree: under("/LBA_FS", FAT),
    },
    "egold lba_fs without a partition table, of 2-sector clusters": {
        platform: "EGOLD", model: "SYN",
        tree: under("/LBA_FS", FAT),
    },
    "egold lba_fs broken": {
        platform: "EGOLD", model: "SYN",
        tree: under("/LBA_FS", ["fine.bin 100", "nowhere/"]),
        warnings: ["/LBA_FS/broken chain.bin: its cluster chain is broken at 1911", "/LBA_FS/no data.bin: its sector 78 is missing", "/LBA_FS: entry 1 leads back to a directory it is in", "/LBA_FS/nowhere: its cluster chain is broken at 2048"],
    },
    "x65flasher": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        tree: under("/FFS", SAMPLE.slice(0, 6)),
    },
};

function flatten(entry: FFSTreeEntry): string[] {
    return (entry.children ?? []).flatMap((child) => [child.isDirectory ? `${child.path}/` : `${child.path} ${child.size}`, ...flatten(child)]);
}

describe("Made-up fullflashes", () => {
    for (const [name, expected] of Object.entries(EXPECTED) as [Scenario, Expected][]) {
        describe(name, () => {
            const image = SCENARIOS[name]();

            it("open", () => {
                const ffs = FFS.open(image);

                assert.equal(ffs.platform, expected.platform);
                assert.equal(ffs.model, expected.model);
                assert.equal(ffs.imei, expected.imei);
                assert.deepEqual(ffs.warnings, expected.warnings ?? []);
                assert.deepEqual(flatten(ffs.tree()), expected.tree);
            });

            it("read the files they list, of the sizes they list", () => {
                const ffs = FFS.open(image);

                const check = (entry: FFSTreeEntry): void => {
                    for (const child of entry.children ?? []) {
                        if (child.isDirectory) {
                            check(child);
                        } else {
                            assert.equal(ffs.readFile(child.path).length, child.size, child.path);
                        }
                    }
                };

                check(ffs.tree());
            });

            it(expected.warnings ? "fail in strict mode" : "open in strict mode", () => {
                if (expected.warnings) {
                    assert.throws(() => FFS.open(image, { strict: true }), { name: "FFSError", message: expected.strict ?? expected.warnings[0] });
                } else {
                    FFS.open(image, { strict: true });
                }
            });
        });
    }

    it("have the files' content", () => {
        for (const name of [
            "sgold", "sgold2", "elka", "sgold prototype", "egold", "egold 20-byte headers", "egold 128 KiB blocks", "egold at another address", "egold without a table",
            "egold without card-explorer", "egold without card-explorer, 32 KiB blocks", "egold without card-explorer, without a table", "egold without card-explorer, version 1",
            "egold lba_fs", "egold lba_fs without a partition table, of 2-sector clusters",
        ] as const) {
            const ffs  = FFS.open(SCENARIOS[name]());
            const root = ffs.readDir("/")[0].path;

            assert.ok(equalBytes(ffs.readFile(`${root}/parts.bin`), pattern(5000, 5)), name);
            assert.ok(equalBytes(ffs.readFile(`${root}/big.bin`), pattern(20000, 6)), name);
        }

        const sgold2 = FFS.open(SCENARIOS.sgold2());

        assert.ok(equalBytes(sgold2.readFile("/FFS_0/Misc/sub/deep.txt"), pattern(60, 11)));
        assert.equal(sgold2.readFile("/FFS_0/INBOX.LST").length, 0);
        assert.ok(equalBytes(sgold2.readFile("/FFS_0/inbox.lst\0"), pattern(426, 18)));

        const elka = FFS.open(SCENARIOS.elka());

        [0x200, 0x201, 0x400, 0x401, 0x600, 0x601, 0x7FF, 0x800, 0xC00, 0xE00].forEach((size, i) => {
            assert.ok(equalBytes(elka.readFile(`/FFS_0/size-${size}.bin`), pattern(size, 20 + i)), `size-${size}.bin`);
        });
    });

    it("have the timestamps in local time, on SGOLD2 and ELKA in UTC", () => {
        for (const name of ["sgold", "egold", "egold without card-explorer"] as const) {
            assert.deepEqual(FFS.open(SCENARIOS[name]()).stat("/FFS/parts.bin")?.timestamp, new Date(2107, 11, 31, 23, 59, 58), name);
        }

        assert.deepEqual(FFS.open(SCENARIOS["egold lba_fs"]()).stat("/LBA_FS/parts.bin")?.timestamp, new Date(2107, 11, 31, 23, 59, 58));

        for (const name of ["sgold2", "elka"] as const) {
            assert.deepEqual(FFS.open(SCENARIOS[name]()).stat("/FFS_0/parts.bin")?.timestamp, new Date(Date.UTC(2107, 11, 31, 23, 59, 58)), name);
        }
    });

    it("keep what comes before the fullflash when they are saved", () => {
        const image = SCENARIOS.x65flasher();
        const ffs   = FFS.open(image);

        assert.ok(equalBytes(ffs.save(), image));

        ffs.writeFile("/FFS/new.bin", pattern(10, 1));

        assert.ok(equalBytes(ffs.save().subarray(0, 16), image.subarray(0, 16)));
        assert.ok(equalBytes(FFS.open(ffs.save()).readFile("/FFS/new.bin"), pattern(10, 1)));
    });

    it("can be given a platform the detector does not find", () => {
        const image = SCENARIOS.sgold();

        // The boot core's name
        image.fill(0, 0x870, 0x874);

        assert.throws(() => FFS.open(image), { name: "FFSError", message: "The fullflash is of an unknown platform" });
        assert.equal(FFS.open(image, { platform: "SGOLD" }).readDir("/FFS").length, 12);
        assert.throws(() => FFS.open(new Uint8Array(0x100000), { platform: "EGOLD_CE" }), { name: "FFSError", message: "No filesystem partitions found" });
        assert.throws(() => FFS.open(new Uint8Array(0x100000), { platform: "EGOLD" }), { name: "FFSError", message: "No filesystem partitions found" });
    });

    it("take a fullflash without the boot core's name for an ELKA's only by an ELKA's partition table", () => {
        const sgold2 = SCENARIOS.sgold2();
        const elka   = recordImage({ ...ELKA_LAYOUT, noPointer: true }, { FFS_0: { files: [] } });

        sgold2.fill(0xFF, 0x870, 0x874);
        elka.fill(0xFF, 0xC70, 0xC74);

        for (const image of [sgold2, elka]) {
            assert.throws(() => FFS.open(image), { name: "FFSError", message: "The fullflash is of an unknown platform" });
        }
    });

    it("find the names on FAT disks without regard to the case of ASCII letters, with their attributes", () => {
        const ffs = FFS.open(SCENARIOS["egold lba_fs"]());

        assert.ok(equalBytes(ffs.readFile("/lba_fs/MISC/SUB/DEEP.TXT"), pattern(60, 11)));
        assert.ok(equalBytes(ffs.readFile("/LBA_FS/many/FILE 19.txt"), pattern(20, 39)));
        assert.equal(ffs.stat("/LBA_FS/misc/ärger.txt"), undefined);
        assert.deepEqual(["one.bin", "sector.bin", "Sector+1.bin"].map((name) => ffs.stat(`/LBA_FS/${name}`)).map((entry) => [entry?.readonly, entry?.hidden, entry?.system]), [[true, false, false], [false, true, false], [false, false, true]]);
        assert.equal(ffs.stat("/LBA_FS/Misc/sub")?.hidden, true);
    });

    it("tell EGOLD phones with Card-Explorer from those without by where their blocks have their headers", () => {
        assert.throws(() => FFS.open(SCENARIOS.egold(), { platform: "EGOLD" }), { name: "FFSError", message: "No filesystem partitions found" });
        assert.throws(() => FFS.open(SCENARIOS["egold without card-explorer"](), { platform: "EGOLD_CE" }), { name: "FFSError", message: "No filesystem partitions found" });
    });
});

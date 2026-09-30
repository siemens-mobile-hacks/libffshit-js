// Made-up fullflashes of every platform: what is found in them, and what is left out of the broken
// ones, with which warnings

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FFS, type FFSTreeEntry, type Platform } from "../src/index.js";
import { equalBytes, pattern } from "./helpers/data.js";
import { SCENARIOS, type Scenario } from "./helpers/scenarios.js";

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

const under = (dir: string, entries: string[]) => [`${dir}/`, ...entries.map((entry) => `${dir}/${entry}`)];

const EXPECTED: Record<Scenario, Expected> = {
    "sgold": {
        platform: "SGOLD", model: "SYN", imei: IMEI,
        // Bytes CP1252 has no characters for are taken for UTF-8, as is broken UTF-8
        tree: under("/FFS", [...SAMPLE, ...MISC, "Ärger.bin 5", "�A� 6", "фа 7", "�� 8"]),
    },
    "sgold2": {
        platform: "SGOLD2", model: "SYN", imei: IMEI,
        // An odd byte is left out, a lone surrogate is U+FFFD, the name ends at a 0
        tree: [...under("/FFS_0", [...SAMPLE, ...MISC, "😀 emoji.txt 5", "A 6", "�A 7", "中中中 8", "name 10"]), ...CACHE],
    },
    "elka": {
        platform: "SGOLD2_ELKA", model: "SYN", imei: IMEI,
        tree: [
            ...under("/FFS_0", [...SAMPLE, ...MISC, "😀 emoji.txt 5", "A 6", "�A 7", "中中中 8", "name 10",
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
        platform: "EGOLD_CE", model: "SYNE",
        tree: under("/FFS", ["a.txt 100", "parts.bin 5010", "ф.t 5", "Dir/", "Dir/inner.bin 64", "Ä.t 0"]),
    },
    "egold new": {
        platform: "EGOLD_CE", model: "SYNE",
        tree: under("/FFS", ["a.txt 60000"]),
    },
    "egold broken": {
        platform: "EGOLD_CE", model: "SYNE",
        tree: under("/FFS", ["a.txt 10"]),
        warnings: ["FFS: two records with id 2", "FFS: two files with id 7", "/FFS: record 99 is missing"],
    },
    "egold without root": {
        platform: "EGOLD_CE", model: "SYNE",
        tree: [],
        warnings: ["FFS: no root directory"],
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
        for (const name of ["sgold", "sgold2", "elka", "sgold prototype"] as const) {
            const ffs  = FFS.open(SCENARIOS[name]());
            const root = ffs.readDir("/")[0].path;

            assert.ok(equalBytes(ffs.readFile(`${root}/parts.bin`), pattern(5000, 5)), name);
            assert.ok(equalBytes(ffs.readFile(`${root}/big.bin`), pattern(20000, 6)), name);
        }

        assert.ok(equalBytes(FFS.open(SCENARIOS.sgold2()).readFile("/FFS_0/Misc/sub/deep.txt"), pattern(60, 11)));

        const elka = FFS.open(SCENARIOS.elka());

        [0x200, 0x201, 0x400, 0x401, 0x600, 0x601, 0x7FF, 0x800, 0xC00, 0xE00].forEach((size, i) => {
            assert.ok(equalBytes(elka.readFile(`/FFS_0/size-${size}.bin`), pattern(size, 20 + i)), `size-${size}.bin`);
        });

        const egold = FFS.open(SCENARIOS.egold());

        assert.ok(equalBytes(egold.readFile("/FFS/parts.bin"), Uint8Array.from([...pattern(3000, 2), ...pattern(2000, 3), ...pattern(10, 4)])));
        assert.ok(equalBytes(FFS.open(SCENARIOS["egold new"]()).readFile("/FFS/a.txt"), pattern(60000, 1)));
    });

    it("keep what comes before the fullflash when they are saved", () => {
        const image = SCENARIOS.x65flasher();
        const ffs   = FFS.open(image);

        assert.ok(equalBytes(ffs.save(), image));

        ffs.writeFile("/FFS/new.bin", pattern(10, 1));

        assert.ok(equalBytes(ffs.save().subarray(0, 16), image.subarray(0, 16)));
        assert.ok(equalBytes(FFS.open(ffs.save()).readFile("/FFS/new.bin"), pattern(10, 1)));
    });

    it("can be taken for another platform", () => {
        const ffs = FFS.open(SCENARIOS.egold(), { platform: "EGOLD_CE" });

        assert.equal(ffs.readDir("/FFS").length, 5);
        assert.throws(() => FFS.open(new Uint8Array(0x100000), { platform: "EGOLD_CE" }), { name: "FFSError", message: "No filesystem partitions found" });
    });
});

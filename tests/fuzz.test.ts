// Breaks fullflashes where the library reads them, as a flash breaks or a dump goes wrong. Whatever
// it makes of them, it may only throw FFSErrors: the files it lists read as the size it lists them
// with, and writes either happen, or fail and change nothing.
//
// SIE_FFS_FUZZ_CASES sets the number of cases per fullflash, SIE_FFS_FUZZ_SEED the first seed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detect } from "../src/fullflash/detector.js";
import { findPartitions } from "../src/fullflash/partitions.js";
import { FFS, FFSError, type FFSTreeEntry } from "../src/index.js";
import { Log } from "../src/log.js";
import { equalBytes, pattern, random } from "./helpers/data.js";
import { allFullflashes, readFullflash } from "./helpers/fullflashes.js";
import { SCENARIOS } from "./helpers/scenarios.js";

const CASES      = Number(process.env.SIE_FFS_FUZZ_CASES ?? 20);
const FIRST_SEED = Number(process.env.SIE_FFS_FUZZ_SEED ?? 1);

interface Region {
    addr: number;
    size: number;
    layout: "linear" | "elka" | "egold" | "egold_ce";
}

function view(data: Uint8Array): DataView {
    return new DataView(data.buffer, data.byteOffset, data.length);
}

function writeU32(data: Uint8Array, offset: number, value: number): void {
    if (offset >= 0 && offset + 4 <= data.length) {
        view(data).setUint32(offset, value >>> 0, true);
    }
}

function readU32(data: Uint8Array, offset: number): number {
    return offset >= 0 && offset + 4 <= data.length ? view(data).getUint32(offset, true) : 0;
}

function blocks(data: Uint8Array): Region[] {
    try {
        const detection             = detect(data);
        const { platform, partitions } = findPartitions(data, detection.platform!, detection.sl75, new Log());

        const layout = platform === "SGOLD2_ELKA" ? "elka" : platform === "EGOLD_CE" ? "egold_ce" : platform === "EGOLD" ? "egold" : "linear";

        return partitions.flatMap((partition) => partition.blocks.map((block) => ({ ...block, layout })));
    } catch {
        return [];
    }
}

// Where "OTP\0" points to
function partitionTable(data: Uint8Array): number | undefined {
    for (let i = 0; i + 8 <= data.length; i += 4) {
        if (data[i] === 0x4F && data[i + 1] === 0x54 && data[i + 2] === 0x50 && data[i + 3] === 0 && (data[i + 7] & 0xF0) === 0xA0) {
            return readU32(data, i + 4) & 0x0FFFFFFF;
        }
    }

    return undefined;
}

function mutate(original: Uint8Array, regions: Region[], seed: number): { data: Uint8Array, what: string[] } {
    const next  = random(seed);
    const int   = (n: number) => Math.floor(next() * n);
    const pick  = <T>(items: readonly T[]): T => items[int(items.length)];
    let   data  = original.slice();
    const what: string[] = [];

    const interesting = (current: number) => pick([
        0, 1, 6, 10, 0xFFFF, 0x10000, 0xFFFFFFFF, 0xFFFFFFC0, 0xFFFFFF00, 0xFFFFFFF0, 0x7FFFFFFF,
        current + 1, current - 1, current + int(64), current ^ (1 << int(32)), int(0x100000000), int(0x10000), int(0x1000),
    ]);

    for (let mutations = 1 + int(3); mutations > 0; --mutations) {
        const block = regions.length ? pick(regions) : undefined;

        switch (block ? int(8) : 5 + int(3)) {
            // A field of an entry of a block's FIT
            case 0:
            case 1:
            case 2: {
                const entry = {
                    elka:       () => block!.size - 64 - 32 * int(80),
                    egold:      () => block!.size - 12 * (1 + int(200)),
                    egold_ce:   () => block!.size - 12 * (1 + int(200)),
                    linear:     () => block!.size - 16 * (1 + int(200)),
                }[block!.layout]();
                const field = block!.addr + entry + (block!.layout.startsWith("egold") ? 2 * int(5) : 4 * int(4));

                writeU32(data, field, interesting(readU32(data, field)));
                what.push(`FIT field at 0x${field.toString(16)}`);

                break;
            }

            // Bytes of the records in a block
            case 3: {
                const offset = block!.addr + int(block!.size);

                for (let i = int(8); i >= 0; --i) {
                    data[offset + i] = int(256);
                }

                what.push(`record bytes at 0x${offset.toString(16)}`);

                break;
            }

            // A block's header: at its start, on ELKA at its end, on EGOLD at 0x80 with Card-Explorer
            // and at 0x10 without
            case 4: {
                const offset = { elka: block!.addr + block!.size - 32, egold_ce: block!.addr + 0x80, egold: block!.addr + 0x10, linear: block!.addr }[block!.layout] + int(16);

                data[offset] = int(256);
                what.push(`block header byte at 0x${offset.toString(16)}`);

                break;
            }

            case 5: {
                const table = partitionTable(data);

                if (table !== undefined) {
                    const offset = table + 4 * int(64 * 13);

                    writeU32(data, offset, interesting(readU32(data, offset)));
                    what.push(`partition table word at 0x${offset.toString(16)}`);
                }

                break;
            }

            // A dump cut short
            case 6: {
                const size = Math.floor(data.length * (0.3 + next() * 0.7)) & ~0xF;

                data = data.slice(0, size);
                what.push(`cut at 0x${size.toString(16)}`);

                break;
            }

            default: {
                for (let i = 0; i < 32; ++i) {
                    data[int(data.length)] ^= 1 << int(8);
                }

                what.push("32 random bit flips");
            }
        }
    }

    return { data, what };
}

function files(entry: FFSTreeEntry): FFSTreeEntry[] {
    return (entry.children ?? []).flatMap((child) => child.isDirectory ? [child, ...files(child)] : [child]);
}

function exercise(data: Uint8Array, seed: number): void {
    let ffs: FFS;

    try {
        ffs = FFS.open(data, { strict: seed % 3 === 0 });
    } catch (e) {
        if (e instanceof FFSError) {
            return;
        }

        throw e;
    }

    const entries = files(ffs.tree());

    for (const entry of entries) {
        if (!entry.isDirectory) {
            assert.equal(ffs.readFile(entry.path).length, entry.size, entry.path);
        }
    }

    const dirs = entries.filter((entry) => entry.isDirectory).map((entry) => entry.path);

    for (const [i, dir] of [...ffs.readDir("/").map((entry) => entry.path), ...dirs.slice(0, 3)].entries()) {
        const before = ffs.save();

        try {
            ffs.writeFile(`${dir}/fuzz-${i}.bin`, pattern(3000 + i, i));
            assert.ok(equalBytes(ffs.readFile(`${dir}/fuzz-${i}.bin`), pattern(3000 + i, i)));
        } catch (e) {
            if (!(e instanceof FFSError)) {
                throw e;
            }

            assert.ok(equalBytes(ffs.save(), before), `a failed write to ${dir} changed the fullflash`);
        }
    }
}

const TARGETS: [string, () => Uint8Array | undefined][] = [
    ["made-up SGOLD", SCENARIOS.sgold],
    ["made-up SGOLD2", SCENARIOS.sgold2],
    ["made-up SGOLD2_ELKA", SCENARIOS.elka],
    ["made-up EGOLD", SCENARIOS.egold],
    ["made-up EGOLD without Card-Explorer", SCENARIOS["egold without card-explorer, without a table"]],
    ["made-up EGOLD without Card-Explorer, version 1", SCENARIOS["egold without card-explorer, version 1"]],
    ["made-up EGOLD LBA_FS", SCENARIOS["egold lba_fs"]],
    ...allFullflashes().map((name): [string, () => Uint8Array | undefined] => [name, () => readFullflash(name)]),
];

describe("Broken fullflashes", () => {
    for (const [name, image] of TARGETS) {
        describe(name, () => {
            let original: Uint8Array | undefined;
            let regions: Region[] = [];

            for (let seed = FIRST_SEED; seed < FIRST_SEED + CASES; ++seed) {
                it(`case ${seed}`, () => {
                    if (!original) {
                        original = image()!;
                        regions  = blocks(original);
                    }

                    const { data, what } = mutate(original, regions, seed * 7919 + name.length);

                    try {
                        exercise(data, seed);
                    } catch (e) {
                        throw new Error(`With ${what.join(", ")}: ${(e as Error).stack}`);
                    }
                });
            }
        });
    }
});

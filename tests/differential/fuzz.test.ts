// Breaks fullflashes in the places the loaders read, loads them with the rewrite and with the C++
// library, and compares what they made of them: the same errors, the same warnings for what they
// skipped, the same files. Where the C++ library crashes, its behavior is undefined and the case is
// skipped.
//
// FFSHIT_FUZZ_CASES sets the number of cases per fullflash, FFSHIT_FUZZ_SEED the first seed, and
// FFSHIT_FUZZ_KEEP a directory to keep the fullflashes of the cases that fail in.

import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { assertSame } from "../helpers/compare.js";
import { loadJs, loadReference, readFullflash, type LoadOptions } from "../helpers/dump.js";
import { allFullflashes, SKIP_NO_REFERENCE, tempDir } from "../helpers/env.js";
import { random } from "../helpers/write.js";

const CASES = Number(process.env.FFSHIT_FUZZ_CASES ?? 12);
const FIRST_SEED = Number(process.env.FFSHIT_FUZZ_SEED ?? 1);

interface Region {
    addr: number;
    size: number;
    platform: string;
}

function writeU32(data: Uint8Array, offset: number, value: number): void {
    if (offset >= 0 && offset + 4 <= data.length) {
        new DataView(data.buffer, data.byteOffset).setUint32(offset, value >>> 0, true);
    }
}

function readU32(data: Uint8Array, offset: number): number {
    return offset >= 0 && offset + 4 <= data.length ? new DataView(data.buffer, data.byteOffset).getUint32(offset, true) : 0;
}

// The partition table the new search finds: at the address after "OTP\0"
function partitionTable(data: Uint8Array): number | undefined {
    for (let i = 0; i + 8 <= data.length; i += 4) {
        if (data[i] === 0x4F && data[i + 1] === 0x54 && data[i + 2] === 0x50 && data[i + 3] === 0 && (data[i + 7] & 0xF0) === 0xA0) {
            return readU32(data, i + 4) & 0x0FFFFFFF;
        }
    }

    return undefined;
}

// Breaks the fullflash in one of the ways a flash breaks, or a dump goes wrong
function mutate(original: Uint8Array, blocks: Region[], seed: number): { data: Uint8Array, what: string[] } {
    const next      = random(seed);
    const int       = (n: number) => Math.floor(next() * n);
    const pick      = <T>(items: readonly T[]): T => items[int(items.length)];
    let   data      = original.slice();
    const what: string[] = [];

    const interesting = (current: number) => pick([
        0, 1, 6, 10, 0xFFFF, 0x10000, 0xFFFFFFFF, 0xFFFFFFC0, 0xFFFFFF00, 0xFFFFFFF0, 0x7FFFFFFF,
        current + 1, current - 1, current + int(64), current ^ (1 << int(32)), int(0x100000000), int(0x10000), int(0x1000),
    ]);

    for (let mutations = 1 + int(3); mutations > 0; --mutations) {
        const block = blocks.length ? pick(blocks) : undefined;
        const kind  = block ? int(8) : 5 + int(3);

        switch (kind) {
            // A field of an entry of a block's FIT
            case 0:
            case 1:
            case 2: {
                const b         = block!;
                const elka      = b.platform === "SGOLD2_ELKA";
                const entry     = elka ? b.size - 64 - 32 * int(80) : b.size - 16 * (1 + int(200));
                const field     = entry + 4 * int(4);

                writeU32(data, b.addr + field, interesting(readU32(data, b.addr + field)));
                what.push(`FIT field at 0x${(b.addr + field).toString(16)}`);

                break;
            }

            // Bytes of the records in a block
            case 3: {
                const b         = block!;
                const offset    = int(b.size);

                for (let i = int(8); i >= 0; --i) {
                    data[b.addr + offset + i] = int(256);
                }

                what.push(`record bytes at 0x${(b.addr + offset).toString(16)}`);

                break;
            }

            // A block's header, at its start or, on ELKA, its end
            case 4: {
                const b         = block!;
                const header    = b.platform === "SGOLD2_ELKA" ? b.addr + b.size - 32 : b.addr;
                const offset    = header + int(16);

                data[offset] = int(256);
                what.push(`block header byte at 0x${offset.toString(16)}`);

                break;
            }

            // The partition table
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

            // Bits flipped anywhere
            default: {
                for (let i = 0; i < 32; ++i) {
                    const offset = int(data.length);

                    data[offset] ^= 1 << int(8);
                }

                what.push("32 random bit flips");

                break;
            }
        }
    }

    return { data, what };
}

const fullflashes = allFullflashes();

describe("Loading broken fullflashes matches the C++ library", { skip: SKIP_NO_REFERENCE || (!fullflashes.length && "no fullflashes: set FFSHIT_TEST_FULLFLASHES") }, () => {
    const dir = tempDir();

    for (const file of fullflashes) {
        describe(path.basename(file), () => {
            let original: Uint8Array | undefined;
            let blocks: Region[] = [];

            const prepare = () => {
                if (!original) {
                    original = readFullflash(file);

                    const dump = loadJs(original, { skipBroken: true, skipDup: true, tree: false }).dump;

                    blocks = dump.partitions?.list.flatMap((partition) => partition.blocks.map((block) => ({
                        addr:       block.addr,
                        size:       block.size,
                        platform:   dump.partitions!.fs_platform,
                    }))) ?? [];
                }

                return original;
            };

            for (let seed = FIRST_SEED; seed < FIRST_SEED + CASES; ++seed) {
                const options: LoadOptions = seed % 3 === 0 ? {} : { skipBroken: true, skipDup: true };

                it(`case ${seed}${options.skipBroken ? ", skipping" : ""}`, (t) => {
                    const { data, what } = mutate(prepare(), blocks, seed * 7919 + path.basename(file).length);
                    const mutated = path.join(dir, `${path.basename(file)}.${seed}`);

                    fs.writeFileSync(mutated, data);

                    try {
                        const reference = loadReference(mutated, options);

                        if (!reference.dump) {
                            t.skip(`the C++ library crashed (${reference.run.signal}) on ${what.join(", ")}`);

                            return;
                        }

                        let js;

                        try {
                            js = loadJs(data, options);
                        } catch (e) {
                            throw new Error(`the rewrite failed on ${what.join(", ")}: ${(e as Error).stack}`);
                        }

                        try {
                            assertSame(js.dump, reference.dump, `The load of the fullflash with ${what.join(", ")}`);
                        } catch (e) {
                            // Of a block past the end of the fullflash, the C++ library copies what
                            // lies after its allocation
                            const pastTheEnd = reference.dump.partitions?.list.some((partition) => partition.blocks.some((block) => block.addr + block.size > data.length));

                            if (pastTheEnd) {
                                t.skip(`a block runs past the end of the fullflash, where the C++ library reads memory it does not own (${what.join(", ")})`);

                                return;
                            }

                            if (process.env.FFSHIT_FUZZ_KEEP) {
                                fs.mkdirSync(process.env.FFSHIT_FUZZ_KEEP, { recursive: true });
                                fs.copyFileSync(mutated, path.join(process.env.FFSHIT_FUZZ_KEEP, path.basename(mutated)));
                            }

                            throw e;
                        }
                    } finally {
                        fs.rmSync(mutated, { force: true });
                    }
                });
            }
        });
    }
});

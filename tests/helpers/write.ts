// Operations on a filesystem, run by the rewrite and by the C++ library alike

import fs from "node:fs";
import path from "node:path";
import { buildFilesystem } from "../../src/index.js";
import { dumpTree, type TreeDir, errorDump, fromReferenceError, fromReferenceLoad, fromReferenceLog, fromReferenceTree, loadJs, LogCollector, referenceArgs, type ErrorDump, type LoadDump, type LoadOptions } from "./dump.js";
import { runReference, tempDir } from "./env.js";

export type Op =
    | { op: "codepage", codepage: string }
    | { op: "write", path: string, size: number, seed: number, time: number }
    | { op: "mkdir", path: string, time: number }
    | { op: "remove", path: string }
    | { op: "reload" };

export interface OpResult {
    error: ErrorDump | undefined;
    log: [string, string][];
}

export interface WriteRun {
    load: LoadDump;
    results: OpResult[];
    tree: TreeDir | undefined;
    saved: Uint8Array | undefined;
}

// Content that tells a shifted or truncated copy from the original, as the C++ tests make it
export function pattern(size: number, seed: number): Uint8Array {
    const data = new Uint8Array(size);

    for (let i = 0; i < size; ++i) {
        data[i] = (i * 31 + (i >>> 8) + (seed & 0xFF) * 7) & 0xFF;
    }

    return data;
}

function hexString(str: string): string {
    return Buffer.from(str, "utf8").toString("hex");
}

function scriptLine(op: Op): string {
    switch (op.op) {
        case "codepage":    return `codepage ${op.codepage}`;
        case "write":       return `write ${hexString(op.path)} ${op.size} ${op.seed} ${op.time}`;
        case "mkdir":       return `mkdir ${hexString(op.path)} ${op.time}`;
        case "remove":      return `remove ${hexString(op.path)}`;
        case "reload":      return "reload";
    }
}

// Undefined where the C++ library crashed
export function runReferenceWrite(file: string, ops: readonly Op[], options: LoadOptions = {}): WriteRun | undefined {
    const dir       = tempDir();
    const script    = path.join(dir, "script.txt");
    const saved     = path.join(dir, "saved.bin");

    try {
        fs.writeFileSync(script, ops.map(scriptLine).join("\n") + "\n");

        const run = runReference(["write", file, script, saved, ...referenceArgs(options)]);

        if (run.output === undefined) {
            return undefined;
        }

        const raw = JSON.parse(run.output);

        return {
            load:       fromReferenceLoad(raw.load),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            results:    (raw.results ?? []).map((result: any) => ({
                error:  result.error ? fromReferenceError(result.error) : undefined,
                log:    fromReferenceLog(result.log),
            })),
            tree:       raw.tree ? fromReferenceTree(raw.tree) : undefined,
            saved:      fs.existsSync(saved) ? new Uint8Array(fs.readFileSync(saved)) : undefined,
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

export function runJsWrite(data: Uint8Array, ops: readonly Op[], options: LoadOptions = {}): WriteRun {
    const log       = new LogCollector();
    const loaded    = loadJs(data, options, log);
    const run: WriteRun = { load: loaded.dump, results: [], tree: undefined, saved: undefined };

    if (!loaded.filesystem) {
        return run;
    }

    let filesystem = loaded.filesystem;

    for (const op of ops) {
        let error: ErrorDump | undefined;

        try {
            switch (op.op) {
                case "codepage": {
                    filesystem.setCodepage(op.codepage);

                    break;
                }

                case "write": {
                    filesystem.writeFile(op.path, pattern(op.size, op.seed), op.time * 1000);

                    break;
                }

                case "mkdir": {
                    filesystem.createDirectory(op.path, op.time * 1000);

                    break;
                }

                case "remove": {
                    filesystem.remove(op.path);

                    break;
                }

                case "reload": {
                    const partitions = loaded.fullflash!.getPartitions()!;

                    filesystem = buildFilesystem(partitions.getFsPlatform(), partitions);

                    if (options.codepage) {
                        filesystem.setCodepage(options.codepage);
                    }

                    filesystem.load(options.skipBroken ?? false, options.skipDup ?? false, options.parts ?? []);

                    break;
                }
            }
        } catch (e) {
            error = errorDump(e);
        }

        run.results.push({ error, log: log.take() });
    }

    run.tree  = dumpTree(filesystem.getRoot());
    run.saved = loaded.fullflash!.save();

    return run;
}

// Where two fullflashes first differ, or undefined
export function firstDifferentByte(a: Uint8Array, b: Uint8Array): number | undefined {
    if (a.length !== b.length) {
        return Math.min(a.length, b.length);
    }

    if (Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length))) {
        return undefined;
    }

    for (let i = 0; i < a.length; ++i) {
        if (a[i] !== b[i]) {
            return i;
        }
    }

    return undefined;
}

// A small deterministic PRNG, so that a failing sequence can be run again
export function random(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6D2B79F5) >>> 0;

        let t = state;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

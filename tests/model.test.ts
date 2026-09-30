// Long random sequences of writes, which get partitions compacted, checked against a model of what
// the filesystem should hold after each: in the directory written to, and in the whole filesystem
// at the end, as it is and saved and opened again.
//
// SIE_FFS_MODEL_SEEDS sets how many sequences run on each fullflash.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldCase8bit, foldCaseUtf16 } from "../src/filesystem/hash.js";
import { FFS, FFSError, type FFSTreeEntry, type OpenOptions } from "../src/index.js";
import { equalBytes, pattern, random } from "./helpers/data.js";
import { NO_FULLFLASHES, readFullflash } from "./helpers/fullflashes.js";
import { SCENARIOS } from "./helpers/scenarios.js";

const SEEDS = Number(process.env.SIE_FFS_MODEL_SEEDS ?? 2);
const OPS   = 200;

interface Entry {
    path: string;
    isDirectory: boolean;
    data?: Uint8Array;
}

// What the filesystem should hold, by path folded as the firmware folds names
class Model {
    readonly entries = new Map<string, Entry>();

    constructor(private readonly fold: (path: string) => string) {
    }

    static of(ffs: FFS): Model {
        const sgold = ffs.platform === "SGOLD" || ffs.platform === "EGOLD_CE";
        const model = new Model((path) => String.fromCharCode(...Array.from(path, (c) => sgold ? foldCase8bit(c.charCodeAt(0)) : foldCaseUtf16(c.charCodeAt(0)))));

        const add = (entry: FFSTreeEntry): void => {
            for (const child of entry.children ?? []) {
                model.set({ path: child.path, isDirectory: child.isDirectory, data: child.isDirectory ? undefined : ffs.readFile(child.path) });
                add(child);
            }
        };

        add(ffs.tree());

        return model;
    }

    get(path: string): Entry | undefined {
        return this.entries.get(this.fold(path));
    }

    set(entry: Entry): void {
        this.entries.set(this.fold(entry.path), entry);
    }

    delete(path: string): void {
        this.entries.delete(this.fold(path));
    }

    children(path: string): Entry[] {
        const prefix = `${this.fold(path)}/`;

        return [...this.entries].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/")).map(([, entry]) => entry);
    }
}

type Op =
    | { op: "write", path: string, data: Uint8Array }
    | { op: "mkdir", path: string }
    | { op: "remove", path: string }
    | { op: "reopen" };

function parentPath(path: string): string {
    return path.slice(0, path.lastIndexOf("/"));
}

function listing(entries: { path: string, isDirectory: boolean, size: number }[]): string[] {
    return entries.map((entry) => `${entry.path.slice(entry.path.lastIndexOf("/") + 1)} ${entry.isDirectory ? "dir" : entry.size}`).sort();
}

function randomOps(dir: string, firmware: string[], seed: number): Op[] {
    const next  = random(seed);
    const pick  = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const dirs  = [dir, `${dir}/sie-ffs-r1`, `${dir}/sie-ffs-r1/sie-ffs-r2`, `${dir}/SIE-FFS-R3`];
    const names = ["a.bin", "A.BIN", "b.bin", "long name with spaces.txt", "ж.txt", "Ж.TXT", "Ä.dat", "ä.dat", "sie-ffs-r1", "sie-ffs-R3", "😀"];
    const sizes = [0, 1, 511, 512, 513, 1024, 1025, 2048, 4096, 4097];
    const ops: Op[] = [];

    for (let i = 0; i < OPS; ++i) {
        const roll = next();
        const path = `${pick(dirs)}/${pick(names)}`;

        if (roll < 0.5) {
            const size = next() < 0.5 ? pick(sizes) : next() < 0.9 ? Math.floor(next() * 20000) : Math.floor(next() * 400000);

            ops.push({ op: "write", path, data: pattern(size, i) });
        } else if (roll < 0.6) {
            ops.push({ op: "mkdir", path: pick(dirs.slice(1)) });
        } else if (roll < 0.65 && firmware.length) {
            ops.push({ op: "write", path: pick(firmware), data: pattern(Math.floor(next() * 9000), i) });
        } else if (roll < 0.95) {
            ops.push({ op: "remove", path: next() < 0.2 ? pick(dirs.slice(1)) : path });
        } else {
            ops.push({ op: "reopen" });
        }
    }

    return ops;
}

// Whether the operation is one the filesystem should do
function allowed(model: Model, op: Exclude<Op, { op: "reopen" }>): boolean {
    const parent    = model.get(parentPath(op.path));
    const existing  = model.get(op.path);

    switch (op.op) {
        case "write":   return !!parent?.isDirectory && !existing?.isDirectory;
        case "mkdir":   return !!parent?.isDirectory && !existing;
        case "remove":  return !!existing && !(existing.isDirectory && model.children(existing.path).length);
    }
}

function apply(model: Model, op: Exclude<Op, { op: "reopen" }>): void {
    const parent = model.get(parentPath(op.path))!;
    const path   = `${parent.path}${op.path.slice(op.path.lastIndexOf("/"))}`;

    model.delete(op.path);

    if (op.op === "write") {
        model.set({ path, isDirectory: false, data: op.data });
    } else if (op.op === "mkdir") {
        model.set({ path, isDirectory: true });
    }
}

function expectModel(ffs: FFS, model: Model): void {
    const actual = Model.of(ffs);

    assert.deepEqual([...actual.entries.keys()].sort(), [...model.entries.keys()].sort());

    for (const [key, entry] of model.entries) {
        const found = actual.entries.get(key)!;

        assert.equal(found.path, entry.path);
        assert.ok(entry.isDirectory || equalBytes(found.data!, entry.data!), entry.path);
    }
}

function run(image: Uint8Array, dir: string, seed: number, options: OpenOptions): void {
    let   ffs       = FFS.open(image, { ...options, strict: true });
    const model     = Model.of(ffs);
    // Of names the library writes: the firmware's may have 0s in them
    const firmware  = [...model.entries.values()]
        .filter((entry) => !entry.isDirectory && entry.path.startsWith(`${dir.slice(0, dir.indexOf("/", 1))}/`) && !/[\x00-\x1F]/.test(entry.path))
        .map((entry) => entry.path)
        .slice(0, 30);
    let   compacted = 0;

    for (const [i, op] of randomOps(dir, firmware, seed).entries()) {
        const what = `operation ${i}: ${op.op} ${"path" in op ? op.path : ""}`;

        if (op.op === "reopen") {
            ffs = FFS.open(ffs.save(), { ...options, strict: true });

            continue;
        }

        const expected = allowed(model, op);

        try {
            switch (op.op) {
                case "write":   ffs.writeFile(op.path, op.data); break;
                case "mkdir":   ffs.mkdir(op.path); break;
                case "remove":  ffs.remove(op.path); break;
            }

            assert.ok(expected, `${what} should have failed`);

            apply(model, op);
        } catch (e) {
            if (!(e instanceof FFSError)) {
                throw e;
            }

            // Which the model cannot tell
            if (e.message.startsWith("Not enough free space")) {
                ++compacted;
            } else {
                assert.ok(!expected, `${what} failed: ${e.message}`);
            }
        }

        const parent = parentPath(op.path);

        if (model.get(parent)?.isDirectory) {
            const children = model.children(parent).map((entry) => ({ ...entry, size: entry.data?.length ?? 0 }));

            assert.deepEqual(listing(ffs.readDir(parent)), listing(children), what);
        }

        const written = model.get(op.path);

        if (op.op === "write" && written?.isDirectory === false) {
            assert.ok(equalBytes(ffs.readFile(op.path), written.data!), what);
        }
    }

    expectModel(ffs, model);
    expectModel(FFS.open(ffs.save(), { ...options, strict: true }), model);

    assert.ok(compacted < OPS / 2, "most writes did not fit");
}

const EGOLD: OpenOptions = { experimentalEgoldWrites: true };

const TARGETS: [string, () => Uint8Array | undefined, string, OpenOptions?][] = [
    ["made-up SGOLD", SCENARIOS.sgold, "/FFS/Misc"],
    ["made-up SGOLD2", SCENARIOS.sgold2, "/FFS_0/Misc"],
    ["made-up SGOLD2_ELKA", SCENARIOS.elka, "/FFS_0/Misc"],
    ["made-up EGOLD_CE", SCENARIOS.egold, "/FFS/Misc", EGOLD],
    ["made-up EGOLD_CE with 20-byte headers", SCENARIOS["egold 20-byte headers"], "/FFS/Misc", EGOLD],
    ["CX70", () => readFullflash("CX70v56lg3.bin"), "/FFS/Misc"],
    ["SL65", () => readFullflash("SL65v49lg1_TIM.bin"), "/FFS/Misc"],
    ["S75", () => readFullflash("S75v40lg1.bin"), "/FFS_0/Misc"],
    ["EL71", () => readFullflash("EL71v41lg91.bin"), "/FFS_0/Misc"],
];

for (const [name, image, dir, options] of TARGETS) {
    const data = image();

    describe(`Random writes to ${name}`, { skip: !data && NO_FULLFLASHES }, () => {
        for (let seed = 1; seed <= SEEDS; ++seed) {
            it(`seed ${seed}`, () => run(data!, dir, seed * 7919 + name.length, options ?? {}));
        }
    });
}

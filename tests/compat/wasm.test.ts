// The FFS class against @sie-js/libffshit, the WebAssembly build of the C++ library, which it
// replaces: the same answers to the same calls, on made-up fullflashes and on those there are.
//
// LIBFFSHIT_WASM is the package's directory, with dist/wasm/index.js and build_wasm built; by
// default ../libffshit. The build must be of a revision with getWarnings().
//
// The builds before this rewrite's revision took FAT timestamps for standard time, so the time
// zone here is UTC. What differs on purpose: a platform that does not exist is named in the error,
// and the rewrite needs no more memory than the fullflash to open it.

process.env.TZ = "UTC";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { FFS, type FFSEntry, type FFSOpenOptions, type FFSTreeEntry } from "../../src/index.js";
import { assertSame } from "../helpers/compare.js";
import { fnv1a, normalizeText } from "../helpers/dump.js";
import { allFullflashes, ROOT } from "../helpers/env.js";
import { egoldDirectory, egoldImage, fatTime, filesystemRecords, formattedImage, RecordsBuilder } from "../helpers/synthetic.js";
import { pattern } from "../helpers/write.js";

const WASM_DIR = process.env.LIBFFSHIT_WASM ?? path.join(ROOT, "..", "libffshit");
const WASM_INDEX = path.join(WASM_DIR, "dist", "wasm", "index.js");
const SKIP_NO_WASM = fs.existsSync(WASM_INDEX) && fs.readFileSync(WASM_INDEX, "utf8").includes("getWarnings") ?
    false :
    `no WebAssembly build of libffshit with getWarnings() in ${WASM_DIR}: set LIBFFSHIT_WASM`;

interface WasmFFS {
    open(buffer: Buffer, options?: FFSOpenOptions): Promise<void>;
    close(): void;
    getPlatform(): string;
    getModel(): string;
    getIMEI(): string;
    getWarnings(): string[];
    stat(path: string): FFSEntry | undefined;
    readFile(path: string): Buffer | undefined;
    readDir(path: string): FFSEntry[];
    getFilesTree(): FFSTreeEntry;
    isExists(path: string): boolean;
}

// What a call returned or threw
function outcome<T>(call: () => T): { value?: T, error?: string } {
    try {
        return { value: call() };
    } catch (e) {
        return { error: normalizeText((e as Error).message) };
    }
}

async function openOutcome(ffs: { open(buffer: Buffer, options?: FFSOpenOptions): Promise<void> }, data: Buffer, options: FFSOpenOptions): Promise<string | undefined> {
    try {
        await ffs.open(data, options);

        return undefined;
    } catch (e) {
        return normalizeText((e as Error).message);
    }
}

function normalizeTree<T extends { name: string, children?: T[] }>(tree: T): T {
    return { ...tree, name: normalizeText(tree.name), children: tree.children?.map(normalizeTree) };
}

function filePaths(tree: FFSTreeEntry, prefix = ""): string[] {
    return (tree.children ?? []).flatMap((child) => {
        const childPath = `${prefix}/${child.name}`;

        return child.isDirectory ? [childPath, ...filePaths(child, childPath)] : [childPath];
    });
}

// Paths of every kind: of the root, in other cases, with . and .., of what is not there, through
// a file, relative
function probes(paths: string[]): string[] {
    const some = paths.filter((_, i) => i % Math.max(1, Math.floor(paths.length / 40)) === 0);

    return [
        "/", "//", "/.", "/..", "/./", "", "relative", "FFS",
        ...some,
        ...some.map((p) => p.toUpperCase()),
        ...some.map((p) => p.toLowerCase()),
        ...some.map((p) => `${p}/`),
        ...some.map((p) => `${p}/./../${p.split("/").pop()}`),
        ...some.map((p) => `/${p}`),
        ...some.map((p) => `${p}/missing`),
        ...some.map((p) => `${p}x`),
        "/missing", "/missing/deeper", "/FFS/missing/deeper",
    ];
}

async function compare(data: Buffer, options: FFSOpenOptions): Promise<void> {
    const { FFS: WasmFFSClass } = await import(WASM_INDEX) as { FFS: new () => WasmFFS };
    const wasm = new WasmFFSClass();
    const js   = new FFS();

    const jsOpen   = await openOutcome(js, data, options);
    const wasmOpen = await openOutcome(wasm, data, options);

    if (wasmOpen === "Not enough memory to load the fullflash") {
        return;
    }

    if (wasmOpen === "unordered_map::at: key not found") {
        assert.equal(jsOpen, `Unknown platform ${options.platform}`);

        return;
    }

    assert.equal(jsOpen, wasmOpen, "open()");

    for (const call of ["getPlatform", "getModel", "getIMEI"] as const) {
        assertSame(outcome(() => js[call]()), outcome(() => wasm[call]()), call);
    }

    assertSame(outcome(() => js.getWarnings().map(normalizeText)), outcome(() => wasm.getWarnings().map(normalizeText)), "getWarnings()");

    const tree = outcome(() => normalizeTree(js.getFilesTree()));

    assertSame(tree, outcome(() => normalizeTree(wasm.getFilesTree())), "getFilesTree()");

    const paths = tree.value ? filePaths(tree.value) : [];

    for (const p of paths) {
        const jsFile   = outcome(() => js.readFile(p));
        const wasmFile = outcome(() => wasm.readFile(p));

        assertSame({ ...jsFile, value: jsFile.value && fnv1a(jsFile.value) }, { ...wasmFile, value: wasmFile.value && fnv1a(wasmFile.value) }, `readFile(${p})`);
    }

    for (const p of probes(paths)) {
        assertSame(outcome(() => js.stat(p)), outcome(() => wasm.stat(p)), `stat(${JSON.stringify(p)})`);
        assertSame(outcome(() => js.readDir(p)), outcome(() => wasm.readDir(p)), `readDir(${JSON.stringify(p)})`);
        assertSame(outcome(() => js.isExists(p)), outcome(() => wasm.isExists(p)), `isExists(${JSON.stringify(p)})`);

        const jsFile   = outcome(() => js.readFile(p));
        const wasmFile = outcome(() => wasm.readFile(p));

        assertSame({ ...jsFile, value: jsFile.value && fnv1a(jsFile.value) }, { ...wasmFile, value: wasmFile.value && fnv1a(wasmFile.value) }, `readFile(${JSON.stringify(p)})`);
    }

    js.close();
    wasm.close();

    assertSame(outcome(() => js.getPlatform()), outcome(() => wasm.getPlatform()), "getPlatform() after close()");
    assertSame(outcome(() => js.stat("/")), outcome(() => wasm.stat("/")), "stat() after close()");
}

// Made-up fullflashes whose names are ASCII: the builds before the codepage support return other
// names for SGOLD names beyond ASCII
function syntheticImages(): [string, Buffer][] {
    const sgoldLike = (platform: "SGOLD" | "SGOLD2" | "SGOLD2_ELKA") => {
        const layout  = { platform, size: 0x800000, blockSize: platform === "SGOLD2_ELKA" ? 0x20000 : 0x10000, partitions: [{ name: platform === "SGOLD" ? "FFS" : "FFS_0", blocks: 6 }, { name: "FFS_C", blocks: 2 }] };
        const builder = new RecordsBuilder(formattedImage(layout), platform);
        const rootName = platform === "SGOLD2_ELKA" ? Uint8Array.from(Buffer.from("ROOT", "utf16le")) : undefined;
        const files = [
            { name: "a.txt", data: pattern(100, 1), attributes: 0x01 },
            { name: "Big.BIN", data: pattern(9000, 2), fat: fatTime(2010, 3, 4, 5, 6, 8) },
            { name: "empty", data: new Uint8Array(0), attributes: 0x06 },
            { name: "Dir", children: [{ name: "inner", children: [{ name: "x.jpg", data: pattern(3000, 3) }] }, { name: "Same", data: pattern(1, 4) }] },
            { name: "dir2", children: [] },
        ];

        for (const [partition, tree] of [[layout.partitions[0].name, files], ["FFS_C", [{ name: "c.bin", data: pattern(10, 5) }]]] as const) {
            for (const [id, record] of filesystemRecords(platform, [...tree], { chunkSize: 1024, rootName })) {
                builder.add(partition, id, record);
            }
        }

        return Buffer.from(builder.image());
    };

    return [
        ["SGOLD", sgoldLike("SGOLD")],
        ["SGOLD2", sgoldLike("SGOLD2")],
        ["SGOLD2_ELKA", sgoldLike("SGOLD2_ELKA")],
        ["EGOLD_CE", Buffer.from(egoldImage({
            size: 0x800000,
            blocks: 2,
            files: [
                { id: 6, parentId: 6, name: new Uint8Array(0), attributes: 0x10, fat: 0, data: egoldDirectory([7, 8, 9]) },
                { id: 7, parentId: 6, name: Buffer.from("a.txt"), attributes: 0x01, fat: fatTime(2005, 2, 3, 4, 5, 6), data: pattern(100, 1) },
                { id: 8, parentId: 6, name: Buffer.from("Dir"), attributes: 0x10, fat: 0, data: egoldDirectory([10]) },
                { id: 9, parentId: 6, name: Buffer.from("parts.bin"), attributes: 0, fat: 0, data: pattern(3000, 2), parts: [pattern(100, 3)] },
                { id: 10, parentId: 8, name: Buffer.from("x"), attributes: 0, fat: 0, data: pattern(5, 4) },
            ],
        }))],
        ["unknown", Buffer.alloc(0x100000)],
    ];
}

describe("FFS answers as the WebAssembly build of libffshit does", { skip: SKIP_NO_WASM }, () => {
    const optionSets: [string, FFSOpenOptions][] = [
        ["defaults", {}],
        ["not skipping", { skipBroken: false, skipDuplicates: false }],
        ["with the old search algorithm", { isOldSearchAlgorithm: true }],
    ];

    for (const [name, image] of syntheticImages()) {
        describe(`a made-up ${name} fullflash`, () => {
            for (const [optionsName, options] of optionSets) {
                it(optionsName, () => compare(image, options));
            }

            it("taken for another platform", () => compare(image, { platform: name === "SGOLD" ? "SGOLD2" : "SGOLD" }));
            it("taken for a platform that does not exist", () => compare(image, { platform: "NOPE" as FFSOpenOptions["platform"] }));
        });
    }

    for (const file of allFullflashes()) {
        describe(path.basename(file), () => {
            for (const [optionsName, options] of optionSets) {
                it(optionsName, () => compare(fs.readFileSync(file), options));
            }
        });
    }
});

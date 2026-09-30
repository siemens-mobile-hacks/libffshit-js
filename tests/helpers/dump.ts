// What a load of a fullflash did, by the rewrite and by the C++ library, in one form to compare
// them in.

import fs from "node:fs";
import {
    buildFilesystem,
    type Directory,
    type Filesystem,
    FullFlash,
    Logger,
    type Partitions,
    type PlatformType,
} from "../../src/index.js";
import { runReference, type ReferenceRun } from "./env.js";

export interface LoadOptions {
    platform?: PlatformType;
    oldSearch?: boolean;
    start?: number;
    skipBroken?: boolean;
    skipDup?: boolean;
    parts?: string[];
    codepage?: string;
    verboseProcessing?: boolean;
    verboseHeaders?: boolean;
    verboseData?: boolean;
    tree?: boolean;
}

export interface TreeFile {
    n: string;
    p: string;
    a: number;
    t: number;
    s: number;
    h: number;
}

export interface TreeDir {
    n: string;
    p: string;
    a: number;
    t: number;
    d: TreeDir[];
    f: TreeFile[];
}

export interface ErrorDump {
    type: string;
    message: string;
}

export interface LoadDump {
    detector?: { platform: string, model: string, imei: string, base: string, sl75: boolean };
    partitions?: { fs_platform: string, list: { name: string, blocks: { addr: number, size: number, name: string, u1: number, u2: number, u3: number, u4: number }[] }[] };
    tree?: TreeDir;
    error?: ErrorDump;
    stage: string;
    log: [string, string][];
}

export function fnv1a(data: Uint8Array): number {
    let hash = 2166136261;

    for (let i = 0; i < data.length; ++i) {
        hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
    }

    return hash;
}

function hexOf(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("hex");
}

// A string of the C++ library, printed in hex, as the rewrite has it: its bytes as UTF-8
export function unhexString(hexStr: string): string {
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.from(hexStr, "hex"));
}

// What differs between runs: timings, and the counter of broken names, which counts on across
// every fullflash a process loads. The C++ library prints freed memory for a broken name.
export function normalizeText(text: string): string {
    return text
        .replace(/Done in \d+ ms/, "Done in # ms")
        .replace(/Search end\. Time: \d+ ms/, "Search end. Time: # ms")
        .replace(/^Broken name: .* -> /, "Broken name: # -> ")
        .replace(/broken_name_\d+/g, "broken_name_#");
}

function attributes(attrs: { isReadonly(): boolean, isHidden(): boolean, isSystem(): boolean, isDirectory(): boolean }): number {
    return (attrs.isReadonly() ? 1 : 0) | (attrs.isHidden() ? 2 : 0) | (attrs.isSystem() ? 4 : 0) | (attrs.isDirectory() ? 16 : 0);
}

export function dumpTree(dir: Directory): TreeDir {
    return {
        n: normalizeText(dir.getName()),
        p: normalizeText(dir.getPath()),
        a: attributes(dir.getAttributes()),
        t: dir.getTimestamp().getTime() / 1000,
        d: dir.getSubdirs().map(dumpTree),
        f: dir.getFiles().map((file) => ({
            n: normalizeText(file.getName()),
            p: normalizeText(file.getPath()),
            a: attributes(file.getAttributes()),
            t: file.getTimestamp().getTime() / 1000,
            s: file.getSize(),
            h: fnv1a(file.getData()),
        })),
    };
}

export function errorDump(e: unknown): ErrorDump {
    const error = e as Error;
    const known = ["PartitionsError", "FilesystemError", "FullflashError", "PatternsError", "OutOfRangeError"];

    return { type: known.includes(error.name) ? error.name : "Error", message: normalizeText(error.message) };
}

function dumpPartitions(partitions: Partitions): LoadDump["partitions"] {
    return {
        fs_platform: partitions.getFsPlatform(),
        list: [...partitions.getPartitions()].map(([name, partition]) => ({
            name,
            blocks: partition.getBlocks().map((block) => {
                const header = block.getHeader();

                return { addr: block.getAddr(), size: block.getSize(), name: hexOf(header.name), u1: header.unknown1, u2: header.unknown2, u3: header.unknown3, u4: header.unknown4 };
            }),
        })),
    };
}

export class LogCollector {
    messages: [string, string][] = [];

    constructor() {
        Logger.init({
            onInfo: (msg) => this.messages.push(["I", normalizeText(msg)]),
            onWarning: (msg) => this.messages.push(["W", normalizeText(msg)]),
            onError: (msg) => this.messages.push(["E", normalizeText(msg)]),
            onDebug: (msg) => this.messages.push(["D", normalizeText(msg)]),
        });
    }

    take(): [string, string][] {
        const messages = this.messages;

        this.messages = [];

        return messages;
    }
}

export interface Loaded {
    fullflash?: FullFlash;
    filesystem?: Filesystem;
    dump: LoadDump;
}

// Loads as ffshit-ref does, as far as it goes
export function loadJs(data: Uint8Array, options: LoadOptions = {}, log = new LogCollector()): Loaded {
    const dump: LoadDump = { stage: "fullflash", log: [] };
    const loaded: Loaded = { dump };

    try {
        const fullflash  = loaded.fullflash = new FullFlash(data, options.platform);
        const detector   = fullflash.getDetector();

        dump.detector = {
            platform:   detector.getPlatform(),
            model:      detector.getModel(),
            imei:       detector.getIMEI(),
            base:       BigInt.asUintN(64, BigInt(detector.getBaseAddress())).toString(),
            sl75:       detector.isSL75(),
        };

        dump.stage = "partitions";

        fullflash.loadPartitions(options.oldSearch ?? false, options.start ?? 0);

        const partitions = fullflash.getPartitions()!;

        dump.partitions = dumpPartitions(partitions);
        dump.stage = "filesystem";

        const filesystem = buildFilesystem(partitions.getFsPlatform(), partitions);

        filesystem.logVerboseProcessing(options.verboseProcessing ?? false);
        filesystem.logVerboseHeaders(options.verboseHeaders ?? false);
        filesystem.logVerboseData(options.verboseData ?? false);

        if (options.codepage) {
            filesystem.setCodepage(options.codepage);
        }

        filesystem.load(options.skipBroken ?? false, options.skipDup ?? false, options.parts ?? []);

        loaded.filesystem = filesystem;
        dump.stage = "done";

        if (options.tree ?? true) {
            dump.tree = dumpTree(filesystem.getRoot());
        }
    } catch (e) {
        dump.error = errorDump(e);
    }

    dump.log = log.take();

    return loaded;
}

export function referenceArgs(options: LoadOptions): string[] {
    const args: string[] = [];

    if (options.platform) {
        args.push(`--platform=${options.platform}`);
    }

    if (options.oldSearch) {
        args.push("--old-search");
    }

    if (options.start) {
        args.push(`--start=${options.start}`);
    }

    if (options.skipBroken) {
        args.push("--skip-broken");
    }

    if (options.skipDup) {
        args.push("--skip-dup");
    }

    if (options.parts) {
        args.push(`--parts=${options.parts.join(",")}`);
    }

    if (options.codepage) {
        args.push(`--codepage=${options.codepage}`);
    }

    if (options.verboseProcessing) {
        args.push("--verbose-processing");
    }

    if (options.verboseHeaders) {
        args.push("--verbose-headers");
    }

    if (options.verboseData) {
        args.push("--verbose-data");
    }

    if (options.tree === false) {
        args.push("--no-tree");
    }

    return args;
}

interface RawTreeDir {
    n: string;
    p: string;
    a: number;
    t: number;
    d: RawTreeDir[];
    f: TreeFile[];
}

export function fromReferenceTree(tree: RawTreeDir): TreeDir {
    return {
        n: normalizeText(unhexString(tree.n)),
        p: normalizeText(unhexString(tree.p)),
        a: tree.a,
        t: tree.t,
        d: tree.d.map(fromReferenceTree),
        f: tree.f.map((file) => ({ ...file, n: normalizeText(unhexString(file.n)), p: normalizeText(unhexString(file.p)) })),
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromReferenceLoad(raw: any): LoadDump {
    const dump: LoadDump = { stage: raw.stage, log: fromReferenceLog(raw.log) };

    if (raw.detector) {
        dump.detector = { ...raw.detector, model: unhexString(raw.detector.model), imei: unhexString(raw.detector.imei), base: String(raw.detector.base) };
    }

    if (raw.partitions) {
        dump.partitions = {
            fs_platform: raw.partitions.fs_platform,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            list: raw.partitions.list.map((partition: any) => ({ ...partition, name: unhexString(partition.name) })),
        };
    }

    if (raw.tree) {
        dump.tree = fromReferenceTree(raw.tree);
    }

    if (raw.error) {
        dump.error = fromReferenceError(raw.error);
    }

    return dump;
}

export function fromReferenceLog(log: [string, string][]): [string, string][] {
    return log.map(([level, msg]) => [level, normalizeText(unhexString(msg))]);
}

export function fromReferenceError(error: { type: string, message: string }): ErrorDump {
    return { type: error.type, message: normalizeText(unhexString(error.message)) };
}

// Loads with the C++ library. Undefined where it crashed.
export function loadReference(file: string, options: LoadOptions = {}): { dump: LoadDump | undefined, run: ReferenceRun } {
    const run = runReference(["load", file, ...referenceArgs(options)]);

    return { dump: run.output === undefined ? undefined : fromReferenceLoad(JSON.parse(run.output)), run };
}

export function readFullflash(file: string): Uint8Array {
    return new Uint8Array(fs.readFileSync(file));
}

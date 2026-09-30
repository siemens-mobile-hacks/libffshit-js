// The API of @sie-js/libffshit, the WebAssembly build of libffshit: a fullflash's files by
// absolute paths, looked up without regard to the case of ASCII letters, e.g. "/FFS/Pictures".

import { FilesystemError, FullflashError, PartitionsError } from "./errors.js";
import type { Filesystem } from "./filesystem/platform/base.js";
import { buildFilesystem } from "./filesystem/platform/builder.js";
import type { TimePoint } from "./filesystem/help.js";
import type { Directory, File } from "./filesystem/structure.js";
import { FullFlash } from "./fullflash.js";
import { Logger, type LogInterface } from "./log.js";
import type { Partitions } from "./partition/partitions.js";
import { isPlatformType, type PlatformType } from "./platform/types.js";

export interface FFSOpenOptions {
    isOldSearchAlgorithm?: boolean;
    searchStartAddress?: number;
    platform?: "auto" | "EGOLD_CE" | "SGOLD" | "SGOLD2" | "SGOLD2_ELKA";
    skipBroken?: boolean;
    skipDuplicates?: boolean;
    // Prints every message to the console
    debug?: boolean;
    verboseProcessing?: boolean;
    verboseHeaders?: boolean;
    verboseData?: boolean;
    // The codepage SGOLD file names are in, CP1252 by default
    codepage?: string;
}

export interface FFSEntry {
    name: string;
    // The parent directory
    path: string;
    size: number;
    // Milliseconds since the epoch
    timestamp: number;
    isFile: boolean;
    isDirectory: boolean;
    isReadonly: boolean;
    isHidden: boolean;
    isSystem: boolean;
}

export type FFSTreeEntry = FFSEntry & {
    children?: FFSTreeEntry[];
};

interface DirOrFile {
    dir?: Directory;
    file?: File;
}

function emptyEntry(): FFSEntry {
    return { name: "", path: "", size: 0, timestamp: 0, isFile: false, isDirectory: false, isReadonly: false, isHidden: false, isSystem: false };
}

// Lower case, of ASCII letters only
function toLower(str: string): string {
    return str.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function splitPath(input: string): string[] {
    if (!input.startsWith("/")) {
        throw new Error("Path must be absolute");
    }

    const parts: string[] = [];

    for (const part of input.split("/")) {
        if (part === "" || part === ".") {
            continue;
        }

        if (part === "..") {
            parts.pop();
        } else {
            parts.push(part);
        }
    }

    return parts;
}

function joinPath(parts: readonly string[]): string {
    return parts.length ? parts.map((part) => `/${part}`).join("") : "/";
}

function getParentDir(path: string): string {
    return joinPath(splitPath(path).slice(0, -1));
}

function getBaseName(path: string): string {
    return splitPath(path).pop() ?? "";
}

// Warnings and errors, e.g. broken files skipped while loading; everything when debugging
class FFSLogInterface implements LogInterface {
    readonly warnings: string[] = [];
    private readonly debug: boolean;

    constructor(debug: boolean) {
        this.debug = debug;
    }

    onInfo(msg: string): void {
        this.print("I", msg);
    }

    onWarning(msg: string): void {
        this.warnings.push(msg);
        this.print("W", msg);
    }

    onError(msg: string): void {
        this.warnings.push(msg);
        this.print("E", msg);
    }

    onDebug(msg: string): void {
        this.print("D", msg);
    }

    private print(level: string, msg: string): void {
        if (this.debug) {
            console.error(`[FFS] [${level}] ${msg}`);
        }
    }
}

interface Opened {
    fullflash: FullFlash;
    partitions: Partitions;
    filesystem: Filesystem;
    rootDir: Directory;
    platform: PlatformType;
    warnings: string[];
}

export class FFS {
    private handle: { opened: Opened | undefined } | undefined;

    // The buffer is used as it is, and must not change while it is open
    async open(buffer: Uint8Array, options: FFSOpenOptions = {}): Promise<void> {
        const handle = this.handle ??= { opened: undefined };
        const opts = {
            isOldSearchAlgorithm: false,
            searchStartAddress: 0,
            platform: "auto",
            skipBroken: true,
            skipDuplicates: true,
            debug: false,
            verboseData: false,
            verboseHeaders: false,
            verboseProcessing: false,
            ...options,
        };

        const logger         = new FFSLogInterface(opts.debug);
        const previousLogger = Logger.getInterface();

        Logger.init(logger);

        handle.opened = undefined;

        try {
            let fullflash: FullFlash;
            let partitions: Partitions;
            let platform: PlatformType;

            if (opts.platform === "auto") {
                fullflash = new FullFlash(buffer);
                platform  = fullflash.getDetector().getPlatform();

                if (platform === "UNK") {
                    throw new FullflashError("Unknown platform");
                }

                fullflash.loadPartitions(opts.isOldSearchAlgorithm, opts.searchStartAddress);
                partitions = fullflash.getPartitions()!;

                if (partitions.getFsPlatform() !== platform) {
                    platform = partitions.getFsPlatform();
                }
            } else {
                if (!isPlatformType(opts.platform)) {
                    throw new Error(`Unknown platform ${opts.platform}`);
                }

                platform  = opts.platform;
                fullflash = new FullFlash(buffer, platform);

                fullflash.loadPartitions(opts.isOldSearchAlgorithm, opts.searchStartAddress);
                partitions = fullflash.getPartitions()!;
            }

            const filesystem = buildFilesystem(platform, partitions);

            filesystem.logVerboseProcessing(opts.verboseProcessing);
            filesystem.logVerboseHeaders(opts.verboseHeaders);
            filesystem.logVerboseData(opts.verboseData);

            if (opts.codepage !== undefined) {
                filesystem.setCodepage(opts.codepage);
            }

            filesystem.load(opts.skipBroken, opts.skipDuplicates);

            handle.opened = { fullflash, partitions, filesystem, rootDir: filesystem.getRoot(), platform, warnings: logger.warnings };
        } catch (e) {
            if (e instanceof PartitionsError) {
                throw new Error(`[FULLFLASH::Partitions::Exception] ${e.message}`);
            }

            if (e instanceof FilesystemError) {
                throw new Error(`[FULLFLASH::Filesystem::Exception] ${e.message}`);
            }

            if (e instanceof FullflashError) {
                throw new Error(`[FULLFLASH::Exception] ${e.message}`);
            }

            throw e;
        } finally {
            Logger.init(previousLogger);
        }
    }

    close(): void {
        if (!this.handle) {
            throw new Error("FFS is not opened");
        }

        this.handle.opened = undefined;
    }

    getPlatform(): string {
        return this.opened().platform;
    }

    getModel(): string {
        return this.opened().fullflash.getDetector().getModel();
    }

    getIMEI(): string {
        return this.opened().fullflash.getDetector().getIMEI();
    }

    // Problems found while opening, e.g. broken files that were skipped
    getWarnings(): string[] {
        return [...this.opened().warnings];
    }

    stat(path: string): FFSEntry | undefined {
        const opened        = this.opened();
        const parentPath    = getParentDir(path);
        const dirOrFile     = this.getDirOrFile(path);

        if (dirOrFile.dir) {
            return this.dirEntry(opened, dirOrFile.dir, parentPath);
        }

        if (dirOrFile.file) {
            return this.fileEntry(dirOrFile.file, parentPath);
        }

        return undefined;
    }

    isExists(path: string): boolean {
        return this.stat(path) != null;
    }

    readFile(path: string): Buffer | undefined {
        this.opened();

        const { file } = this.getDirOrFile(path);

        return file ? Buffer.from(file.getData()) : undefined;
    }

    readDir(path: string): FFSEntry[] {
        const opened                = this.opened();
        const [dir, canonicalPath]  = this.getDir(path);
        const entries: FFSEntry[]   = [];

        if (dir) {
            for (const subdir of dir.getSubdirs()) {
                entries.push(this.dirEntry(opened, subdir, canonicalPath));
            }

            for (const file of dir.getFiles()) {
                entries.push(this.fileEntry(file, canonicalPath));
            }
        }

        return entries;
    }

    getFilesTree(): FFSTreeEntry {
        const rootDirStat = this.stat("/");

        if (!rootDirStat) {
            throw new Error("Root directory is not found");
        }

        return {
            ...rootDirStat,
            children: this.readDirRecursive("/"),
        };
    }

    readDirRecursive(path: string): FFSTreeEntry[] {
        const entries: FFSTreeEntry[] = [];

        for (const entry of this.readDir(path)) {
            if (entry.isDirectory) {
                entries.push({
                    ...entry,
                    children: this.readDirRecursive(`${entry.path}/${entry.name}`),
                });
            } else {
                entries.push({
                    ...entry,
                    children: [],
                });
            }
        }

        return entries;
    }

    // Creates the file, or replaces the file of that name. The parent directory must exist.
    writeFile(path: string, data: Uint8Array, timestamp: TimePoint = Date.now()): void {
        const opened = this.opened();

        opened.filesystem.writeFile(this.writePath(opened, path), data, timestamp);
    }

    // The parent directory must exist
    mkdir(path: string, timestamp: TimePoint = Date.now()): void {
        const opened = this.opened();

        opened.filesystem.createDirectory(this.writePath(opened, path), timestamp);
    }

    // Removes a file or an empty directory
    remove(path: string): void {
        const opened = this.opened();

        opened.filesystem.remove(this.writePath(opened, path));
    }

    // The fullflash with what was written to it, to save
    getFullflash(): Buffer {
        return Buffer.from(this.opened().fullflash.save().buffer);
    }

    private opened(): Opened {
        if (!this.handle) {
            throw new Error("FFS is not opened");
        }

        if (!this.handle.opened) {
            throw new Error("FFS is closed.");
        }

        return this.handle.opened;
    }

    // A path of the filesystem's own: its partition's name as the partition has it
    private writePath(opened: Opened, path: string): string {
        const parts = splitPath(path);

        if (parts.length) {
            const partition = opened.rootDir.getSubdirs().find((dir) => toLower(dir.getName()) === toLower(parts[0]));

            if (partition) {
                parts[0] = partition.getName();
            }
        }

        return parts.join("/");
    }

    private getDir(path: string): [Directory | undefined, string] {
        let   dir: Directory = this.opened().rootDir;
        const parts = splitPath(toLower(path));
        const canonicalPathParts: string[] = [];

        if (!parts.length) {
            return [dir, "/"];
        }

        for (const part of parts) {
            const subdir = dir.getSubdirs().find((subdir) => toLower(subdir.getName()) === part);

            if (!subdir) {
                return [undefined, ""];
            }

            dir = subdir;
            canonicalPathParts.push(dir.getName());
        }

        return [dir, joinPath(canonicalPathParts)];
    }

    private getDirOrFile(path: string): DirOrFile {
        const normalizedPath = joinPath(splitPath(path));

        if (normalizedPath === "/") {
            return { dir: this.opened().rootDir };
        }

        const [parentDir]   = this.getDir(getParentDir(normalizedPath));
        const baseNameLC    = getBaseName(toLower(path));

        if (!parentDir) {
            return {};
        }

        const dir = parentDir.getSubdirs().find((subdir) => toLower(subdir.getName()) === baseNameLC);

        if (dir) {
            return { dir };
        }

        const file = parentDir.getFiles().find((file) => toLower(file.getName()) === baseNameLC);

        return file ? { file } : {};
    }

    private fileEntry(file: File, parentPath: string): FFSEntry {
        const attributes = file.getAttributes();

        return {
            ...emptyEntry(),
            name:           file.getName(),
            path:           parentPath,
            timestamp:      file.getTimestamp().getTime(),
            size:           file.getSize(),
            isFile:         true,
            isReadonly:     attributes.isReadonly(),
            isHidden:       attributes.isHidden(),
            isSystem:       attributes.isSystem(),
        };
    }

    private dirEntry(opened: Opened, dir: Directory, parentPath: string): FFSEntry {
        const attributes = dir.getAttributes();

        return {
            ...emptyEntry(),
            name:           dir === opened.rootDir ? "" : dir.getName(),
            path:           parentPath,
            timestamp:      dir.getTimestamp().getTime(),
            isDirectory:    true,
            isReadonly:     attributes.isReadonly(),
            isHidden:       attributes.isHidden(),
            isSystem:       attributes.isSystem(),
        };
    }
}

import { concat } from "./bytes.js";
import { FFSError } from "./errors.js";
import { EgoldFormat } from "./filesystem/egold.js";
import { FatVolume } from "./filesystem/fat.js";
import { Attributes, isDirectory, type Header } from "./filesystem/format.js";
import { NewSgoldFormat } from "./filesystem/newsgold.js";
import { Records } from "./filesystem/records.js";
import { PROTOTYPE_ID_OFFSET, SgoldFormat } from "./filesystem/sgold.js";
import { Volume, type Filesystem } from "./filesystem/volume.js";
import { detect, PLATFORMS, type Platform } from "./fullflash/detector.js";
import { diskName, driveOrder } from "./fullflash/disks.js";
import { findPartitions, LBA_FS } from "./fullflash/partitions.js";
import { Image } from "./image.js";
import { Log, type Logger } from "./log.js";

export interface OpenOptions {
    // The platform, when it is not to be detected
    platform?: Platform;
    // Fails on anything broken, instead of leaving it out with a warning
    strict?: boolean;
    logger?: Logger;
}

export interface FFSEntry {
    name: string;
    // Absolute, e.g. "/FFS_0/Misc/photo.jpg"
    path: string;
    isDirectory: boolean;
    // 0 for a directory
    size: number;
    timestamp: Date;
    readonly: boolean;
    hidden: boolean;
    system: boolean;
    archive: boolean;
    // Attribute 0x40, not FAT's, which SGOLD phones set on some of their T9 dictionaries
    protected: boolean;
}

export interface FFSTreeEntry extends FFSEntry {
    // Of a directory
    children?: FFSTreeEntry[];
}

export interface FFSStatFs {
    // In bytes, as the phones reckon them, which tell them over OBEX
    size: number;
    free: number;
    // Whether it is not written to
    readonly: boolean;
}

// A file or directory a path leads to
interface Node {
    volume: Filesystem;
    header: Header;
    name: string;
    path: string;
    // The ids of the directories from the partition's root down to it, which a loop leads back to
    ancestors: readonly number[];
}

type Report = (problem: string) => void;

// The root, which holds the partitions
function rootEntry(): FFSEntry {
    return { name: "", path: "/", isDirectory: true, size: 0, timestamp: new Date(0), readonly: false, hidden: false, system: false, archive: false, protected: false };
}

// x65flasher puts a 16 byte header before the fullflash
const X65FLASHER_MAGIC          = [0x46, 0x42, 0x4B];
const X65FLASHER_HEADER_SIZE    = 16;

function splitPath(path: string): string[] {
    const parts: string[] = [];

    for (const part of path.split("/")) {
        if (part === "..") {
            parts.pop();
        } else if (part !== "" && part !== ".") {
            parts.push(part);
        }
    }

    return parts;
}

function joinPath(parts: readonly string[]): string {
    return `/${parts.join("/")}`;
}

// What makes a name one no path leads to
function nameProblem(name: string): string | undefined {
    if (name === "") {
        return "an entry without a name";
    }

    if (name === "." || name === ".." || name.includes("/")) {
        return `an entry named '${name}'`;
    }

    return undefined;
}

function rootProblem(volume: Filesystem): string | undefined {
    try {
        return volume.root() ? undefined : "no root directory";
    } catch (e) {
        if (e instanceof FFSError) {
            return `its root directory's ${e.message}`;
        }

        throw e;
    }
}

function isWritable(volume: Filesystem): boolean {
    try {
        volume.writable();

        return true;
    } catch (e) {
        if (e instanceof FFSError) {
            return false;
        }

        throw e;
    }
}

// Of the partition of that name in the partition table, named as the phone names it
function createVolume(platform: Platform, partition: string, name: string, records: Records, log: Log): Filesystem {
    if (partition === LBA_FS) {
        return new FatVolume(name, records);
    }

    switch (platform) {
        case "SGOLD": {
            // Prototypes keep the root at 6006
            const prototype = !records.has(6) && records.has(6 + PROTOTYPE_ID_OFFSET);

            if (prototype) {
                log.debug(`${name} is a prototype's, with ids from ${PROTOTYPE_ID_OFFSET}`);
            }

            const format = new SgoldFormat(records, prototype ? PROTOTYPE_ID_OFFSET : 0);

            return new Volume(name, records, format, prototype ? "a prototype's filesystem is read only" : undefined);
        }

        case "SGOLD2":
        case "SGOLD2_ELKA": {
            return new Volume(name, records, new NewSgoldFormat(records));
        }

        // Written as far as the phones' fullflashes tell the format: no phone has read what the
        // library writes to them
        case "EGOLD_CE": {
            const format = new EgoldFormat(records);

            return new Volume(name, records, format, format.version1 ? "writes to version 1 of EGOLD's filesystem are not supported" : undefined);
        }

        case "EGOLD": {
            return new Volume(name, records, new EgoldFormat(records), "writes to EGOLD without Card-Explorer are not supported");
        }
    }
}

// The filesystem of a fullflash, its partitions the directories in the root, named as the phone
// names them where its firmware does, else as the partition table does: "/Data/Misc/a.txt", which
// "/FFS_0/Misc/a.txt" leads to as well. Paths are found as the phone finds them, without regard to
// case as far as its firmware folds it, the partitions' names without regard to case.
//
// The fullflash is read where it is, so it must not change while in use. Writes go to a copy made
// on the first one, which save() returns: the fullflash given is never changed.
export class FFS {
    // The filesystem's, which may differ from the one detected
    readonly platform: Platform;
    readonly model: string | undefined;
    readonly imei: string | undefined;
    // What was found broken, and left out
    readonly warnings: readonly string[];

    private constructor(
        platform: Platform,
        detection: { model: string | undefined, imei: string | undefined },
        warnings: readonly string[],
        private readonly image: Image,
        // What came before the fullflash, which save() puts back
        private readonly prefix: Uint8Array,
        private readonly volumes: ReadonlyMap<string, Filesystem>,
    ) {
        this.platform   = platform;
        this.model      = detection.model;
        this.imei       = detection.imei;
        this.warnings   = warnings;
    }

    static open(data: Uint8Array, options: OpenOptions = {}): FFS {
        const log = new Log(options.logger, options.strict);
        let   prefix: Uint8Array = new Uint8Array(0);

        if (options.platform !== undefined && !PLATFORMS.includes(options.platform)) {
            throw new FFSError(`Unknown platform ${options.platform}`);
        }

        // A plain view, of whose subarrays slice() copies, which a Buffer's does not
        data = new Uint8Array(data.buffer, data.byteOffset, data.length);

        if (X65FLASHER_MAGIC.every((byte, i) => data[i] === byte)) {
            log.debug("x65flasher's header");

            prefix  = data.subarray(0, X65FLASHER_HEADER_SIZE);
            data    = data.subarray(X65FLASHER_HEADER_SIZE);
        }

        if (!data.length) {
            throw new FFSError("The fullflash is empty");
        }

        const detection = detect(data, options.platform);

        if (!detection.platform) {
            throw new FFSError("The fullflash is of an unknown platform");
        }

        const { platform, partitions, base } = findPartitions(data, detection.platform, detection.sl75, log);
        const image                     = new Image(data);
        const volumes                   = new Map<string, Filesystem>();

        // In their drives' order, as the phones list them, whatever the partition table's
        const ordered = [...partitions].sort((a, b) => driveOrder(platform, a.name) - driveOrder(platform, b.name));

        for (const partition of ordered) {
            const records = Records.open(platform, image, partition, base);

            for (const problem of records.problems) {
                log.warn(problem);
            }

            const volume    = createVolume(platform, partition.name, diskName(data, platform, partition.name) ?? partition.name, records, log);
            const problem   = rootProblem(volume);

            if (problem) {
                log.warn(`${partition.name}: ${problem}`);
            } else {
                volumes.set(partition.name, volume);
            }
        }

        const ffs = new FFS(platform, detection, log.warnings, image, prefix, volumes);

        for (const node of ffs.partitions()) {
            ffs.check(node, (problem) => log.warn(problem));
        }

        Object.freeze(log.warnings);

        return ffs;
    }

    // Undefined when there is no such file or directory, or when it is broken
    stat(path: string): FFSEntry | undefined {
        const node = this.resolve(splitPath(path));

        if (node === null) {
            return rootEntry();
        }

        if (!node) {
            return undefined;
        }

        const entry = this.describe(node);

        return typeof entry === "string" ? undefined : entry;
    }

    exists(path: string): boolean {
        return this.stat(path) !== undefined;
    }

    readDir(path: string): FFSEntry[] {
        return this.list(this.directory(path)).map(([, entry]) => entry);
    }

    readFile(path: string): Uint8Array {
        const parts = splitPath(path);
        const node  = this.resolve(parts);

        if (node === undefined) {
            throw new FFSError(`${joinPath(parts)}: no such file`);
        }

        if (node === null || isDirectory(node.header)) {
            throw new FFSError(`${node?.path ?? "/"}: is a directory`);
        }

        try {
            return node.volume.read(node.header);
        } catch (e) {
            throw e instanceof FFSError ? new FFSError(`${node.path}: ${e.message}`) : e;
        }
    }

    // Of the partition the path is in. The root's is of every partition, and read only, since
    // partitions are neither created nor removed.
    statfs(path: string): FFSStatFs {
        const parts = splitPath(path);
        const node  = this.resolve(parts);

        if (node === undefined) {
            throw new FFSError(`${joinPath(parts)}: no such file or directory`);
        }

        const stats: FFSStatFs = { size: 0, free: 0, readonly: !node || !isWritable(node.volume) };

        for (const volume of node ? [node.volume] : this.volumes.values()) {
            const { size, free } = volume.space();

            stats.size += size;
            stats.free += free;
        }

        return stats;
    }

    // The directory and everything in it
    tree(path = "/"): FFSTreeEntry {
        const node = this.directory(path);

        return this.subtree(node, node ? this.describe(node) as FFSEntry : rootEntry());
    }

    // Creates the file, or replaces the file of that name. The directory it is in must exist.
    writeFile(path: string, data: Uint8Array, timestamp: Date | number = new Date()): void {
        const target = this.parentOf(path);
        const { volume, parent, name } = target;

        const fatTime   = volume.fatTime(timestamp);
        const stored    = volume.encodeName(name);
        const existing  = volume.find(parent.header, name);

        if (existing && isDirectory(existing.header)) {
            throw new FFSError(`${target.path}: is a directory`);
        }

        volume.transaction(() => {
            if (existing) {
                volume.delete(existing);
            }

            volume.createFile(parent.header, stored, data, fatTime);
        });
    }

    // The directory it is in must exist
    mkdir(path: string, timestamp: Date | number = new Date()): void {
        const target = this.parentOf(path);
        const { volume, parent, name } = target;

        const fatTime   = volume.fatTime(timestamp);
        const stored    = volume.encodeName(name);

        if (volume.find(parent.header, name)) {
            throw new FFSError(`${target.path}: exists already`);
        }

        volume.transaction(() => volume.createDirectory(parent.header, stored, fatTime));
    }

    // Removes a file or an empty directory
    remove(path: string): void {
        const target = this.parentOf(path);
        const { volume, parent, name } = target;

        const child = volume.find(parent.header, name);

        if (!child) {
            throw new FFSError(`${target.path}: no such file or directory`);
        }

        if (isDirectory(child.header) && !volume.isEmpty(child.header)) {
            throw new FFSError(`${target.path}: directory not empty`);
        }

        volume.transaction(() => volume.delete(child));
    }

    // The fullflash, with what was written to it
    save(): Uint8Array {
        return concat([this.prefix, this.image.data]);
    }

    // =========================================================================

    // By its name, or its partition's
    private volume(name: string): Filesystem | undefined {
        const key = name.toLowerCase();

        return [...this.volumes].find(([partition, volume]) => volume.name.toLowerCase() === key || partition.toLowerCase() === key)?.[1];
    }

    // A partition's root is a directory whatever its attributes
    private partition(volume: Filesystem): Node {
        const root = volume.root()!;

        return {
            volume,
            header:     { ...root, attributes: root.attributes | Attributes.DIRECTORY },
            name:       volume.name,
            path:       `/${volume.name}`,
            ancestors:  [root.id],
        };
    }

    private partitions(): Node[] {
        return [...this.volumes.values()].map((volume) => this.partition(volume));
    }

    // The partition and the files and directories the names lead to, as far as they are found
    private follow(parts: readonly string[]): Node[] {
        const volume = parts.length ? this.volume(parts[0]) : undefined;

        if (!volume) {
            return [];
        }

        const nodes = [this.partition(volume)];

        for (const name of parts.slice(1)) {
            const node = nodes[nodes.length - 1];

            if (!isDirectory(node.header)) {
                break;
            }

            const child = volume.find(node.header, name);

            if (!child || node.ancestors.includes(child.header.id)) {
                break;
            }

            nodes.push({ volume, header: child.header, name: child.name, path: `${node.path}/${child.name}`, ancestors: [...node.ancestors, child.header.id] });
        }

        return nodes;
    }

    // null for the root
    private resolve(parts: readonly string[]): Node | null | undefined {
        if (!parts.length) {
            return null;
        }

        const nodes = this.follow(parts);

        return nodes.length === parts.length ? nodes[nodes.length - 1] : undefined;
    }

    // null for the root
    private directory(path: string): Node | null {
        const parts = splitPath(path);
        const node  = this.resolve(parts);

        if (node === undefined) {
            throw new FFSError(`${joinPath(parts)}: no such directory`);
        }

        if (node && !isDirectory(node.header)) {
            throw new FFSError(`${node.path}: not a directory`);
        }

        return node;
    }

    // The volume a file or directory would be created or removed in, and the directory in it, which
    // must not be broken
    private parentOf(path: string): { volume: Volume, parent: Node, name: string, path: string } {
        const parts         = splitPath(path);
        const filesystem    = parts.length ? this.volume(parts[0]) : undefined;

        if (!filesystem) {
            throw new FFSError(`${joinPath(parts)}: no such partition`);
        }

        if (parts.length === 1) {
            throw new FFSError(`/${filesystem.name}: is a partition's root directory`);
        }

        const volume    = filesystem.writable();
        const nodes     = this.follow(parts.slice(0, -1));
        const parent    = nodes[nodes.length - 1];

        if (!isDirectory(parent.header)) {
            throw new FFSError(`${parent.path}: not a directory`);
        }

        if (nodes.length < parts.length - 1) {
            throw new FFSError(`${parent.path}/${parts[nodes.length]}: no such directory`);
        }

        const problem = volume.directoryProblem(parent.header);

        if (problem) {
            throw new FFSError(`${parent.path}: ${problem}, not writing to it`);
        }

        return { volume, parent, name: parts[parts.length - 1], path: `${parent.path}/${parts[parts.length - 1]}` };
    }

    // The entry, or what is broken about it
    private describe(node: Node): FFSEntry | string {
        const { header, volume } = node;

        const size = isDirectory(header) ? 0 : volume.size(header);

        if (typeof size === "string") {
            return size;
        }

        return {
            name:           node.name,
            path:           node.path,
            isDirectory:    isDirectory(header),
            size,
            timestamp:      volume.timestamp(header),
            readonly:       (header.attributes & Attributes.READONLY) !== 0,
            hidden:         (header.attributes & Attributes.HIDDEN) !== 0,
            system:         (header.attributes & Attributes.SYSTEM) !== 0,
            archive:        (header.attributes & Attributes.ARCHIVE) !== 0,
            protected:      (header.attributes & Attributes.PROTECTED) !== 0,
        };
    }

    // The files and directories in a directory, except the broken ones, which are reported
    private list(dir: Node | null, report: Report = () => {}): [Node, FFSEntry][] {
        if (!dir) {
            return this.partitions().map((node) => [node, this.describe(node) as FFSEntry]);
        }

        const result: [Node, FFSEntry][] = [];

        for (const child of dir.volume.children(dir.header, (problem) => report(`${dir.path}: ${problem}`))) {
            if (isDirectory(child.header) && dir.ancestors.includes(child.header.id)) {
                report(`${dir.path}: entry ${child.header.id} leads back to a directory it is in`);

                continue;
            }

            const problem = nameProblem(child.name);

            if (problem) {
                report(`${dir.path}: ${problem}`);

                continue;
            }

            const node: Node = {
                volume:     dir.volume,
                header:     child.header,
                name:       child.name,
                path:       `${dir.path}/${child.name}`,
                ancestors:  [...dir.ancestors, child.header.id],
            };

            const entry = this.describe(node);

            if (typeof entry === "string") {
                report(`${node.path}: ${entry}`);

                continue;
            }

            result.push([node, entry]);
        }

        return result;
    }

    private check(dir: Node, report: Report): void {
        for (const [node, entry] of this.list(dir, report)) {
            if (entry.isDirectory) {
                this.check(node, report);
            }
        }
    }

    private subtree(dir: Node | null, entry: FFSEntry): FFSTreeEntry {
        return {
            ...entry,
            children: this.list(dir).map(([node, child]) => child.isDirectory ? this.subtree(node, child) : child),
        };
    }
}

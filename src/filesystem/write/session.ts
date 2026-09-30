import { FilesystemError } from "../../errors.js";
import type { Partitions } from "../../partition/partitions.js";
import type { PlatformType } from "../../platform/types.js";
import { fatTimestampToUnix, unixToFatTimestamp, type TimePoint } from "../help.js";
import { Attributes, Directory, File, FileAttributes } from "../structure.js";
import { Writer } from "./writer.js";

interface Path {
    partition: string;
    // below the partition's root, at least one
    names: string[];
}

// The writes to a filesystem: every operation either happens entirely or not at all, and shows in
// the loaded directory tree and in the fullflash afterwards
export class Session {
    private readonly platform: PlatformType;
    private readonly partitions: Partitions;
    private readonly root: Directory;
    private readonly codepage: string;
    private readonly writers = new Map<string, Writer>();

    constructor(platform: PlatformType, partitions: Partitions, root: Directory, codepage: string) {
        this.platform   = platform;
        this.partitions = partitions;
        this.root       = root;
        this.codepage   = codepage;
    }

    // The paths start with the partition's name
    writeFile(path: string, data: Uint8Array, timestamp: TimePoint): void {
        const parsed    = this.parse(path);
        const fatTime   = unixToFatTimestamp(timestamp);
        const name      = parsed.names[parsed.names.length - 1];

        this.run(parsed, (writer) => writer.writeFile(parsed.names, data, fatTime));

        const writer                    = this.writer(parsed.partition);
        const { parent, entriesPath }   = this.loadedParent(writer, parsed);

        if (!parent) {
            return;
        }

        for (const file of [...parent.getFiles()]) {
            if (writer.sameName(file.getName(), name)) {
                parent.removeFile(file);
            }
        }

        parent.addFile(new File(name, entriesPath, new Uint8Array(data), new Attributes(0), fatTimestampToUnix(fatTime)));
    }

    createDirectory(path: string, timestamp: TimePoint): void {
        const parsed    = this.parse(path);
        const fatTime   = unixToFatTimestamp(timestamp);

        this.run(parsed, (writer) => writer.createDirectory(parsed.names, fatTime));

        const { parent, entriesPath } = this.loadedParent(this.writer(parsed.partition), parsed);

        if (parent) {
            const attributes = new Attributes(FileAttributes.DIRECTORY);

            parent.addSubdir(new Directory(parsed.names[parsed.names.length - 1], entriesPath, attributes, fatTimestampToUnix(fatTime)));
        }
    }

    remove(path: string): void {
        const parsed    = this.parse(path);
        const name      = parsed.names[parsed.names.length - 1];

        this.run(parsed, (writer) => writer.remove(parsed.names));

        const writer                    = this.writer(parsed.partition);
        const { parent }                = this.loadedParent(writer, parsed);

        if (!parent) {
            return;
        }

        for (const file of [...parent.getFiles()]) {
            if (writer.sameName(file.getName(), name)) {
                parent.removeFile(file);
            }
        }

        for (const subdir of [...parent.getSubdirs()]) {
            if (writer.sameName(subdir.getName(), name)) {
                parent.removeSubdir(subdir);
            }
        }
    }

    private parse(path: string): Path {
        const names = path.split("/").filter((name) => name !== "");

        if (!names.length || !names[0].includes("FFS") || !this.partitions.getPartitions().has(names[0])) {
            throw new FilesystemError(`'${path}': no such partition`);
        }

        if (names.length === 1) {
            throw new FilesystemError(`'${path}' is a partition's root directory`);
        }

        return { partition: names[0], names: names.slice(1) };
    }

    private writer(partition: string): Writer {
        let writer = this.writers.get(partition);

        if (!writer) {
            writer = Writer.build(this.platform, this.partitions, partition, this.codepage);

            this.writers.set(partition, writer);
        }

        return writer;
    }

    private run(path: Path, operation: (writer: Writer) => void): void {
        const writer    = this.writer(path.partition);
        const records   = writer.getRecords();

        records.begin();

        try {
            operation(writer);
        } catch (e) {
            records.rollback();

            throw e;
        }

        records.commit();
    }

    // The parent directory in the loaded tree, when that is loaded, and the path the readers give
    // its files and directories
    private loadedParent(writer: Writer, path: Path): { parent: Directory | undefined, entriesPath: string } {
        let directory: Directory | undefined;

        for (const partition of this.root.getSubdirs()) {
            if (partition.getName() === path.partition) {
                directory = partition;
            }
        }

        let entriesPath = `${path.partition}/`;

        for (let i = 0; directory && i + 1 < path.names.length; ++i) {
            let next: Directory | undefined;

            for (const subdir of directory.getSubdirs()) {
                if (writer.sameName(subdir.getName(), path.names[i])) {
                    next = subdir;
                }
            }

            directory = next;

            if (directory) {
                entriesPath += `${directory.getName()}/`;
            }
        }

        return { parent: directory, entriesPath };
    }
}

export const FileAttributes = {
    READONLY:   0x0001,
    HIDDEN:     0x0002,
    SYSTEM:     0x0004,
    DIRECTORY:  0x0010,
} as const;

export class Attributes {
    private readonly directory: boolean;
    private readonly readonly: boolean;
    private readonly hidden: boolean;
    private readonly system: boolean;

    constructor(value = 0) {
        this.directory  = (value & FileAttributes.DIRECTORY) !== 0;
        this.system     = (value & FileAttributes.SYSTEM) !== 0;
        this.hidden     = (value & FileAttributes.HIDDEN) !== 0;
        this.readonly   = (value & FileAttributes.READONLY) !== 0;
    }

    isDirectory(): boolean {
        return this.directory;
    }

    isReadonly(): boolean {
        return this.readonly;
    }

    isHidden(): boolean {
        return this.hidden;
    }

    isSystem(): boolean {
        return this.system;
    }
}

export class File {
    private readonly name: string;
    private readonly path: string;
    private readonly data: Uint8Array;
    private readonly attributes: Attributes;
    private readonly timestamp: number;

    // The path is the parent directory's, e.g. "FFS_0/Misc/" for "FFS_0/Misc/photo.jpg"
    constructor(name: string, path: string, data: Uint8Array, attributes: Attributes, timestamp: Date | number = 0) {
        this.name       = name;
        this.path       = path;
        this.data       = data;
        this.attributes = attributes;
        this.timestamp  = typeof timestamp === "number" ? timestamp : timestamp.getTime();
    }

    getName(): string {
        return this.name;
    }

    getPath(): string {
        return this.path;
    }

    getAttributes(): Attributes {
        return this.attributes;
    }

    getTimestamp(): Date {
        return new Date(this.timestamp);
    }

    getData(): Uint8Array {
        return this.data;
    }

    getSize(): number {
        return this.data.length;
    }
}

export class Directory {
    private readonly name: string;
    private readonly path: string;
    private readonly attributes: Attributes;
    private readonly timestamp: number;
    private subdirs: Directory[] = [];
    private files: File[] = [];

    constructor(name: string, path: string, attributes = new Attributes(FileAttributes.DIRECTORY), timestamp: Date | number = 0) {
        this.name       = name;
        this.path       = path;
        this.attributes = attributes;
        this.timestamp  = typeof timestamp === "number" ? timestamp : timestamp.getTime();
    }

    addSubdir(dir: Directory): void {
        this.subdirs.push(dir);
    }

    addFile(file: File): void {
        this.files.push(file);
    }

    removeSubdir(dir: Directory): void {
        this.subdirs = this.subdirs.filter((subdir) => subdir !== dir);
    }

    removeFile(file: File): void {
        this.files = this.files.filter((f) => f !== file);
    }

    getName(): string {
        return this.name;
    }

    getPath(): string {
        return this.path;
    }

    getAttributes(): Attributes {
        return this.attributes;
    }

    getTimestamp(): Date {
        return new Date(this.timestamp);
    }

    getSubdirs(): readonly Directory[] {
        return this.subdirs;
    }

    getFiles(): readonly File[] {
        return this.files;
    }
}

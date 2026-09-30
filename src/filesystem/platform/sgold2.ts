import { BaseError, FilesystemError } from "../../errors.js";
import { dec, hex } from "../../format.js";
import { Logger } from "../../log.js";
import type { Partitions } from "../../partition/partitions.js";
import { ByteBuilder, readU16, readU32, slice } from "../../rawdata.js";
import { fatTimestampToUnix, type TimePoint } from "../help.js";
import { Attributes, Directory, File } from "../structure.js";
import { brokenName, decodeUtf16Name } from "../utf16.js";
import { checkChainLength, Filesystem, RecordMap, ROOT_NAME, ROOT_PATH } from "./base.js";

interface FITHeader {
    flags: number;
    id: number;
    size: number;
    offset: number;
}

interface FFSBlock {
    header: FITHeader;
    data: Uint8Array;
}

interface FileHeader {
    id: number;
    unknown1: number;
    nextPart: number;
    parentId: number;
    unknown2: number;
    unknown3: number;
    fatTimestamp: number;
    attributes: number;
    unknown7: number;
    name: string;
}

interface FilePart {
    id: number;
    parentId: number;
    nextPart: number;
}

type FSBlocksMap = RecordMap<FFSBlock>;

// Numbers the names that do not convert, in every SGOLD2 filesystem loaded
const brokenNames = { value: 0 };

export class SGOLD2 extends Filesystem {
    private readonly partitions: Partitions;
    private readonly rootDir: Directory;

    private readonly recourseProtector: number[] = [];

    constructor(partitions: Partitions) {
        super();

        this.partitions = partitions;
        this.rootDir    = new Directory(ROOT_NAME, "/");
    }

    load(skipBroken = false, skipDup = false, partsToExtract: readonly string[] = []): void {
        Logger.info("Loading filesystem");

        const startTime = Date.now();

        this.parseFIT(skipBroken, skipDup, partsToExtract);

        Logger.info(`Done in ${Date.now() - startTime} ms`);
    }

    getRoot(): Directory {
        return this.rootDir;
    }

    override writeFile(path: string, data: Uint8Array, timestamp: TimePoint): void {
        this.writeSession("SGOLD2", this.partitions, this.rootDir).writeFile(path, data, timestamp);
    }

    override createDirectory(path: string, timestamp: TimePoint): void {
        this.writeSession("SGOLD2", this.partitions, this.rootDir).createDirectory(path, timestamp);
    }

    override remove(path: string): void {
        this.writeSession("SGOLD2", this.partitions, this.rootDir).remove(path);
    }

    private printFitHeader(header: FITHeader): void {
        if (!this.verboseHeaders) {
            return;
        }

        Logger.debug("===========================");
        Logger.debug("FIT:");
        Logger.debug(`Flags:      ${hex(header.flags, 8)}`);
        Logger.debug(`ID:         ${header.id}`);
        Logger.debug(`Size:       ${header.size}`);
        Logger.debug(`Offset:     ${hex(header.offset, 4)}`);
    }

    private printFileHeader(header: FileHeader): void {
        if (!this.verboseHeaders) {
            return;
        }

        Logger.debug("===========================");
        Logger.debug("File:");
        Logger.debug(`ID:            ${header.id}`);
        Logger.debug(`Parent ID:     ${header.parentId}`);
        Logger.debug(`Next part ID:  ${header.nextPart}`);
        Logger.debug(`Unknown2:      ${hex(header.unknown2, 4)} ${header.unknown2}`);
        Logger.debug(`Unknown3:      ${hex(header.unknown3, 4)} ${header.unknown3}`);
        Logger.debug(`FAT timestamp: ${hex(header.fatTimestamp, 8)} ${header.fatTimestamp}`);
        Logger.debug(`Attributes:    ${hex(header.attributes, 4)} ${header.attributes}`);
        Logger.debug(`Unknown7:      ${hex(header.unknown7, 4)} ${header.unknown7}`);
        Logger.debug(`Name:          ${header.name}`);
    }

    private printFilePart(part: FilePart): void {
        if (!this.verboseHeaders) {
            return;
        }

        Logger.debug("===========================");
        Logger.debug("Part:");
        Logger.debug(`ID:             ${part.id}`);
        Logger.debug(`Parent ID:      ${part.parentId}`);
        Logger.debug(`Next part ID:   ${part.nextPart}`);
    }

    private static readFileHeader(data: Uint8Array): FileHeader {
        const header: FileHeader = {
            id:             readU32(data, 0),
            unknown1:       readU32(data, 4),
            nextPart:       readU32(data, 8),
            parentId:       readU32(data, 12),
            unknown2:       readU16(data, 16),
            unknown3:       readU16(data, 18),
            fatTimestamp:   readU32(data, 20),
            attributes:     readU16(data, 24),
            unknown7:       readU16(data, 26),
            name:           "",
        };

        if (data.length === 28) {
            return header;
        }

        const nameBytes = data.subarray(28);

        header.name = decodeUtf16Name(nameBytes) ?? brokenName(nameBytes, brokenNames);

        return header;
    }

    private static readFilePart(data: Uint8Array): FilePart {
        return {
            id:         readU32(data, 0),
            parentId:   readU32(data, 4),
            nextPart:   readU32(data, 8),
        };
    }

    private parseFIT(skipBroken: boolean, skipDup: boolean, partsToExtract: readonly string[]): void {
        for (const [partName, partInfo] of this.partitions.getPartitions()) {
            const partBlocks = partInfo.getBlocks();

            if (partName.includes("FFS")) {
                if (partsToExtract.length !== 0 && !partsToExtract.includes(partName)) {
                    Logger.warn(`Partition ${partName} excluded`);

                    continue;
                }

                Logger.debug(`Partition: ${partName}, Blocks ${partBlocks.length}`);
            } else {
                continue;
            }

            const ffsMap: FSBlocksMap = new RecordMap();

            for (const block of partBlocks) {
                Logger.debug(`  Block ${hex(block.getAddr(), 8)} Size: ${block.getSize()}`);

                const blockData = block.getData();
                const blockSize = block.getSize();

                for (let offset = blockSize - 16; offset > 0; offset -= 16) {
                    const header: FITHeader = {
                        flags:  readU32(blockData, offset),
                        id:     readU32(blockData, offset + 4),
                        size:   readU32(blockData, offset + 8),
                        offset: readU32(blockData, offset + 12),
                    };

                    if (header.flags === 0xFFFFFFFF) {
                        break;
                    }

                    if (header.flags !== 0xFFFFFFC0) {
                        continue;
                    }

                    this.printFitHeader(header);

                    const fsBlock: FFSBlock = { header, data: slice(blockData, header.offset, header.size) };

                    this.printData(fsBlock.data);

                    if (ffsMap.has(header.id)) {
                        if (skipDup) {
                            Logger.warn(`Duplicate id ${header.id}`);

                            continue;
                        }

                        throw new FilesystemError(`Duplicate id ${header.id}`);
                    }

                    ffsMap.set(header.id, fsBlock);
                }
            }

            if (!ffsMap.has(10)) {
                if (skipBroken) {
                    Logger.warn(`${partName} Root block (ID: 10) not found. Broken filesystem?`);

                    continue;
                } else {
                    throw new FilesystemError(`${partName} Root block (ID: 10) not found. Broken filesystem?`);
                }
            }

            try {
                const rootBlock     = ffsMap.get(10);
                const rootHeader    = SGOLD2.readFileHeader(rootBlock.data);
                const timestamp     = fatTimestampToUnix(rootHeader.fatTimestamp);
                const attributes    = new Attributes(rootHeader.attributes);
                const root          = new Directory(partName, ROOT_PATH, attributes, timestamp);

                this.rootDir.addSubdir(root);

                this.scan(partName, ffsMap, root, rootHeader, skipBroken);
            } catch (e) {
                if (skipBroken && e instanceof BaseError) {
                    Logger.warn(`${partName} Skip. Broken root directory: ${e.message}`);
                } else {
                    throw e;
                }
            }
        }
    }

    // The data record, then the data of every part: read_full_data() and read_recurse()
    private readFullData(ffsMap: FSBlocksMap, header: FileHeader): Uint8Array {
        const fileData = new ByteBuilder();

        this.printFileHeader(header);

        const dataId = (header.id + 1) >>> 0;

        if (!ffsMap.has(dataId)) {
            throw new FilesystemError(`Reading file data. Couldn't find block with id: ${dataId}`);
        }

        fileData.add(ffsMap.get(dataId).data);

        let next = header.nextPart;

        for (let length = 1; next !== 0xFFFFFFFF; ++length) {
            checkChainLength(length, ffsMap.size);

            const nextId = next & 0xFFFF;

            if (!ffsMap.has(nextId)) {
                throw new FilesystemError(`Reading part. Couldn't find block with id: ${nextId}`);
            }

            const part      = SGOLD2.readFilePart(ffsMap.get(nextId).data);
            const partData  = (part.id + 1) & 0xFFFF;

            this.printFilePart(part);

            if (!ffsMap.has(partData)) {
                throw new FilesystemError(`Reading part data. Couldn't find block with id: ${partData}`);
            }

            fileData.add(ffsMap.get(partData).data);

            next = part.nextPart;
        }

        return fileData.build();
    }

    private scan(blockName: string, ffsMap: FSBlocksMap, dir: Directory, header: FileHeader, skipBroken: boolean, path = "/"): void {
        if (skipBroken) {
            if (this.recourseProtector.includes(header.id)) {
                throw new FilesystemError("Directory id already in list");
            }

            this.recourseProtector.push(header.id);
        }

        let data: Uint8Array;

        try {
            data = this.readFullData(ffsMap, header);
        } catch (e) {
            if (skipBroken && e instanceof BaseError) {
                Logger.warn(`Skip. Broken directory: ${e.message}`);

                this.recourseProtector.pop();

                return;
            } else {
                throw e;
            }
        }

        const idList: number[] = [];

        // Entries of 8 bytes: the id, then the name's hash
        for (let offset = 0; offset < data.length; offset += 8) {
            const id = readU32(data, offset) & 0xFFFF;

            if (id === 0xFFFF) {
                continue;
            }

            if (id === 0) {
                continue;
            }

            idList.push(id);
        }

        for (const id of idList) {
            if (!ffsMap.has(id)) {
                if (skipBroken) {
                    Logger.warn(`Skip. FFS Block ID ${id} not found`);

                    continue;
                } else {
                    throw new FilesystemError(`FFS Block ID: ${id} not found`);
                }
            }

            try {
                const fileBlock     = ffsMap.get(id);
                const fileHeader    = SGOLD2.readFileHeader(fileBlock.data);
                const timestamp     = fatTimestampToUnix(fileHeader.fatTimestamp);
                const attributes    = new Attributes(fileHeader.attributes);

                if (this.verboseProcessing) {
                    Logger.info(`Processing ID: ${dec(id, 5)}, Path: ${blockName}${path}${fileHeader.name}`);
                }

                if (attributes.isDirectory()) {
                    const dirNext = new Directory(fileHeader.name, blockName + path, attributes, timestamp);

                    dir.addSubdir(dirNext);

                    this.scan(blockName, ffsMap, dirNext, fileHeader, skipBroken, `${path}${fileHeader.name}/`);
                } else {
                    let fileData: Uint8Array = new Uint8Array(0);

                    if (ffsMap.has((fileHeader.id + 1) >>> 0)) {
                        fileData = this.readFullData(ffsMap, fileHeader);
                    }

                    dir.addFile(new File(fileHeader.name, blockName + path, fileData, attributes, timestamp));
                }
            } catch (e) {
                if (skipBroken && e instanceof BaseError) {
                    Logger.warn(`Skip. Broken file/directory ID: ${dec(id, 5)}: ${e.message}. Directory: ${path}`);
                } else {
                    throw e;
                }
            }
        }

        if (skipBroken) {
            this.recourseProtector.pop();
        }
    }
}

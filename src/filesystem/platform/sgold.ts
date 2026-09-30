// The records of an SGOLD filesystem, e.g.
//
// 6C 01 20 01 00 00 21 30 6D 01 00 00 FF FF 6E 01 68 61 74 34 2E 70 6E 67 00
//
// 6C 01          - the record's id
// 20 01          - the parent directory's id
// 00 00 21 30    - FAT timestamp
// 6D 01          - the id of the record with the data
// 00 00 FF FF    - attributes: 00 00 for a directory, 10 00 for a file
// 6E 01          - FF FF when the data fits in one record, else the id of the next part
// hat4.png\0     - the name
//
// A part, e.g. 6E 01 20 01 00 00 21 30 6F 01 00 00 6C 01 70 01:
//
// 6E 01          - its id
// 20 01          - the parent directory's id
// 00 00 21 30    - FAT timestamp
// 6F 01          - the id of the record with the data
// 00 00          - ?
// 6C 01          - the previous part
// 70 01          - the next part, FF FF for the last one

import { BaseError, FilesystemError } from "../../errors.js";
import { dec, hex } from "../../format.js";
import { Logger } from "../../log.js";
import type { Partitions } from "../../partition/partitions.js";
import { ByteBuilder, decodeUtf8, readString, readU16, readU32, slice } from "../../rawdata.js";
import { sgoldNameToUtf8 } from "../codepage.js";
import { fatTimestampToUnix, type TimePoint } from "../help.js";
import { Attributes, Directory, File } from "../structure.js";
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
    parentId: number;
    fatTimestamp: number;
    dataId: number;
    attributes: number;
    nextPart: number;
    name: Uint8Array;
    // The name once scan() has converted it from the codepage
    utf8Name?: string;
}

interface FilePart {
    id: number;
    parentId: number;
    unknown: number;
    dataId: number;
    unknown2: number;
    prevId: number;
    nextPart: number;
}

type FSBlocksMap = RecordMap<FFSBlock>;

export class SGOLD extends Filesystem {
    private readonly partitions: Partitions;
    private readonly rootDir: Directory;

    private readonly recourseProtector: number[] = [];

    private prototype6000 = false;

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
        this.writeSession("SGOLD", this.partitions, this.rootDir).writeFile(path, data, timestamp);
    }

    override createDirectory(path: string, timestamp: TimePoint): void {
        this.writeSession("SGOLD", this.partitions, this.rootDir).createDirectory(path, timestamp);
    }

    override remove(path: string): void {
        this.writeSession("SGOLD", this.partitions, this.rootDir).remove(path);
    }

    private printFitHeader(header: FITHeader): void {
        if (!this.verboseHeaders) {
            return;
        }

        Logger.debug("===========================");
        Logger.debug("FIT:");
        Logger.debug(`Flags:  ${hex(header.flags, 8)}`);
        Logger.debug(`ID:     ${header.id}`);
        Logger.debug(`Size:   ${header.size}`);
        Logger.debug(`Offset: ${hex(header.offset, 8)}`);
    }

    private printFileHeader(header: FileHeader): void {
        if (!this.verboseHeaders) {
            return;
        }

        Logger.debug("===========================");
        Logger.debug("File:");
        Logger.debug(`ID:            ${header.id}`);
        Logger.debug(`Parent ID:     ${header.parentId}`);
        Logger.debug(`FAT timestamp: ${hex(header.fatTimestamp, 4)} ${header.fatTimestamp}`);
        Logger.debug(`Data ID:       ${header.dataId}`);
        Logger.debug(`Attributes:    ${hex(header.attributes, 4)}`);
        Logger.debug(`Next part ID:  ${header.nextPart}`);
        Logger.debug(`Name:          ${header.utf8Name ?? decodeUtf8(header.name)}`);
    }

    private printFilePart(part: FilePart): void {
        if (!this.verboseHeaders) {
            return;
        }

        Logger.debug("===========================");
        Logger.debug("File part:");
        Logger.debug(`ID:            ${part.id}`);
        Logger.debug(`Parent ID:     ${part.parentId}`);
        Logger.debug(`Unknown:       ${hex(part.unknown, 4)}`);
        Logger.debug(`Data ID:       ${part.dataId}`);
        Logger.debug(`Unknown2:      ${hex(part.unknown2, 4)}`);
        Logger.debug(`Prev ID:       ${part.prevId}`);
        Logger.debug(`Next part ID:  ${part.nextPart}`);
    }

    private static readFileHeader(data: Uint8Array): FileHeader {
        return {
            id:             readU16(data, 0),
            parentId:       readU16(data, 2),
            fatTimestamp:   readU32(data, 4),
            dataId:         readU16(data, 8),
            attributes:     readU32(data, 10),
            nextPart:       readU16(data, 14),
            name:           readString(data, 16),
        };
    }

    private static readFilePart(data: Uint8Array): FilePart {
        return {
            id:         readU16(data, 0),
            parentId:   readU16(data, 2),
            unknown:    readU32(data, 4),
            dataId:     readU16(data, 8),
            unknown2:   readU16(data, 10),
            prevId:     readU16(data, 12),
            nextPart:   readU16(data, 14),
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
                Logger.debug(`  Block ${hex(block.getAddr(), 8)} Size: ${block.getSize()}, end: ${hex((block.getAddr() + block.getSize()) >>> 0, 8)}`);

                const blockData = block.getData();
                const blockSize = block.getSize();

                for (let offset = blockSize - 16; offset > 0; offset -= 16) {
                    const header: FITHeader = {
                        flags:  readU32(blockData, offset),
                        id:     readU32(blockData, offset + 4),
                        size:   readU32(blockData, offset + 8),
                        offset: readU32(blockData, offset + 12),
                    };

                    this.printFitHeader(header);

                    if (header.flags === 0xFFFFFFFF) {
                        break;
                    }

                    if (header.flags !== 0xFFFFFFC0) {
                        continue;
                    }

                    const fsBlock: FFSBlock = { header, data: slice(blockData, header.offset, header.size) };

                    this.printData(fsBlock.data);

                    if (ffsMap.has(header.id)) {
                        if (skipDup) {
                            Logger.debug(`Duplicate id ${header.id}`);

                            continue;
                        }

                        throw new FilesystemError(`Duplicate id ${header.id}`);
                    }

                    ffsMap.set(header.id, fsBlock);
                }
            }

            let rootBlockId = 6;

            if (!ffsMap.has(rootBlockId)) {
                Logger.warn(`${partName} Root block (ID: 6) not found. Prototype? Trying add 6000`);

                rootBlockId += 6000;

                if (!ffsMap.has(rootBlockId)) {
                    if (skipBroken) {
                        Logger.warn(`${partName} Root block (ID: 6006) not found. Broken filesystem?`);

                        continue;
                    } else {
                        throw new FilesystemError(`${partName} Root block (ID: 6006) not found. Broken filesystem?`);
                    }
                } else {
                    this.prototype6000 = true;
                }
            }

            try {
                const rootBlock     = ffsMap.get(rootBlockId);
                const rootHeader    = SGOLD.readFileHeader(rootBlock.data);
                const timestamp     = fatTimestampToUnix(rootHeader.fatTimestamp);
                const attributes    = new Attributes(rootHeader.attributes);
                const root          = new Directory(partName, ROOT_PATH, attributes, timestamp);

                this.rootDir.addSubdir(root);

                this.scan(partName, ffsMap, root, rootHeader, skipBroken);
            } catch (e) {
                if (skipBroken && e instanceof BaseError) {
                    Logger.warn(`Skip. Broken root directory: ${e.message}`);
                } else {
                    throw e;
                }
            }
        }
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

        for (let offset = 0; offset < data.length; offset += 4) {
            const raw = readU32(data, offset);
            let   id  = raw & 0xFFFF;

            if (id === 0xFFFF) {
                continue;
            }

            if (id === 0) {
                continue;
            }

            if (this.prototype6000) {
                id = (id + 6000) & 0xFFFF;
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
                const tmp           = ffsMap.get(id);
                const fileHeader    = SGOLD.readFileHeader(tmp.data);
                const timestamp     = fatTimestampToUnix(fileHeader.fatTimestamp);
                const name          = fileHeader.utf8Name = sgoldNameToUtf8(fileHeader.name, this.codepage);
                const attributes    = new Attributes(fileHeader.attributes);

                if (this.verboseProcessing) {
                    Logger.info(`Processing ID: ${dec(id, 5)}, Path: ${blockName}${path}${name}`);
                }

                if (attributes.isDirectory()) {
                    const dirNext = new Directory(name, blockName + path, attributes, timestamp);

                    dir.addSubdir(dirNext);

                    this.scan(blockName, ffsMap, dirNext, fileHeader, skipBroken, `${path}${name}/`);
                } else {
                    let fileData: Uint8Array = new Uint8Array(0);

                    if (ffsMap.has(fileHeader.dataId)) {
                        fileData = this.readFullData(ffsMap, fileHeader);
                    }

                    dir.addFile(new File(name, blockName + path, fileData, attributes, timestamp));
                }
            } catch (e) {
                if (skipBroken && e instanceof BaseError) {
                    Logger.warn(`Skip. Broken file/directory: ${e.message}`);
                } else {
                    throw e;
                }
            }
        }

        if (skipBroken) {
            this.recourseProtector.pop();
        }
    }

    // The data record, then the data of every part: read_full_data() and read_recurse()
    private readFullData(ffsMap: FSBlocksMap, header: FileHeader): Uint8Array {
        const fileData = new ByteBuilder();

        this.printFileHeader(header);

        let dataId = header.dataId;

        if (this.prototype6000) {
            dataId = (dataId + 6000) & 0xFFFF;
        }

        if (!ffsMap.has(dataId)) {
            throw new FilesystemError(`Reading file data. Couldn't find block with id: ${dataId}`);
        }

        fileData.add(ffsMap.get(dataId).data);

        let nextId = header.nextPart;

        for (let length = 1; nextId !== 0xFFFF; ++length) {
            checkChainLength(length, ffsMap.size);

            if (!ffsMap.has(nextId)) {
                throw new FilesystemError(`Reading part. Couldn't find block with id: ${nextId}`);
            }

            const part = SGOLD.readFilePart(ffsMap.get(nextId).data);

            this.printFilePart(part);

            if (this.prototype6000) {
                part.dataId = (part.dataId + 6000) & 0xFFFF;
            }

            if (!ffsMap.has(part.dataId)) {
                throw new FilesystemError(`Reading part data. Couldn't find block with id: ${part.dataId}`);
            }

            fileData.add(ffsMap.get(part.dataId).data);

            nextId = part.nextPart;
        }

        return fileData.build();
    }
}

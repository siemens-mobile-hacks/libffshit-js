import { BaseError, FilesystemError } from "../../errors.js";
import { dec, hex, hexLower } from "../../format.js";
import { Logger } from "../../log.js";
import type { Partitions } from "../../partition/partitions.js";
import { ByteBuilder, readAligned, readBytes, readU16, readU32, slice } from "../../rawdata.js";
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
    size: number;
    fatTimestamp: number;
    attributes: number;
    unknown7: number;
    name: string;
}

interface DirHeader {
    id: number;
    unknown1: number;
    unknown2: number;
    unknown3: number;
}

interface FilePart {
    id: number;
    parentId: number;
    nextPart: number;
}

type FSBlocksMap = RecordMap<FFSBlock>;

// Numbers the names that do not convert, in every SGOLD2_ELKA filesystem loaded
const brokenNames = { value: 0 };

function checkEnd(header: FITHeader): boolean {
    return  header.flags    === 0xFFFFFFFF &&
            header.id       === 0xFFFFFFFF &&
            header.size     === 0xFFFFFFFF &&
            header.offset   === 0xFFFFFFFF;
}

// How much of the FIT a record inline in it takes: the entry, then 16 bytes of every 32
function calcAlignedSize(size: number): number {
    return Math.ceil((size / 16.0) + 1) * 32;
}

export class SGOLD2_ELKA extends Filesystem {
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
        this.writeSession("SGOLD2_ELKA", this.partitions, this.rootDir).writeFile(path, data, timestamp);
    }

    override createDirectory(path: string, timestamp: TimePoint): void {
        this.writeSession("SGOLD2_ELKA", this.partitions, this.rootDir).createDirectory(path, timestamp);
    }

    override remove(path: string): void {
        this.writeSession("SGOLD2_ELKA", this.partitions, this.rootDir).remove(path);
    }

    private printFileHeader(header: FileHeader): void {
        if (!this.verboseHeaders) {
            return;
        }

        Logger.debug("===========================");
        Logger.debug("File:");
        Logger.debug(`  ID:            ${hex(header.id, 4)} ${header.id}`);
        Logger.debug(`  Unknown1:      ${hex(header.unknown1, 4)} ${header.unknown1}`);
        Logger.debug(`  Parent ID:     ${hex(header.parentId, 4)} ${header.parentId}`);
        Logger.debug(`  Next part ID:  ${hex(header.nextPart, 4)} ${header.nextPart}`);
        Logger.debug(`  Size:          ${hex(header.size, 8)} ${header.size}`);
        Logger.debug(`  FAT timestamp: ${hex(header.fatTimestamp, 8)} ${header.fatTimestamp}`);
        Logger.debug(`  Attributes:    ${hex(header.attributes, 4)} ${header.attributes}`);
        Logger.debug(`  Unknown7:      ${hex(header.unknown7, 4)} ${header.unknown7}`);
        Logger.debug(`  Name:          ${header.name}`);
    }

    private printFilePart(part: FilePart): void {
        if (!this.verboseHeaders) {
            return;
        }

        Logger.debug("===========================");
        Logger.debug("Part:");
        Logger.debug(`  ID:             ${hex(part.id, 4)} ${part.id}`);
        Logger.debug(`  Parent ID:      ${hex(part.parentId, 4)} ${part.parentId}`);
        Logger.debug(`  Next part ID:   ${hex(part.nextPart, 4)} ${part.nextPart}`);
    }

    private static readFileHeader(block: FFSBlock): FileHeader {
        const data = block.data;
        const header: FileHeader = {
            id:             readU32(data, 0),
            unknown1:       readU32(data, 4),
            nextPart:       readU32(data, 8),
            parentId:       readU32(data, 12),
            size:           readU32(data, 16),
            fatTimestamp:   readU32(data, 20),
            attributes:     readU16(data, 24),
            unknown7:       readU16(data, 26),
            name:           "",
        };

        // Unlike SGOLD2, a header without a name fails to read it
        const nameBytes = readBytes(data, 28, data.length - 28);

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
        const image = this.partitions.getData();

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
                const blockHeader = block.getHeader();

                Logger.debug(`  ${partName} Block ${hex(block.getAddr(), 8)} ${hex(blockHeader.unknown1, 8)} ${hex(blockHeader.unknown2, 8)} ${hexLower(blockHeader.unknown3, 8)} Size: ${block.getSize()}`);

                const blockData = block.getData();
                const blockSize = block.getSize();
                const blockAddr = block.getAddr();

                let offset = (blockSize - 64) >>> 0;

                while (offset > 0) {
                    const header: FITHeader = {
                        flags:  readU32(blockData, offset),
                        id:     readU32(blockData, offset + 4),
                        size:   readU32(blockData, offset + 8),
                        offset: readU32(blockData, offset + 12),
                    };

                    const fitLog = (kind: string, sizeData: number): void => {
                        Logger.debug(`${partName} ${kind} ${hex((blockAddr + offset) >>> 0, 8)}: Flags: ${hex(header.flags, 8)} ID: ${hex(header.id, 8)} ` +
                            `Size: ${hex(header.size, 8)} Offset: ${hex(header.offset, 8)} - ${hex(sizeData, 4)}`);
                    };

                    if (checkEnd(header)) {
                        Logger.debug(`${partName} ${hex((blockAddr + offset) >>> 0, 8)}: Flags: ${hex(header.flags, 8)} ID: ${hex(header.id, 8)} ` +
                            `Size: ${hex(header.size, 8)} Offset: ${hex(header.offset, 8)} - End`);

                        break;
                    }

                    const valid                 = header.flags === 0xFFFFFFC0;
                    const blockHeaderSizeHi     = header.size & 0x1C00;
                    const blockHeaderSizeLo     = header.size & 0x3FF;

                    const readFromTable             = header.size <= 0x200;
                    const readFromTableAndOffset    = blockHeaderSizeHi !== 0 && blockHeaderSizeLo <= 0x200 && blockHeaderSizeLo > 0;
                    const readFromOffset            = !readFromTableAndOffset && !readFromTable;

                    let data: Uint8Array = new Uint8Array(0);

                    // Inline, under the entry
                    if (readFromTable) {
                        const sizeData = calcAlignedSize(header.size) >>> 0;

                        fitLog("T ", sizeData);

                        if (valid) {
                            data = readAligned(blockData, offset, header.size);
                        }

                        offset = (offset - sizeData) >>> 0;
                    }

                    // The 1 KiB units in the data area, the rest inline
                    if (readFromTableAndOffset) {
                        const readSize = header.size & 0x3FF;
                        const sizeData = calcAlignedSize(readSize);

                        fitLog("TO", sizeData);

                        if (valid) {
                            const builder = new ByteBuilder();

                            builder.add(slice(image, (blockAddr + header.offset) >>> 0, header.size & 0xC00));
                            builder.add(readAligned(blockData, offset, readSize));

                            data = builder.build();
                        }

                        offset = (offset - sizeData) >>> 0;
                    }

                    // In the data area
                    if (readFromOffset) {
                        fitLog("O ", 32);

                        if (valid) {
                            data = slice(image, (blockAddr + header.offset) >>> 0, header.size);
                        }

                        offset = (offset - 32) >>> 0;
                    }

                    if (header.flags !== 0xFFFFFFC0 && header.flags !== 0xFFFFFF00 && header.flags !== 0xFFFFFFF0) {
                        throw new FilesystemError(`fs_block.header.flags == ${hex(header.flags, 8)}`);
                    }

                    if (!valid) {
                        continue;
                    }

                    this.printData(data);

                    if (ffsMap.has(header.id)) {
                        if (skipDup) {
                            Logger.warn(`Duplicate id ${header.id}`);

                            continue;
                        }

                        throw new FilesystemError(`Duplicate id ${header.id}`);
                    }

                    ffsMap.set(header.id, { header, data });
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
                const rootHeader    = SGOLD2_ELKA.readFileHeader(rootBlock);
                const timestamp     = fatTimestampToUnix(rootHeader.fatTimestamp);
                const attributes    = new Attributes(rootHeader.attributes);
                const root          = new Directory(partName, ROOT_PATH, attributes, timestamp);

                this.printFileHeader(rootHeader);

                this.scan(partName, ffsMap, root, rootHeader, skipBroken);

                this.rootDir.addSubdir(root);
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
        const fileData  = new ByteBuilder();
        const dataId    = (header.id + 1) >>> 0;

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

            const part      = SGOLD2_ELKA.readFilePart(ffsMap.get(nextId).data);
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

        let dirData: Uint8Array;

        try {
            dirData = this.readFullData(ffsMap, header);
        } catch (e) {
            if (skipBroken && e instanceof BaseError) {
                Logger.warn(`Skip. Broken directory: ${e.message}`);

                this.recourseProtector.pop();

                return;
            } else {
                throw e;
            }
        }

        const dirList: DirHeader[] = [];

        for (let offset = 0; offset < dirData.length; offset += 8) {
            const dirHeader: DirHeader = {
                id:         readU16(dirData, offset),
                unknown1:   readU16(dirData, offset + 2),
                unknown2:   readU16(dirData, offset + 4),
                unknown3:   readU16(dirData, offset + 6),
            };

            if (dirHeader.id === 0xFFFF) {
                continue;
            }

            if (dirHeader.id === 0) {
                continue;
            }

            if (dirHeader.unknown3 !== 0xFFFF) {
                continue;
            }

            dirList.push(dirHeader);
        }

        for (const dirInfo of dirList) {
            if (!ffsMap.has(dirInfo.id)) {
                throw new FilesystemError(`scan() ID ${dirInfo.id} not found in ffs_map`);
            }

            try {
                const fileBlock     = ffsMap.get(dirInfo.id);
                const fileHeader    = SGOLD2_ELKA.readFileHeader(fileBlock);
                const timestamp     = fatTimestampToUnix(fileHeader.fatTimestamp);
                const attributes    = new Attributes(fileHeader.attributes);

                this.printFileHeader(fileHeader);

                if (this.verboseProcessing) {
                    Logger.info(`Processing ID: ${dec(dirInfo.id, 5)}, Path: ${blockName}${path}${fileHeader.name}`);
                }

                if (attributes.isDirectory()) {
                    const dirNext = new Directory(fileHeader.name, blockName + path, attributes, timestamp);

                    dir.addSubdir(dirNext);

                    this.scan(blockName, ffsMap, dirNext, fileHeader, skipBroken, `${path}${fileHeader.name}/`);
                } else {
                    let fileData: Uint8Array = new Uint8Array(0);

                    // A cache disk may have no data record
                    if (ffsMap.has((fileHeader.id + 1) >>> 0)) {
                        fileData = this.readFullData(ffsMap, fileHeader);
                    }

                    dir.addFile(new File(fileHeader.name, blockName + path, fileData, attributes, timestamp));
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
}

import { BaseError, FilesystemError } from "../../errors.js";
import { dec, hex } from "../../format.js";
import { Logger } from "../../log.js";
import type { Partitions } from "../../partition/partitions.js";
import { ByteBuilder, decodeUtf8, readString, readU16, readU32, slice } from "../../rawdata.js";
import { fatTimestampToUnix } from "../help.js";
import { Attributes, Directory, File } from "../structure.js";
import { checkChainLength, Filesystem, RecordMap, ROOT_NAME, ROOT_PATH } from "./base.js";

interface FITHeader {
    marker1: number;
    size: number;
    offset: number;
    blockId: number;
    marker2: number;
}

interface FFSBlock {
    header: FITHeader;
    data: Uint8Array;
    addrStart: number;
    addr: number;
}

interface FileHeader {
    id: number;
    parentId: number;
    fatTimestamp: number;
    dataId: number;
    attributes: number;
    unk4: number;
    nextPartId: number;
    name: string;
}

interface FFSFile {
    header: FileHeader;
    block: FFSBlock;
}

type FFSBlocksMap   = RecordMap<FFSBlock>;
type FFSFilesMap    = RecordMap<FFSFile>;

const ID_ADD = 6000;

// What std::map::at() throws for a key it lacks, which is none of the library's exceptions
class OutOfRangeError extends Error {
    override name = "OutOfRangeError";
}

export class EGOLD_CE extends Filesystem {
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

    private printBlockHeader(block: FFSBlock): void {
        if (!this.verboseHeaders) {
            return;
        }

        Logger.debug(`    ==== Offset: ${hex(block.addr, 8)} ====`);
        Logger.debug(`    Marker1:  ${hex(block.header.marker1, 4)}`);
        Logger.debug(`    Size:     ${hex(block.header.size, 4)}`);
        Logger.debug(`    Offset:   ${hex(block.header.offset, 8)} ${hex(block.addrStart, 8)}`);
        Logger.debug(`    Block ID: ${hex(block.header.blockId, 4)}`);
        Logger.debug(`    Marker2:  ${hex(block.header.marker2, 4)}`);
    }

    private printFileHeader(file: FFSFile): void {
        if (!this.verboseHeaders) {
            return;
        }

        Logger.debug(`    ID:           ${hex(file.header.id, 4)} ${file.header.id}`);
        Logger.debug(`    Parent:       ${hex(file.header.parentId, 4)} ${file.header.parentId}`);
        Logger.debug(`    Timestamp:    ${hex(file.header.fatTimestamp, 8)}`);
        Logger.debug(`    Attributes:   ${hex(file.header.attributes, 4)}`);
        Logger.debug(`    Data ID:      ${hex(file.header.dataId, 4)} ${hex(file.header.dataId + ID_ADD, 4)}`);
        Logger.debug(`    Unk4:         ${hex(file.header.unk4, 4)}`);
        Logger.debug(`    Next part ID: ${hex(file.header.nextPartId, 4)}`);

        if (file.header.name.length) {
            Logger.debug(`    Name:      ${file.header.name}`);
        }
    }

    private parseFIT(skipBroken: boolean, skipDup: boolean, partsToExtract: readonly string[]): void {
        const image         = this.partitions.getData();
        const baseAddress   = this.partitions.getDetector().getBaseAddress();

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

            const ffsBlocks: FFSBlocksMap = new RecordMap();
            const ffsFiles: FFSFilesMap   = new RecordMap();

            Logger.debug("Collecting FFS blocks");

            for (const block of partBlocks) {
                const blockData = block.getData();
                const blockSize = block.getSize();
                const blockAddr = block.getAddr();

                Logger.debug(`  Block: ${hex(blockAddr, 8)}, end: ${hex(blockAddr, 8)} ====`);

                for (let offset = blockSize - 12; offset > 0; offset -= 12) {
                    const fsBlock: FFSBlock = {
                        header: {
                            marker1:    readU16(blockData, offset),
                            size:       readU16(blockData, offset + 2),
                            offset:     readU32(blockData, offset + 4),
                            blockId:    readU16(blockData, offset + 8),
                            marker2:    readU16(blockData, offset + 10),
                        },
                        data:       new Uint8Array(0),
                        addrStart:  blockAddr,
                        addr:       (blockAddr + offset) >>> 0,
                    };

                    if (fsBlock.header.marker1 === 0xFFFF) {
                        break;
                    }

                    if ((fsBlock.header.marker1 & 0x00FF) === 0x00F0 && (fsBlock.header.marker2 & 0xFF00) === 0xF000) {
                        continue;
                    }

                    if ((fsBlock.header.marker1 & 0x00FF) !== 0xFC) {
                        continue;
                    }

                    this.printBlockHeader(fsBlock);

                    // The C++ library keeps the offset in a size_t, where a negative one wraps around
                    // to beyond the fullflash
                    fsBlock.data = slice(image, fsBlock.header.offset - baseAddress, fsBlock.header.size);

                    if (ffsBlocks.has(fsBlock.header.blockId)) {
                        if (skipDup) {
                            Logger.warn(`Block already exists. ${dec(fsBlock.header.blockId, 4, "0")} ${fsBlock.header.blockId}`);

                            continue;
                        }

                        throw new FilesystemError(`Block already exists. ${dec(fsBlock.header.blockId, 4, "0")} ${fsBlock.header.blockId}`);
                    }

                    ffsBlocks.set(fsBlock.header.blockId, fsBlock);
                }
            }

            Logger.debug("Collecting FFS files");

            for (const [, fsBlock] of ffsBlocks.entries()) {
                const isHeader = !(fsBlock.header.blockId & 1);

                this.printBlockHeader(fsBlock);
                this.printData(fsBlock.data);

                if (!isHeader) {
                    continue;
                }

                if (fsBlock.header.size < 0x10) {
                    continue;
                }

                const data = fsBlock.data;
                const file: FFSFile = {
                    header: {
                        id:             readU16(data, 0),
                        parentId:       readU16(data, 2),
                        fatTimestamp:   readU32(data, 4),
                        dataId:         readU16(data, 8),
                        attributes:     readU16(data, 10),
                        unk4:           readU16(data, 12),
                        nextPartId:     readU16(data, 14),
                        name:           "",
                    },
                    block: fsBlock,
                };

                // Old and new EGOLD
                if (fsBlock.header.size > 0x10) {
                    let nameOffset = 16;

                    if (fsBlock.header.size > 0x14 && readU32(data, 16) === 0xFFFFFFFF) {
                        nameOffset += 4;
                    }

                    let name = readString(data, nameOffset);

                    if (name.length >= 2 && name[0] === 0x1F) {
                        name = name.subarray(1);
                    }

                    file.header.name = decodeUtf8(name);
                }

                this.printFileHeader(file);

                if (ffsFiles.has(file.header.id)) {
                    if (skipDup) {
                        Logger.warn(`File id ${hex(file.header.id, 4)} already exists in map`);

                        continue;
                    }

                    throw new FilesystemError(`File id ${hex(file.header.id, 4)} already exists in map`);
                }

                ffsFiles.set(file.header.id, file);
            }

            if (!ffsFiles.has(6)) {
                throw new FilesystemError(`root block not found. Empty filesystem? ${partName}`);
            }

            try {
                const rootBlock     = ffsFiles.get(6);
                const timestamp     = fatTimestampToUnix(rootBlock.header.fatTimestamp);
                const attributes    = new Attributes(rootBlock.header.attributes);
                const root          = new Directory(partName, ROOT_PATH, attributes, timestamp);

                this.rootDir.addSubdir(root);

                this.scan(partName, ffsBlocks, ffsFiles, rootBlock, root, skipBroken);
            } catch (e) {
                if (skipBroken && e instanceof BaseError) {
                    Logger.warn(`Skip. Broken root directory: ${e.message}`);
                } else {
                    throw e;
                }
            }
        }
    }

    private scan(partName: string, ffsBlocks: FFSBlocksMap, ffsFiles: FFSFilesMap, file: FFSFile, dir: Directory, skipBroken: boolean, path = "/"): void {
        if (skipBroken) {
            if (this.recourseProtector.includes(file.header.id)) {
                throw new FilesystemError("Directory id already in list");
            }

            this.recourseProtector.push(file.header.id);
        }

        let dirData: Uint8Array;

        try {
            dirData = this.readFull(ffsBlocks, ffsFiles, file);
        } catch (e) {
            if (skipBroken && e instanceof BaseError) {
                Logger.warn(`Skip. Broken directory: ${e.message}`);

                this.recourseProtector.pop();

                return;
            } else {
                throw e;
            }
        }

        const dirIdList: number[] = [];

        // Entries of 4 bytes: the id, then the name's hash
        for (let i = 0; i < dirData.length; i += 4) {
            const id = readU16(dirData, i);

            if (id === 0x0000) {
                continue;
            }

            if (id === 0xFFFF) {
                continue;
            }

            dirIdList.push(id);
        }

        for (const id of dirIdList) {
            if (!ffsFiles.has(id)) {
                if (skipBroken) {
                    Logger.warn(`Skip. File record ID ${id} not found`);
                } else {
                    throw new FilesystemError(`File record ID ${id} not found`);
                }

                // The C++ library goes on to look the record up regardless
                throw new OutOfRangeError("Couldn't find the key.");
            }

            const entry         = ffsFiles.get(id);
            const timestamp     = fatTimestampToUnix(entry.header.fatTimestamp);
            const attributes    = new Attributes(entry.header.attributes);

            if (this.verboseProcessing) {
                Logger.info(`Processing ID: ${dec(entry.block.header.blockId, 5)} ${dec(entry.header.id, 5)}, Path: ${partName}${path}${entry.header.name}`);
            }

            this.printFileHeader(entry);

            try {
                if (attributes.isDirectory()) {
                    const dirNext = new Directory(entry.header.name, partName + path, attributes, timestamp);

                    dir.addSubdir(dirNext);

                    this.scan(partName, ffsBlocks, ffsFiles, entry, dirNext, skipBroken, `${path}${entry.header.name}/`);
                } else {
                    const fileData = this.readFull(ffsBlocks, ffsFiles, entry);

                    dir.addFile(new File(entry.header.name, partName + path, fileData, attributes, timestamp));
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

    // The data block, then the data of every part: read_full() and read_recurse()
    private readFull(ffsBlocks: FFSBlocksMap, ffsFiles: FFSFilesMap, file: FFSFile): Uint8Array {
        const data          = new ByteBuilder();
        const dataBlockId   = file.header.dataId + ID_ADD;

        if (!ffsBlocks.has(dataBlockId)) {
            return data.build();
        }

        data.add(ffsBlocks.get(dataBlockId).data);

        let nextFileId = file.header.nextPartId;

        for (let length = 1; nextFileId !== 0xFFFF; ++length) {
            checkChainLength(length, ffsFiles.size);

            if (!ffsFiles.has(nextFileId)) {
                throw new FilesystemError(`read_recurse() Next file id ${nextFileId} not found`);
            }

            const nextPart  = ffsFiles.get(nextFileId);
            const dataId    = nextPart.block.header.blockId + 1;

            if (!ffsBlocks.has(dataId)) {
                throw new FilesystemError(`read_recurse() Next data id ${dataId} not found`);
            }

            data.add(ffsBlocks.get(dataId).data);

            nextFileId = nextPart.header.nextPartId;
        }

        return data.build();
    }
}

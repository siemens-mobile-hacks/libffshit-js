/*
    Thanks to:

        Partitions search algorithm:
            Azq2, marry_on_me, Feyman

        SGOLD/SGOLD2/ELKA partitions table start address:
            Feyman

        EGOLD Disk resizing patches
        (Their patches assisted in the analysis of the disk partition table):
            kay
            AlexSid
            SiNgle
            Chaos
            avkiev
            Baloo
*/

import { FullflashError, PartitionsError } from "../errors.js";
import { hex, left } from "../format.js";
import type { Image } from "../image.js";
import { Logger } from "../log.js";
import { Pattern, type Readable } from "../patterns/pattern.js";
import { SGOLD_FF_ADDRESS_MASK, type Detector } from "../platform/detector.js";
import type { PlatformType } from "../platform/types.js";
import { isPrint, readBytes, readString, readU16, readU32, slice, toBinaryString } from "../rawdata.js";
import { Block, blockHeaderName, blockHeaderNameBytes, emptyBlockHeader, type BlockHeader } from "./block.js";
import { Partition } from "./partition.js";

const PATTERN_SG: Readable = [
    "?? ?? ?? A?", // name ptr
    "?? ?? 00 00",
    "?? ?? 00 00",
    "?? ?? ?? A?",
    "?? ?? 00 00",
    "?? ?? 00 00", // table size
    "?? ?? ?? A?", // table ptr
    "?? ?? ?? ??",
    "?? ?? ?? A?",
    "?? ?? ?? A?", // unk func
    "?? ?? ?? ??",
];

const PATTERN_NSG: Readable = [
    "?? ?? ?? A?", // name ptr
    "?? ?? 00 00",
    "?? ?? 00 00",
    "?? ?? ?? ??",
    "?? ?? ?? ??",
    "?? ?? ?? ??",
    "?? ?? ?? A?",
    "?? ?? 00 00",
    "?? ?? 00 00", // table size
    "?? ?? ?? A?", // table
    "?? ?? ?? ??",
    "?? ?? ?? A?",
    "?? ?? ?? ??",
];

const PATTERN_SG_NSG_TABLE_POINTER: Readable = [
    "4F 54 50 00",
    "?? ?? ?? A?",
];

const PATTERN_EGOLD: Readable = [
    "FE FE ?? ??",
    "?? ?? ?? ??",
    "?? ?? ?? ??",
    "?? ?? FE FE",
];

const PATTERN_EGOLD_TABLE_POINTER: Readable = [
    "??", "00", "00", "00",             // The number of records
    "0?", "00", "??", "??", "??", "0?", // The table's address
];

const POSSIBLE_PART_NAMES = [
    "BCORE",
    "EEFULL",
    "EELITE",
    "EXIT",
    "FFS",
    "UNUSED",
    "__FM__",
    "RIM",
];

// The index of the first 0 in the first `size` bytes, or `size`
function searchEnd(buf: Uint8Array, size: number): number {
    for (let i = 0; i < size; ++i) {
        if (buf[i] === 0) {
            return i;
        }
    }

    return size;
}

function isPrintable(buf: Uint8Array, size = buf.length): boolean {
    for (let i = 0; i < size; ++i) {
        if (!isPrint(buf[i])) {
            return false;
        }
    }

    return true;
}

function isEmpty(buf: Uint8Array): boolean {
    return buf.every((byte) => byte === 0xFF);
}

// EGOLD addresses are segment:offset, 16 KiB segments
function segmentToPage(segmentAddr: number): number {
    const segment       = segmentAddr >>> 16;
    const segmentOffset = segmentAddr & 0xFFFF;

    return (segment * 0x4000 + segmentOffset) >>> 0;
}

function pageToSegment(pageAddr: number): number {
    const segmentOffset = pageAddr & 0x3FFF;
    const segment       = ((pageAddr - segmentOffset) / 0x4000) & 0xFFFF;

    return ((segment << 16) | segmentOffset) >>> 0;
}

interface EgoldTable {
    recordsCount: number;
    blocksCount: number;
    offset: number;
}

// The partitions of a fullflash and their blocks. Only the FFS partitions are kept.
export class Partitions {
    private blockSize = 0;
    private readonly partitionsMap = new Map<string, Partition>();

    private readonly detector: Detector;
    private readonly image: Image;

    private fsPlatform: PlatformType;

    constructor(image: Image, detector: Detector, oldSearchAlgorithm: boolean, searchStartAddr = 0) {
        this.image      = image;
        this.detector   = detector;
        this.fsPlatform = detector.getPlatform();

        this.searchPartitions(oldSearchAlgorithm, searchStartAddr);

        Logger.debug(`Found ${this.partitionsMap.size} FFS partitions`);

        for (const [name, partition] of this.partitionsMap) {
            Logger.debug(`  ${left(name, 8)} ${partition.getBlocks().length}`);
        }
    }

    getPartitions(): ReadonlyMap<string, Partition> {
        return this.partitionsMap;
    }

    getData(): Uint8Array {
        return this.image.getData();
    }

    getImage(): Image {
        return this.image;
    }

    getDetector(): Detector {
        return this.detector;
    }

    // The platform of the filesystem, which the partition tables may tell apart from the detected one
    getFsPlatform(): PlatformType {
        return this.fsPlatform;
    }

    private get data(): Uint8Array {
        return this.image.getData();
    }

    private searchPartitions(oldSearchAlgorithm: boolean, startAddr: number): void {
        const oldSearch = (): void => {
            switch (this.detector.getPlatform()) {
                case "EGOLD_CE":    this.blockSize = 0x10000; this.oldSearchPartitionsEgoldCe(); break;
                case "SGOLD":
                case "SGOLD2":      this.blockSize = 0x10000; this.oldSearchPartitionsSgoldSgold2(); break;
                case "SGOLD2_ELKA": this.blockSize = 0x10000; this.oldSearchPartitionsSgold2Elka(); break;
                default: throw new PartitionsError("Couldn't detect fullflash platform");
            }
        };

        const newSearch = (): void => {
            switch (this.detector.getPlatform()) {
                case "EGOLD_CE":    this.searchPartitionsEgold(startAddr); break;
                case "SGOLD":       this.searchPartitionsSgold(startAddr); break;
                case "SGOLD2":      this.searchPartitionsSgold2(startAddr); break;
                case "SGOLD2_ELKA": this.searchPartitionsSgold2Elka(startAddr); break;
                default: throw new PartitionsError("Couldn't detect fullflash platform");
            }
        };

        if (oldSearchAlgorithm) {
            oldSearch();

            return;
        }

        newSearch();

        if (!this.partitionsMap.size) {
            Logger.warn("Partitions not found. Trying to use old search algorithm");

            oldSearch();
        } else {
            const ffsPartitionsFound = [...this.partitionsMap.keys()].some((name) => name.includes("FFS"));

            if (!ffsPartitionsFound) {
                Logger.warn("FFS Partitions not found. Trying to use old search algorithm");

                oldSearch();
            }
        }

        this.inspect();

        if (!this.partitionsMap.size) {
            throw new PartitionsError("Partitions not found");
        }
    }

    private checkPartName(name: string): boolean {
        if (name.length > 8) {
            return false;
        }

        return POSSIBLE_PART_NAMES.some((partName) => name.includes(partName));
    }

    private addPartitionBlock(name: string, block: Block): void {
        this.partitionsMap.get(name)!.addBlock(block);
    }

    private ensurePartition(name: string): void {
        if (!this.partitionsMap.has(name)) {
            this.partitionsMap.set(name, new Partition(name));
        }
    }

    // A block of `size` bytes from `addr`, as the C++ library copies it from the fullflash, which
    // it cannot do for no bytes
    private block(header: BlockHeader, addr: number, size: number): Block {
        if (size === 0) {
            throw new FullflashError("RawData() from raw ptr. data_size == 0");
        }

        return new Block(header, this.image, addr, size);
    }

    // Reads the name, two 16 bit fields and a 32 bit one: a block header of SGOLD, SGOLD2 and ELKA
    private readBlockHeader(offset: number): BlockHeader {
        const header = emptyBlockHeader();

        header.name     = readBytes(this.data, offset, 8);
        header.unknown1 = readU16(this.data, offset + 8);
        header.unknown2 = readU16(this.data, offset + 10);
        header.unknown3 = readU32(this.data, offset + 12);

        return header;
    }

    // Reads the name, then three 16 bit fields: a block header of EGOLD
    private readEgoldBlockHeader(offset: number): BlockHeader {
        const header = emptyBlockHeader();

        header.name.set(readBytes(this.data, offset, 6));
        header.unknown1 = readU16(this.data, offset + 6);
        header.unknown2 = readU16(this.data, offset + 8);
        header.unknown3 = readU16(this.data, offset + 10);

        return header;
    }

    private searchPartitionsEgold(startAddr: number): boolean {
        const baseAddress = this.detector.getBaseAddress() >>> 0;

        Logger.debug(`EGOLD Base address: ${hex(baseAddress, 8)}`);
        Logger.debug(`Searching partitions from 0x${hex(startAddr, 8)}`);

        const addresses = this.findPattern8(PATTERN_EGOLD_TABLE_POINTER, startAddr, false);

        Logger.debug(`Found ${addresses.length} matches`);

        if (!addresses.length) {
            return false;
        }

        addresses.reverse();

        const tables: EgoldTable[] = [];

        const validateTableStart = (offset: number, recordsCount: number): boolean => {
            for (let i = 0; i < recordsCount; ++i) {
                readU16(this.data, offset);

                const blockSegmentAddr  = readU32(this.data, offset + 2);
                const ffOffset          = (segmentToPage(blockSegmentAddr) - baseAddress) >>> 0;

                if (ffOffset >= this.data.length) {
                    return false;
                }

                if (ffOffset === 0) {
                    return false;
                }

                let   blockAddr = readU32(this.data, ffOffset);
                const wtf       = readU16(this.data, ffOffset + 4);

                if (wtf > 0x80) {
                    return false;
                }

                blockAddr = (blockAddr - baseAddress) >>> 0;

                if ((blockAddr & 0x0FFF) !== 0) {
                    return false;
                }

                const rdHeaderOffset = (((blockAddr + 2) >>> 0) | 0x80) >>> 0;

                if (rdHeaderOffset + 12 >= this.data.length) {
                    return false;
                }

                const header = this.readEgoldBlockHeader(rdHeaderOffset);

                if (!isPrintable(blockHeaderNameBytes(header))) {
                    return false;
                }

                offset += 6;
            }

            return true;
        };

        for (const addr of addresses) {
            const recordsCount      = readU32(this.data, addr);
            const blocksCount       = readU16(this.data, addr + 4);
            const blockSegmentAddr  = readU32(this.data, addr + 6);

            if (recordsCount === 0) {
                continue;
            }

            if (blocksCount === 0) {
                continue;
            }

            if (blocksCount > 4) {
                continue;
            }

            const ffOffset = (segmentToPage(blockSegmentAddr) - baseAddress) >>> 0;

            if (ffOffset >= this.data.length) {
                continue;
            }

            if (ffOffset === 0) {
                continue;
            }

            if (!validateTableStart(ffOffset, recordsCount)) {
                continue;
            }

            Logger.debug(`${hex(addr, 8)} ${hex((addr + baseAddress) >>> 0, 8)} ${hex(pageToSegment((addr + baseAddress) >>> 0), 8)}: ` +
                `Records count: ${hex(recordsCount, 8)}, Blocks count: ${hex(blocksCount, 4)}, Segment addr: ${hex(blockSegmentAddr, 8)}, ` +
                `Page addr: ${hex(ffOffset + baseAddress, 8)} ${hex(ffOffset, 8)}`);

            const tableRecord: EgoldTable = { blocksCount, offset: ffOffset, recordsCount };

            let skip = false;

            for (const table of tables) {
                if (table.offset === tableRecord.offset) {
                    Logger.debug("Dupicate table. A60? Skip");

                    skip = true;
                }
            }

            if (skip) {
                continue;
            }

            tables.push(tableRecord);
        }

        for (const table of tables) {
            let offset = table.offset;

            Logger.debug(`Table:     Page addr: ${hex((table.offset + baseAddress) >>> 0, 8)} -> ${hex(table.offset, 8)}, ` +
                `Segment addr: ${hex(pageToSegment((table.offset + baseAddress) >>> 0), 8)}, Records: `);

            for (let i = 0; i < table.recordsCount; ++i) {
                const blocksCount       = readU16(this.data, offset);
                const blockSegmentAddr  = readU32(this.data, offset + 2);
                const ffOffset          = (segmentToPage(blockSegmentAddr) - baseAddress) >>> 0;

                Logger.debug(`  Segment addr: ${hex(blockSegmentAddr, 8)}, Page addr: ${hex(ffOffset + baseAddress, 8)} -> ${hex(ffOffset, 8)}`);

                let   blockAddr = readU32(this.data, ffOffset);
                const wtf       = readU16(this.data, ffOffset + 4);

                blockAddr = (blockAddr - baseAddress) >>> 0;

                const rdHeaderOffset    = (((blockAddr + 2) >>> 0) | 0x80) >>> 0;
                const header            = this.readEgoldBlockHeader(rdHeaderOffset);
                const blockName         = blockHeaderName(header);

                Logger.debug(`    ${left(blockName, 6)} Block addr: ${hex((blockAddr + baseAddress) >>> 0, 8)} -> ${hex(blockAddr, 8)} WTF: ${hex(wtf, 4)}`);

                // Only the FFS ones are needed, for now
                if (blockName.includes("FFS")) {
                    this.ensurePartition(blockName);

                    let singleBlockSize = 65536;

                    // New EGOLD
                    if (wtf === 0x80) {
                        singleBlockSize *= 2;
                    }

                    const blockDataSize = singleBlockSize * blocksCount;

                    for (let j = 0; j < blocksCount; ++j) {
                        slice(this.data, blockAddr + singleBlockSize * j, singleBlockSize);
                    }

                    this.addPartitionBlock(blockName, new Block(header, this.image, (blockAddr & 0xFFFFFF00) >>> 0, blockDataSize));
                }

                offset += 6;
            }
        }

        return true;
    }

    private searchPartitionsSgold(startAddr: number): boolean {
        Logger.debug(`Searching partitions from 0x${hex(startAddr, 8)}`);

        let addressList     = this.findPattern(PATTERN_SG_NSG_TABLE_POINTER, startAddr, true);
        let byTablePattern  = false;

        if (!addressList.length) {
            Logger.debug("Table pointer not found. Searching by table pattern match");

            byTablePattern  = true;
            addressList     = this.findPattern(PATTERN_SG, startAddr, false);
        }

        for (const addr of addressList) {
            Logger.debug(`Pattern find, addr: ${hex(addr, 8)}`);

            let tableStartAddr: number;

            if (byTablePattern) {
                tableStartAddr = addr;
            } else {
                readBytes(this.data, addr, 4);

                tableStartAddr = (readU32(this.data, addr + 4) & SGOLD_FF_ADDRESS_MASK) >>> 0;

                if (!this.matchPattern(PATTERN_SG, tableStartAddr)) {
                    Logger.warn(`Partitions table at address: ${hex(tableStartAddr, 8)} doesn't match ad SGOLD table pattern. Skip.`);

                    continue;
                }

                Logger.debug(`Table start addr: ${hex(tableStartAddr, 8)}`);
            }

            const structSize = 0x2C;

            for (let offset = tableStartAddr; offset < tableStartAddr + 64 * structSize; offset += structSize) {
                let nameAddr        = readU32(this.data, offset + 0x00);
                const tableSize     = readU32(this.data, offset + 0x14);
                let tableAddr       = readU32(this.data, offset + 0x18);

                if (((nameAddr & 0xF0000000) >>> 0) !== 0xA0000000) {
                    break;
                }

                if (((tableAddr & 0xF0000000) >>> 0) !== 0xA0000000) {
                    break;
                }

                if (!tableSize) {
                    continue;
                }

                nameAddr    = (nameAddr & SGOLD_FF_ADDRESS_MASK) >>> 0;
                tableAddr   = (tableAddr & SGOLD_FF_ADDRESS_MASK) >>> 0;

                const partitionNameBytes    = readString(this.data, nameAddr);
                const partitionName         = toBinaryString(partitionNameBytes);

                if (!isPrintable(partitionNameBytes)) {
                    continue;
                }

                if (partitionName.includes(" ")) {
                    continue;
                }

                if (!this.checkPartName(partitionName)) {
                    continue;
                }

                Logger.debug(`Header. Name addr: ${hex(nameAddr, 8)}, Table addr: ${hex(tableAddr, 8)}, size ${hex(tableSize, 8)}, ${partitionName}`);

                const tableEnd = (tableSize * 8) >>> 0;

                for (let i = 0; i < tableEnd; i += 8) {
                    const blockAddr         = readU32(this.data, tableAddr + i);
                    const blockSize         = readU32(this.data, tableAddr + i + 4);
                    const maskedBlockAddr   = (blockAddr & SGOLD_FF_ADDRESS_MASK) >>> 0;
                    const maskedBlockSize   = (blockSize & SGOLD_FF_ADDRESS_MASK) >>> 0;

                    Logger.debug(`  Block:        Name: ${partitionName}, Addr: ${hex(maskedBlockAddr, 8)}, size: ${hex(maskedBlockSize, 8)}, table: ${hex(tableAddr + i, 8)}`);

                    // Only the FFS ones are needed, for now
                    if (partitionName.includes("FFS")) {
                        this.ensurePartition(partitionName);

                        const header = this.readBlockHeader(maskedBlockAddr);

                        if (header.unknown3 !== 0xFFFFFFF0) {
                            Logger.warn("Skip. The block is not formatted.");

                            continue;
                        }

                        Logger.debug(`  Block header: Name: ${blockHeaderName(header)}, Unk1: ${hex(header.unknown1, 4)}, Unk2: ${hex(header.unknown2, 4)}, Unk3: ${hex(header.unknown3, 8)}`);

                        this.addPartitionBlock(partitionName, this.block(header, maskedBlockAddr, maskedBlockSize));
                    }
                }
            }

            if (this.partitionsMap.size) {
                break;
            }
        }

        return true;
    }

    private searchPartitionsSgold2(startAddr: number): boolean {
        Logger.debug(`Searching partitions from 0x${hex(startAddr, 8)}`);

        let addressList     = this.findPattern(PATTERN_SG_NSG_TABLE_POINTER, startAddr, true);
        let byTablePattern  = false;

        if (this.detector.isSL75()) {
            Logger.warn("SL75 ja pierdole!");
        }

        if (!addressList.length) {
            Logger.debug("Table pointer not found. Searching by table pattern match");

            byTablePattern  = true;
            addressList     = this.findPattern(PATTERN_NSG, startAddr, false);
        }

        for (const addr of addressList) {
            Logger.debug(`Pattern find, addr: ${hex(addr, 8)}`);

            let tableStartAddr: number;

            if (byTablePattern) {
                tableStartAddr = addr;
            } else {
                readBytes(this.data, addr, 4);

                tableStartAddr = (readU32(this.data, addr + 4) & SGOLD_FF_ADDRESS_MASK) >>> 0;

                Logger.debug(`Table start addr: ${hex(tableStartAddr, 8)}`);
            }

            if (!this.matchPattern(PATTERN_NSG, tableStartAddr)) {
                if (this.matchPattern(PATTERN_SG, tableStartAddr)) {
                    Logger.warn(`Partitions table at address: ${hex(tableStartAddr, 8)} doesn't match as SGOLD2 table pattern.`);
                    Logger.warn("Detected platform SGOLD2, but partitions table format matched ad SGOLD. Using SGOLD partitions search. FS Platform overrided.");

                    this.fsPlatform = "SGOLD";

                    return this.searchPartitionsSgold(startAddr);
                }

                Logger.warn(`Partitions table at address: ${hex(tableStartAddr, 8)} doesn't match as SGOLD2 table pattern. Skip.`);

                continue;
            }

            const structSize = 0x34;

            for (let offset = tableStartAddr; offset < tableStartAddr + 64 * structSize; offset += structSize) {
                if (offset + structSize >= this.data.length) {
                    break;
                }

                let nameAddr        = readU32(this.data, offset + 0x00);
                const tableSize     = readU32(this.data, offset + 0x20);
                let tableAddr       = readU32(this.data, offset + 0x24);

                if (((nameAddr & 0xF0000000) >>> 0) !== 0xA0000000) {
                    break;
                }

                if (((tableAddr & 0xF0000000) >>> 0) !== 0xA0000000) {
                    break;
                }

                if (!tableSize) {
                    continue;
                }

                nameAddr    = (nameAddr & SGOLD_FF_ADDRESS_MASK) >>> 0;
                tableAddr   = (tableAddr & SGOLD_FF_ADDRESS_MASK) >>> 0;

                const partitionNameBytes    = readString(this.data, nameAddr);
                const partitionName         = toBinaryString(partitionNameBytes);

                if (!isPrintable(partitionNameBytes)) {
                    continue;
                }

                if (partitionName.includes(" ")) {
                    continue;
                }

                if (!this.checkPartName(partitionName)) {
                    continue;
                }

                Logger.debug(`Header. Name addr: ${hex(nameAddr, 8)}, Table addr: ${hex(tableAddr, 8)}, size ${hex(tableSize, 8)}, ${partitionName}`);

                const tableEnd = (tableSize * 8) >>> 0;

                for (let i = 0; i < tableEnd; i += 8) {
                    if (tableAddr + i >= this.data.length) {
                        break;
                    }

                    if (tableAddr + i + 4 >= this.data.length) {
                        break;
                    }

                    let   blockAddr = readU32(this.data, tableAddr + i);
                    const blockSize = readU32(this.data, tableAddr + i + 4);

                    if (((blockAddr & 0xFF000000) >>> 0) > 0xA2000000 && this.detector.isSL75()) {
                        const shit = 0xA4000000 - 0xA2000000;

                        Logger.debug(`  JA PIERDOLE! ${hex(blockAddr, 8)} -> ${hex(blockAddr - shit, 8)}`);

                        blockAddr -= shit;
                    }

                    const maskedBlockAddr = (blockAddr & SGOLD_FF_ADDRESS_MASK) >>> 0;
                    const maskedBlockSize = (blockSize & SGOLD_FF_ADDRESS_MASK) >>> 0;

                    Logger.debug(`  Block:        Name: ${partitionName}, Addr: ${hex(maskedBlockAddr, 8)}, size: ${hex(maskedBlockSize, 8)}, table: ${hex(tableAddr + i, 8)}`);

                    if (partitionName.includes("FFS")) {
                        const header = this.readBlockHeader(maskedBlockAddr);

                        if (header.unknown3 !== 0xFFFFFFF0) {
                            Logger.warn("Skip. The block is not formatted.");

                            continue;
                        }

                        Logger.debug(`  Block header: Name: ${blockHeaderName(header)}, Unk1: ${hex(header.unknown1, 4)}, Unk2: ${hex(header.unknown2, 4)}, Unk3: ${hex(header.unknown3, 8)}`);

                        this.ensurePartition(partitionName);
                        this.addPartitionBlock(partitionName, this.block(header, maskedBlockAddr, maskedBlockSize));
                    }
                }
            }

            if (this.partitionsMap.size) {
                break;
            }
        }

        if (!this.partitionsMap.size) {
            Logger.warn("Partitions not found. SGOLD2_ELKA prototype? Trying to search SGOLD2_ELKA partitions");

            if (this.searchPartitionsSgold2Elka(startAddr)) {
                this.fsPlatform = "SGOLD2_ELKA";

                return true;
            }
        }

        return this.partitionsMap.size !== 0;
    }

    private searchPartitionsSgold2Elka(startAddr: number): boolean {
        Logger.debug(`Searching partitions from 0x${hex(startAddr, 8)}`);

        let addressList     = this.findPattern(PATTERN_SG_NSG_TABLE_POINTER, startAddr, true);
        let byTablePattern  = false;

        if (!addressList.length) {
            Logger.debug("Table pointer not found. Searching by table pattern match");

            byTablePattern  = true;
            addressList     = this.findPattern(PATTERN_NSG, startAddr, false);
        }

        for (const addr of addressList) {
            Logger.debug(`Pattern find, addr: ${hex(addr, 8)}`);

            let tableStartAddr: number;

            if (byTablePattern) {
                tableStartAddr = addr;
            } else {
                readBytes(this.data, addr, 4);

                tableStartAddr = (readU32(this.data, addr + 4) & SGOLD_FF_ADDRESS_MASK) >>> 0;

                Logger.debug(`Table start addr: ${hex(tableStartAddr, 8)}`);
            }

            const structSize = 0x34;

            for (let offset = tableStartAddr; offset < tableStartAddr + 64 * structSize; offset += structSize) {
                if (offset + structSize >= this.data.length) {
                    break;
                }

                let nameAddr        = readU32(this.data, offset + 0x00);
                const tableSize     = readU32(this.data, offset + 0x20);
                let tableAddr       = readU32(this.data, offset + 0x24);

                if (((nameAddr & 0xF0000000) >>> 0) !== 0xA0000000) {
                    break;
                }

                if (((tableAddr & 0xF0000000) >>> 0) !== 0xA0000000) {
                    break;
                }

                if (!tableSize) {
                    continue;
                }

                nameAddr    = (nameAddr & SGOLD_FF_ADDRESS_MASK) >>> 0;
                tableAddr   = (tableAddr & SGOLD_FF_ADDRESS_MASK) >>> 0;

                const partitionNameBytes    = readString(this.data, nameAddr);
                const partitionName         = toBinaryString(partitionNameBytes);

                if (!isPrintable(partitionNameBytes)) {
                    continue;
                }

                if (partitionName.includes(" ")) {
                    continue;
                }

                if (!this.checkPartName(partitionName)) {
                    continue;
                }

                Logger.debug(`Header. Name addr: ${hex(nameAddr, 8)}, Table addr: ${hex(tableAddr, 8)}, size ${hex(tableSize, 8)}, ${partitionName}`);

                const tableEnd = (tableSize * 8) >>> 0;

                for (let i = 0; i < tableEnd; i += 8) {
                    if (tableAddr + i >= this.data.length) {
                        break;
                    }

                    if (tableAddr + i + 4 >= this.data.length) {
                        break;
                    }

                    const blockAddr         = readU32(this.data, tableAddr + i);
                    const blockSize         = readU32(this.data, tableAddr + i + 4);
                    const maskedBlockAddr   = (blockAddr & SGOLD_FF_ADDRESS_MASK) >>> 0;
                    const maskedBlockSize   = (blockSize & SGOLD_FF_ADDRESS_MASK) >>> 0;

                    Logger.debug(`  Block:        Name: ${partitionName}, Addr: ${hex(maskedBlockAddr, 8)}, size: ${hex(maskedBlockSize, 8)}, table: ${hex(tableAddr + i, 8)}`);

                    if (partitionName.includes("FFS")) {
                        this.ensurePartition(partitionName);

                        const header = this.readBlockHeader((maskedBlockAddr + maskedBlockSize - 0x20) >>> 0);

                        if (header.unknown3 !== 0xFFFFFFF0) {
                            Logger.warn("Skip. The patch for increasing the disk size has been installed, but the blocks have not been formatted? ");

                            continue;
                        }

                        Logger.debug(`  Block header: Name: ${blockHeaderName(header)}, Unk1: ${hex(header.unknown1, 4)}, Unk2: ${hex(header.unknown2, 4)}, Unk3: ${hex(header.unknown3, 8)}`);

                        this.addPartitionBlock(partitionName, this.block(header, maskedBlockAddr, maskedBlockSize));
                    }
                }
            }

            if (this.partitionsMap.size) {
                break;
            }
        }

        return true;
    }

    private oldSearchPartitionsEgoldCe(): void {
        const addresses = this.findPattern(PATTERN_EGOLD, 0x0, false);
        const headers   = new Map<number, BlockHeader>();

        for (const addr of addresses) {
            if ((addr & 0xFFF) !== 0x80) {
                continue;
            }

            const blockAddr = (addr & 0xFFFFFF00) >>> 0;
            const raw       = this.image.view(addr + 2, 12);
            const header    = emptyBlockHeader();

            header.name.set(raw.subarray(0, 6));
            header.unknown1 = raw[6] | (raw[7] << 8);
            header.unknown2 = raw[8] | (raw[9] << 8);
            header.unknown4 = raw[10] | (raw[11] << 8);

            const endOfName = searchEnd(header.name, 6);

            if (!isPrintable(header.name, endOfName)) {
                continue;
            }

            const partName = blockHeaderName(header);

            if (!partName.includes("FFS")) {
                continue;
            }

            if (headers.has(blockAddr)) {
                throw new PartitionsError(`Block with address ${hex(blockAddr, 8)} already exists`);
            }

            headers.set(blockAddr, header);

            Logger.debug(`Block: ${hex(blockAddr, 8)} ${partName} ${hex(header.unknown1, 4)} ${hex(header.unknown2, 4)} ${hex(header.unknown4, 4)}`);
        }

        if (headers.size >= 2) {
            const [block1Addr, block2Addr] = headers.keys();

            this.blockSize = (block2Addr - block1Addr) >>> 0;
        }

        Logger.debug(`Detected block size: ${hex(this.blockSize, 8)}`);

        for (const [blockAddr, header] of headers) {
            const blockName = blockHeaderName(header);

            this.ensurePartition(blockName);

            if (blockAddr + this.blockSize > this.data.length) {
                Logger.debug(`WTF? ${hex(blockAddr, 8)} ${this.blockSize}`);

                continue;
            }

            this.addPartitionBlock(blockName, this.block(header, blockAddr, this.blockSize));
        }
    }

    private oldSearchPartitionsSgoldSgold2(): void {
        for (let offset = 0; offset < this.data.length; offset += this.blockSize) {
            const headerSize = 4 + 2 + 2 + 8;

            if (isEmpty(this.image.view(offset, headerSize))) {
                continue;
            }

            const raw    = this.image.view(offset, 16);
            const header = emptyBlockHeader();

            header.name.set(raw.subarray(0, 8));
            header.unknown1 = raw[8] | (raw[9] << 8);
            header.unknown2 = raw[10] | (raw[11] << 8);
            header.unknown3 = (raw[12] | (raw[13] << 8) | (raw[14] << 16) | (raw[15] << 24)) >>> 0;

            if (header.unknown3 !== 0xFFFFFFF0) {
                continue;
            }

            const endOfName = searchEnd(header.name, 8);

            if (endOfName === 8) {
                continue;
            }

            if (!isPrintable(header.name, endOfName)) {
                continue;
            }

            const blockName = blockHeaderName(header);

            // Only the FFS ones are needed, for now
            if (!blockName.includes("FFS")) {
                continue;
            }

            this.ensurePartition(blockName);

            Logger.debug(`Name addr: ${blockName}, Addr: ${hex(offset, 8)}, size ${hex((this.blockSize * 2) >>> 0, 8)}`);

            this.addPartitionBlock(blockName, this.block(header, offset, (this.blockSize * 2) >>> 0));

            offset += this.blockSize;
        }
    }

    private oldSearchPartitionsSgold2Elka(): void {
        for (let offset = 0; offset < this.data.length; offset += this.blockSize) {
            const headerSize = 4 + 2 + 2 + 8;

            if (isEmpty(this.image.view(offset, headerSize))) {
                continue;
            }

            const raw    = this.image.view(offset + this.blockSize - 32, 16);
            const header = emptyBlockHeader();

            header.name.set(raw.subarray(0, 8));
            header.unknown1 = raw[8] | (raw[9] << 8);
            header.unknown2 = raw[10] | (raw[11] << 8);
            header.unknown3 = (raw[12] | (raw[13] << 8) | (raw[14] << 16) | (raw[15] << 24)) >>> 0;

            if (header.unknown3 !== 0xFFFFFFF0) {
                continue;
            }

            const endOfName = searchEnd(header.name, 8);

            if (endOfName === 8) {
                continue;
            }

            if (!isPrintable(header.name, endOfName)) {
                continue;
            }

            const blockName = blockHeaderName(header);

            // Only the FFS ones are needed, for now
            if (!blockName.includes("FFS")) {
                continue;
            }

            this.ensurePartition(blockName);

            const blockCount    = 4;
            const blockOffset   = (offset - this.blockSize * (blockCount - 1)) >>> 0;

            this.addPartitionBlock(blockName, this.block(header, blockOffset, (this.blockSize * blockCount) >>> 0));
        }
    }

    // Drops the partitions without blocks. The C++ library erases them from its ordered map while
    // iterating over it, erase(iter++), and which ones it gets to depends on how std::deque erases:
    // an element in the front half by shifting the ones before it up, so that the iterator moves
    // on to the next one, else the ones after it down, so that it skips the next one.
    private inspect(): void {
        const entries = [...this.partitionsMap.entries()];
        let   index   = 0;

        while (index < entries.length) {
            const [name, partition] = entries[index];

            if (partition.getBlocks().length === 0) {
                Logger.warn(`Partition ${name} has 0 blocks. Removed from part. map`);

                const frontHalf = index < (entries.length >> 1);

                entries.splice(index, 1);

                if (!frontHalf) {
                    // Past the end when it was the last one, where the C++ library reads freed memory
                    index += 1;
                }
            } else {
                ++index;
            }

            if (!entries.length) {
                break;
            }
        }

        this.partitionsMap.clear();

        for (const [name, partition] of entries) {
            this.partitionsMap.set(name, partition);
        }
    }

    // Addresses of matches from `start`, every other byte
    private findPattern8(readable: Readable, start: number, breakFirst: boolean): number[] {
        const pattern       = new Pattern(readable, 1);
        const addressList: number[] = [];
        const data          = this.data;
        const end           = data.length - readable.length;

        Logger.debug(`Searching pattern: ${pattern}`);

        const startTime = Date.now();

        for (let i = start; i < end; i += 2) {
            if (!pattern.match(data, i)) {
                continue;
            }

            addressList.push(i >>> 0);

            if (breakFirst) {
                break;
            }
        }

        Logger.debug(`Search end. Time: ${Date.now() - startTime} ms`);

        return addressList;
    }

    // Addresses of matches from `start`, every fourth byte
    private findPattern(readable: Readable, start: number, breakFirst: boolean): number[] {
        const pattern       = new Pattern(readable, 4);
        const first         = pattern.getFirst();
        const addressList: number[] = [];
        const data          = this.data;
        const end           = data.length - readable.length;

        Logger.debug(`Searching pattern: ${pattern}`);

        const startTime = Date.now();

        for (let i = start; i < end; i += 4) {
            // Past the end the bytes are undefined, which reads as 0
            const word = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);

            if (((word & first.mask) >>> 0) !== first.value || !pattern.match(data, i)) {
                continue;
            }

            addressList.push(i >>> 0);

            if (breakFirst) {
                break;
            }
        }

        Logger.debug(`Search end. Time: ${Date.now() - startTime} ms`);

        return addressList;
    }

    private matchPattern(readable: Readable, addr: number): boolean {
        return new Pattern(readable, 4).match(this.data, addr);
    }
}


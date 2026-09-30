// The records of one partition: data kept under an id. Every flash block of the partition has a
// file index table (FIT) growing from its end, with an entry per record: its state, id, size and
// where its data is.
//
// Records are only ever appended, deleted by clearing bits of their FIT entry's flags, or changed
// in place where that only clears bits, which is what the flash allows. When no block has room
// left, a block is compacted: rewritten with its valid records only, as the firmware's reclaim
// would, with its erase counter incremented. One block without valid records is left alone, for
// the firmware to reclaim into.

import { FilesystemError, FullflashError } from "../../errors.js";
import { dec } from "../../format.js";
import type { Partitions } from "../../partition/partitions.js";
import type { PlatformType } from "../../platform/types.js";
import { ByteBuilder, checkRead, slice } from "../../rawdata.js";

const FLAGS_FREE    = 0xFFFFFFFF;
const FLAGS_VALID   = 0xFFFFFFC0;
const FLAGS_DELETED = 0xFFFFFF00;

const MAX_ID = 0xFFFE;

export interface Entry {
    fitOffset: number;
    flags: number;
    id: number;
    size: number;
    offset: number;
}

export interface RecordsBlock {
    addr: number;
    size: number;
    entries: Entry[];
    // where the FIT entry of the next record goes; the FIT ends with a free entry here
    fitNext: number;
    // where the data of the next record goes
    dataEnd: number;
}

export abstract class Records {
    protected readonly image: Uint8Array;
    protected readonly blocks: RecordsBlock[] = [];

    private readonly partitionName: string;

    // id -> block and entry of its valid record
    private readonly index = new Map<number, [number, number]>();

    // ids that are taken: by a valid record, by an operation that has not written them yet, or
    // because the firmware's own records mention them
    private readonly used       = new Uint8Array(MAX_ID + 2);
    private readonly pending    = new Uint8Array(MAX_ID + 2);
    private readonly excluded   = new Uint8Array(MAX_ID + 2);
    // every pair below it is taken
    private freeHint = 0;

    // a block without valid records that is never written to
    private spare = -1;

    private inTransaction = false;
    // the original content of the blocks the operation wrote to, by block
    private readonly savedBlocks = new Map<number, Uint8Array>();

    static build(platform: PlatformType, partitions: Partitions, partitionName: string): Records {
        switch (platform) {
            case "SGOLD":
            case "SGOLD2":      return new LinearRecords(partitions, partitionName);
            case "SGOLD2_ELKA": return new ElkaRecords(partitions, partitionName);
            default: {
                throw new FilesystemError("Writing is not supported on this platform");
            }
        }
    }

    protected constructor(partitions: Partitions, partitionName: string) {
        this.partitionName = partitionName;

        const partition = partitions.getPartitions().get(partitionName);

        if (!partition) {
            throw new FilesystemError(`Partition ${partitionName} not found`);
        }

        this.image = partitions.getImage().getWritableData();

        for (const block of partition.getBlocks()) {
            this.blocks.push({ addr: block.getAddr(), size: block.getSize(), entries: [], fitNext: 0, dataEnd: 0 });
        }
    }

    // Reads the FITs and indexes the valid records. Called by the layouts once they are built.
    protected scan(): void {
        this.index.clear();

        this.used.fill(0);
        this.pending.fill(0);
        this.excluded.fill(0);

        this.freeHint = 0;

        for (let i = 0; i < this.blocks.length; ++i) {
            this.scanBlock(this.blocks[i]);
            this.indexBlock(i);
        }

        // The firmware's own records list ids: of the operations it logged, of the files it keeps
        // open. Whatever they mention is never handed out.
        for (let id = 1; id <= 5; ++id) {
            if (!this.contains(id)) {
                continue;
            }

            const data = this.read(id);

            for (let offset = 0; offset + 2 <= data.length; offset += 2) {
                this.excluded[data[offset] | (data[offset + 1] << 8)] = 1;
            }
        }

        // An erased block if there is one, else one whose records are all deleted
        if (this.spare < 0) {
            for (let i = 0; i < this.blocks.length; ++i) {
                const entries = this.blocks[i].entries;

                if (entries.some((entry) => entry.flags === FLAGS_VALID)) {
                    continue;
                }

                if (!entries.length) {
                    this.spare = i;

                    break;
                }

                if (this.spare < 0) {
                    this.spare = i;
                }
            }
        }
    }

    private indexBlock(blockIndex: number): void {
        const block = this.blocks[blockIndex];

        for (let i = 0; i < block.entries.length; ++i) {
            const entry = block.entries[i];

            if (entry.flags !== FLAGS_VALID) {
                continue;
            }

            if (this.index.has(entry.id)) {
                throw new FilesystemError(`Partition ${this.partitionName} has two records with id ${entry.id}. Broken filesystem? Not writing to it`);
            }

            this.index.set(entry.id, [blockIndex, i]);
            this.markUsed(entry.id, true);
        }
    }

    contains(id: number): boolean {
        return this.index.has(id);
    }

    // A copy of the record's data
    read(id: number): Uint8Array {
        const location = this.index.get(id);

        if (!location) {
            throw new FilesystemError(`Partition ${this.partitionName}: record ${id} not found`);
        }

        const block = this.blocks[location[0]];

        return this.readEntry(block, block.entries[location[1]]);
    }

    // A new record, of an id that has none
    add(id: number, data: Uint8Array): void {
        if (this.contains(id)) {
            throw new FilesystemError(`Partition ${this.partitionName}: record ${id} exists already`);
        }

        const blockIndex    = this.findBlock(data.length);
        const block         = this.blocks[blockIndex];

        this.touch(blockIndex);
        this.append(block, id, data);

        this.index.set(id, [blockIndex, block.entries.length - 1]);
        this.markUsed(id, true);
    }

    // Overwrites bytes of a record in place, which may only clear bits
    patch(id: number, offset: number, bytes: Uint8Array): void {
        const location = this.index.get(id);

        if (!location) {
            throw new FilesystemError(`Partition ${this.partitionName}: record ${id} not found`);
        }

        const block = this.blocks[location[0]];
        const entry = block.entries[location[1]];

        if (offset + bytes.length > entry.size) {
            throw new FilesystemError(`Partition ${this.partitionName}: patch of ${bytes.length} bytes at ${offset} is beyond record ${id} of ${entry.size} bytes`);
        }

        this.touch(location[0]);

        for (let i = 0; i < bytes.length; ++i) {
            const address = this.entryAddress(block, entry, offset + i);

            checkRead(this.image, address, 1);

            if ((this.image[address] & bytes[i]) !== bytes[i]) {
                throw new FilesystemError(`Partition ${this.partitionName}: changing record ${id} in place would set bits the flash cannot`);
            }

            this.write(address, bytes.subarray(i, i + 1));
        }
    }

    remove(id: number): void {
        const location = this.index.get(id);

        if (!location) {
            throw new FilesystemError(`Partition ${this.partitionName}: record ${id} not found`);
        }

        const block = this.blocks[location[0]];
        const entry = block.entries[location[1]];

        this.touch(location[0]);
        this.writeU32(block.addr + entry.fitOffset, FLAGS_DELETED);

        entry.flags = FLAGS_DELETED;

        this.index.delete(id);
        this.markUsed(id, false);
    }

    // The lowest free even id from `minId` on whose next id is free too: the firmware keeps a
    // file's data under the id after its header's
    allocatePair(minId: number): number {
        let id = Math.max(minId, this.freeHint);

        id += id & 1;

        while (this.taken(id) || this.taken(id + 1)) {
            if (id + 1 >= MAX_ID) {
                throw new FilesystemError(`Partition ${this.partitionName} has no free ids left`);
            }

            id += 2;
        }

        this.pending[id]     = 1;
        this.pending[id + 1] = 1;
        this.freeHint        = id + 2;

        return id;
    }

    // Undoes everything since begin() when an operation fails halfway
    begin(): void {
        this.inTransaction = true;
        this.savedBlocks.clear();
    }

    commit(): void {
        this.inTransaction = false;
        this.savedBlocks.clear();

        this.pending.fill(0);
    }

    rollback(): void {
        for (const [blockIndex, saved] of [...this.savedBlocks].sort((a, b) => a[0] - b[0])) {
            this.image.set(saved, this.blocks[blockIndex].addr);
        }

        this.inTransaction = false;
        this.savedBlocks.clear();

        this.scan();
    }

    private taken(id: number): boolean {
        if (id > MAX_ID) {
            return true;
        }

        return this.used[id] !== 0 || this.pending[id] !== 0 || this.excluded[id] !== 0;
    }

    private markUsed(id: number, isUsed: boolean): void {
        if (id > MAX_ID) {
            return;
        }

        this.used[id]    = isUsed ? 1 : 0;
        this.pending[id] = 0;

        if (!isUsed && id < this.freeHint) {
            this.freeHint = (id & ~1) >>> 0;
        }
    }

    private touch(blockIndex: number): void {
        if (!this.inTransaction || this.savedBlocks.has(blockIndex)) {
            return;
        }

        const block = this.blocks[blockIndex];

        this.savedBlocks.set(blockIndex, new Uint8Array(slice(this.image, block.addr, block.size)));
    }

    private deadSpace(block: RecordsBlock): number {
        let size = 0;

        for (const entry of block.entries) {
            if (entry.flags !== FLAGS_VALID) {
                size += entry.size + 16;
            }
        }

        return size;
    }

    private findBlock(size: number): number {
        // The block that fits it most tightly, so that the emptier blocks stay empty
        let best        = -1;
        let bestFree    = 0xFFFFFFFF;

        for (let i = 0; i < this.blocks.length; ++i) {
            if (i === this.spare || !this.fits(this.blocks[i], size)) {
                continue;
            }

            const free = (this.blocks[i].fitNext - this.blocks[i].dataEnd) >>> 0;

            if (free < bestFree) {
                best     = i;
                bestFree = free;
            }
        }

        if (best >= 0) {
            return best;
        }

        const candidates: number[] = [];

        for (let i = 0; i < this.blocks.length; ++i) {
            if (i !== this.spare && this.deadSpace(this.blocks[i]) !== 0) {
                candidates.push(i);
            }
        }

        // Array.prototype.sort() is stable, as std::stable_sort() is
        candidates.sort((a, b) => this.deadSpace(this.blocks[b]) - this.deadSpace(this.blocks[a]));

        for (const candidate of candidates) {
            this.compact(candidate);

            if (this.fits(this.blocks[candidate], size)) {
                return candidate;
            }
        }

        throw new FilesystemError(`Not enough free space in partition ${this.partitionName}`);
    }

    private compact(blockIndex: number): void {
        const block = this.blocks[blockIndex];
        const valid: [number, Uint8Array][] = [];

        for (const entry of block.entries) {
            if (entry.flags === FLAGS_VALID) {
                valid.push([entry.id, this.readEntry(block, entry)]);
            }
        }

        this.touch(blockIndex);
        this.erase(block);

        for (const [id, data] of valid) {
            this.append(block, id, data);

            this.index.set(id, [blockIndex, block.entries.length - 1]);
        }
    }

    // RawData::write()
    protected write(address: number, data: Uint8Array): void {
        if (data.length === 0) {
            return;
        }

        if (address < 0 || address + data.length > this.image.length) {
            throw new FullflashError(`RawData::write() Write size + offset > data size; Offset: ${dec(address)}, Write size: ${data.length}, Data size: ${this.image.length}`);
        }

        this.image.set(data, address);
    }

    protected writeU32(address: number, value: number): void {
        this.write(address, Uint8Array.of(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, value >>> 24));
    }

    protected readU32At(address: number): number {
        checkRead(this.image, address, 4);

        return (this.image[address] | (this.image[address + 1] << 8) | (this.image[address + 2] << 16) | (this.image[address + 3] << 24)) >>> 0;
    }

    protected fill(address: number, size: number): void {
        this.write(address, new Uint8Array(size).fill(0xFF));
    }

    protected incrementEraseCounter(address: number): void {
        checkRead(this.image, address, 2);

        let counter = this.image[address] | (this.image[address + 1] << 8);

        if (counter !== 0xFFFF) {
            ++counter;
        }

        this.write(address, Uint8Array.of(counter & 0xFF, counter >>> 8));
    }

    // A record's data where the C++ library copies it without looking: past the end of the
    // fullflash it reads what is there, taken for zeros here
    protected unchecked(address: number, size: number): Uint8Array {
        if (address >= 0 && address + size <= this.image.length) {
            return this.image.subarray(address, address + size);
        }

        const data = new Uint8Array(size);

        for (let i = 0; i < size; ++i) {
            data[i] = this.image[address + i] ?? 0;
        }

        return data;
    }

    // What differs between the layouts of the blocks
    protected abstract scanBlock(block: RecordsBlock): void;
    // A copy of the record's data
    protected abstract readEntry(block: RecordsBlock, entry: Entry): Uint8Array;
    // Where byte `offset` of a record is in the fullflash
    protected abstract entryAddress(block: RecordsBlock, entry: Entry, offset: number): number;
    protected abstract fits(block: RecordsBlock, size: number): boolean;
    // Writes the record and its FIT entry, and moves fitNext and dataEnd on
    protected abstract append(block: RecordsBlock, id: number, data: Uint8Array): void;
    // Everything but the block's header back to 0xFF, as an erase leaves it
    protected abstract erase(block: RecordsBlock): void;
}

// =========================================================================

const LINEAR_HEADER_SIZE    = 16;
const LINEAR_FIT_ENTRY_SIZE = 16;

// SGOLD and SGOLD2: a 16 byte header at the start of the block, the data packed after it and the
// FIT's 16 byte entries growing down from the block's end
class LinearRecords extends Records {
    constructor(partitions: Partitions, partitionName: string) {
        super(partitions, partitionName);

        this.scan();
    }

    protected scanBlock(block: RecordsBlock): void {
        block.entries = [];
        block.dataEnd = LINEAR_HEADER_SIZE;

        let offset = (block.size - LINEAR_FIT_ENTRY_SIZE) >>> 0;

        while (offset > 0) {
            const entry: Entry = {
                fitOffset:  offset,
                flags:      this.readU32At(block.addr + offset + 0x0),
                id:         this.readU32At(block.addr + offset + 0x4),
                size:       this.readU32At(block.addr + offset + 0x8),
                offset:     this.readU32At(block.addr + offset + 0xC),
            };

            if (entry.flags === FLAGS_FREE) {
                break;
            }

            block.entries.push(entry);

            const end = (entry.offset + entry.size) >>> 0;

            if (end <= block.size) {
                block.dataEnd = Math.max(block.dataEnd, end);
            }

            offset = (offset - LINEAR_FIT_ENTRY_SIZE) >>> 0;
        }

        block.fitNext = offset;
    }

    protected readEntry(block: RecordsBlock, entry: Entry): Uint8Array {
        if (entry.size === 0) {
            return new Uint8Array(0);
        }

        return new Uint8Array(slice(this.image, (block.addr + entry.offset) >>> 0, entry.size));
    }

    protected entryAddress(block: RecordsBlock, entry: Entry, offset: number): number {
        return ((block.addr + entry.offset) >>> 0) + offset;
    }

    protected fits(block: RecordsBlock, size: number): boolean {
        // The entry, and the free entry that ends the FIT after it
        return ((block.dataEnd + size + LINEAR_FIT_ENTRY_SIZE) >>> 0) <= block.fitNext;
    }

    protected append(block: RecordsBlock, id: number, data: Uint8Array): void {
        const size = data.length;

        if (size) {
            this.write(block.addr + block.dataEnd, data);
        }

        this.writeU32(block.addr + block.fitNext + 0x4, id);
        this.writeU32(block.addr + block.fitNext + 0x8, size);
        this.writeU32(block.addr + block.fitNext + 0xC, block.dataEnd);
        this.writeU32(block.addr + block.fitNext + 0x0, FLAGS_VALID);

        block.entries.push({ fitOffset: block.fitNext, flags: FLAGS_VALID, id, size, offset: block.dataEnd });

        block.dataEnd = (block.dataEnd + size) >>> 0;
        block.fitNext = (block.fitNext - LINEAR_FIT_ENTRY_SIZE) >>> 0;
    }

    protected erase(block: RecordsBlock): void {
        this.incrementEraseCounter(block.addr + 8);
        this.fill(block.addr + LINEAR_HEADER_SIZE, block.size - LINEAR_HEADER_SIZE);

        block.entries = [];
        block.dataEnd = LINEAR_HEADER_SIZE;
        block.fitNext = (block.size - LINEAR_FIT_ENTRY_SIZE) >>> 0;
    }
}

// =========================================================================

const ELKA_SLOT_SIZE        = 32;
const ELKA_SLOT_DATA_SIZE   = 16;
// The header takes the block's last slot, the FIT starts in the one below
const ELKA_HEADER_OFFSET    = ELKA_SLOT_SIZE;
const ELKA_FIT_OFFSET       = 2 * ELKA_SLOT_SIZE;
const ELKA_INLINE_MAX       = 0x200;
const ELKA_DATA_UNIT        = 0x400;
const ELKA_RECORD_MAX       = 0x1000;

const Kind = {
    INLINE:     0,
    SPLIT:      1,
    DATA_AREA:  2,
} as const;

function kind(size: number): number {
    const tail = size & (ELKA_DATA_UNIT - 1);

    if (size <= ELKA_INLINE_MAX) {
        return Kind.INLINE;
    }

    if ((size & 0x1C00) && tail > 0 && tail <= ELKA_INLINE_MAX) {
        return Kind.SPLIT;
    }

    return Kind.DATA_AREA;
}

function inlineSlotsSize(size: number): number {
    return ((1 + Math.floor(((size + ELKA_SLOT_DATA_SIZE - 1) >>> 0) / ELKA_SLOT_DATA_SIZE)) * ELKA_SLOT_SIZE) >>> 0;
}

// How much of the FIT a record takes
function fitSize(size: number): number {
    switch (kind(size)) {
        case Kind.INLINE:   return inlineSlotsSize(size);
        case Kind.SPLIT:    return inlineSlotsSize(size & (ELKA_DATA_UNIT - 1));
        default:                return ELKA_SLOT_SIZE;
    }
}

// How much of the data area a record takes
function dataAreaSize(size: number): number {
    switch (kind(size)) {
        case Kind.INLINE:   return 0;
        case Kind.SPLIT:    return (size & ~(ELKA_DATA_UNIT - 1)) >>> 0;
        default:                return (((size + ELKA_DATA_UNIT - 1) >>> 0) & ~(ELKA_DATA_UNIT - 1)) >>> 0;
    }
}

// SGOLD2_ELKA, whose flash programs 1 KiB regions either in control mode, where only the first 16
// bytes of every 32 hold data but can be programmed again, or in object mode, all of it, once. The
// header is at the block's end, the FIT grows down from below it in 32 byte slots with records up
// to 512 bytes inline under their entry, and larger records go to the data area growing up from
// the block's start in 1 KiB units. A record ending in up to 512 bytes past a 1 KiB multiple keeps
// that tail inline.
class ElkaRecords extends Records {
    constructor(partitions: Partitions, partitionName: string) {
        super(partitions, partitionName);

        this.scan();
    }

    protected scanBlock(block: RecordsBlock): void {
        block.entries = [];
        block.dataEnd = 0;

        let offset = (block.size - ELKA_FIT_OFFSET) >>> 0;

        while (offset > 0) {
            const entry: Entry = {
                fitOffset:  offset,
                flags:      this.readU32At(block.addr + offset + 0x0),
                id:         this.readU32At(block.addr + offset + 0x4),
                size:       this.readU32At(block.addr + offset + 0x8),
                offset:     this.readU32At(block.addr + offset + 0xC),
            };

            if (entry.flags === FLAGS_FREE && entry.id === 0xFFFFFFFF && entry.size === 0xFFFFFFFF && entry.offset === 0xFFFFFFFF) {
                break;
            }

            block.entries.push(entry);

            // An inline record notes where the data area ended when it was written
            const dataEnd = (entry.offset + dataAreaSize(entry.size)) >>> 0;

            if (dataEnd <= offset) {
                block.dataEnd = Math.max(block.dataEnd, dataEnd);
            }

            const step = fitSize(entry.size);

            if (step >= offset) {
                offset = 0;

                break;
            }

            offset -= step;
        }

        block.fitNext = offset;
    }

    private inlineAddress(block: RecordsBlock, fitOffset: number, size: number, offset: number): number {
        // The slot right under the entry holds the last 16 bytes, the lowest one the first bytes,
        // aligned to the end of its 16
        const slot          = Math.floor((size - 1 - offset) / ELKA_SLOT_DATA_SIZE);
        const slotOffset    = fitOffset - ELKA_SLOT_SIZE * (slot + 1);

        return block.addr + slotOffset + ELKA_SLOT_DATA_SIZE - (size - ELKA_SLOT_DATA_SIZE * slot - offset);
    }

    private readInline(block: RecordsBlock, fitOffset: number, size: number): Uint8Array {
        const data = new ByteBuilder();

        // A slot's bytes are contiguous, and only the first slot's are fewer than 16
        for (let offset = 0; offset < size;) {
            const chunk = (size - offset) % ELKA_SLOT_DATA_SIZE || ELKA_SLOT_DATA_SIZE;

            data.add(this.unchecked(this.inlineAddress(block, fitOffset, size, offset), chunk));

            offset += chunk;
        }

        return data.build();
    }

    private writeInline(block: RecordsBlock, fitOffset: number, data: Uint8Array): void {
        const size = data.length;

        for (let offset = 0; offset < size;) {
            const chunk = (size - offset) % ELKA_SLOT_DATA_SIZE || ELKA_SLOT_DATA_SIZE;

            this.write(this.inlineAddress(block, fitOffset, size, offset), data.subarray(offset, offset + chunk));

            offset += chunk;
        }
    }

    protected readEntry(block: RecordsBlock, entry: Entry): Uint8Array {
        switch (kind(entry.size)) {
            case Kind.INLINE: {
                return this.readInline(block, entry.fitOffset, entry.size);
            }

            case Kind.SPLIT: {
                const head = (entry.size & ~(ELKA_DATA_UNIT - 1)) >>> 0;
                const data = new ByteBuilder();

                data.add(slice(this.image, (block.addr + entry.offset) >>> 0, head));
                data.add(this.readInline(block, entry.fitOffset, entry.size - head));

                return data.build();
            }

            default: {
                return new Uint8Array(slice(this.image, (block.addr + entry.offset) >>> 0, entry.size));
            }
        }
    }

    protected entryAddress(block: RecordsBlock, entry: Entry, offset: number): number {
        switch (kind(entry.size)) {
            case Kind.INLINE: {
                return this.inlineAddress(block, entry.fitOffset, entry.size, offset);
            }

            case Kind.SPLIT: {
                const head = (entry.size & ~(ELKA_DATA_UNIT - 1)) >>> 0;

                if (offset < head) {
                    return ((block.addr + entry.offset) >>> 0) + offset;
                }

                return this.inlineAddress(block, entry.fitOffset, entry.size - head, offset - head);
            }

            default: {
                return ((block.addr + entry.offset) >>> 0) + offset;
            }
        }
    }

    protected fits(block: RecordsBlock, size: number): boolean {
        if (size > ELKA_RECORD_MAX) {
            return false;
        }

        const fit = fitSize(size);

        // The free entry that ends the FIT after it must stay above the data area
        return fit <= block.fitNext && ((block.fitNext - fit) >>> 0) >= ((block.dataEnd + dataAreaSize(size)) >>> 0);
    }

    protected append(block: RecordsBlock, id: number, data: Uint8Array): void {
        const size = data.length;

        switch (kind(size)) {
            case Kind.INLINE: {
                this.writeInline(block, block.fitNext, data);

                break;
            }

            case Kind.SPLIT: {
                const head = (size & ~(ELKA_DATA_UNIT - 1)) >>> 0;

                this.write(block.addr + block.dataEnd, data.subarray(0, head));
                this.writeInline(block, block.fitNext, data.subarray(head));

                break;
            }

            case Kind.DATA_AREA: {
                this.write(block.addr + block.dataEnd, data);

                break;
            }
        }

        this.writeU32(block.addr + block.fitNext + 0x4, id);
        this.writeU32(block.addr + block.fitNext + 0x8, size);
        this.writeU32(block.addr + block.fitNext + 0xC, block.dataEnd);
        this.writeU32(block.addr + block.fitNext + 0x0, FLAGS_VALID);

        block.entries.push({ fitOffset: block.fitNext, flags: FLAGS_VALID, id, size, offset: block.dataEnd });

        block.dataEnd = (block.dataEnd + dataAreaSize(size)) >>> 0;
        block.fitNext = (block.fitNext - fitSize(size)) >>> 0;
    }

    protected erase(block: RecordsBlock): void {
        this.incrementEraseCounter(block.addr + block.size - ELKA_HEADER_OFFSET + 8);
        this.fill(block.addr, block.size - ELKA_HEADER_OFFSET);

        block.entries = [];
        block.dataEnd = 0;
        block.fitNext = (block.size - ELKA_FIT_OFFSET) >>> 0;
    }
}

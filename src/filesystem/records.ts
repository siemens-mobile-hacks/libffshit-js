// The records of one partition: data kept under an id. Every flash block of the partition has a
// file index table (FIT) growing from its end, with an entry per record: its state, id, size and
// where its data is.
//
// Records are only ever appended, deleted by clearing bits of their FIT entry's flags, or changed
// in place where that only clears bits, which is what the flash allows. When no block has room
// left, a block is compacted: rewritten with its valid records only, as the firmware's reclaim
// would, with its erase counter incremented. One block without valid records is left alone, for
// the firmware to reclaim into.

import { concat, hex, le32, u16, u32 } from "../bytes.js";
import { FFSError } from "../errors.js";
import type { Platform } from "../fullflash/detector.js";
import type { Block, Partition } from "../fullflash/partitions.js";
import type { Image } from "../image.js";

const FLAGS_FREE    = 0xFFFFFFFF;
const FLAGS_VALID   = 0xFFFFFFC0;
const FLAGS_DELETED = 0xFFFFFF00;

const MAX_ID = 0xFFFE;

interface Entry {
    fitOffset: number;
    flags: number;
    id: number;
    size: number;
    // where its data is: in the block, or on EGOLD in the fullflash
    offset: number;
}

interface RecordsBlock {
    addr: number;
    size: number;
    entries: Entry[];
    // where the FIT entry of the next record goes; the FIT ends with a free entry here
    fitNext: number;
    // where the data of the next record goes
    dataEnd: number;
}

export abstract class Records {
    // What is wrong with the records: duplicate ids, records outside their block
    readonly problems: string[] = [];

    protected readonly blocks: RecordsBlock[];

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

    static open(platform: Platform, image: Image, partition: Partition): Records {
        switch (platform) {
            case "SGOLD":
            case "SGOLD2":      return new LinearRecords(image, partition);
            case "SGOLD2_ELKA": return new ElkaRecords(image, partition);
            case "EGOLD_CE":    return new EgoldRecords(image, partition);
        }
    }

    protected constructor(protected readonly image: Image, readonly partition: string, blocks: readonly Block[]) {
        this.blocks = blocks.map((block) => ({ addr: block.addr, size: block.size, entries: [], fitNext: 0, dataEnd: 0 }));
    }

    // Reads the FITs and indexes the valid records. Called by the layouts once they are built.
    protected scan(): void {
        this.index.clear();
        this.problems.length = 0;

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
            if (!this.has(id)) {
                continue;
            }

            const data = this.read(id);

            for (let offset = 0; offset + 2 <= data.length; offset += 2) {
                this.excluded[u16(data, offset)] = 1;
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

            if (!this.inBlock(block, entry)) {
                this.problems.push(`${this.partition}: record ${entry.id} of the block at ${hex(block.addr)} lies outside it`);

                continue;
            }

            // The first is kept
            if (this.index.has(entry.id)) {
                this.problems.push(`${this.partition}: two records with id ${entry.id}`);

                continue;
            }

            this.index.set(entry.id, [blockIndex, i]);
            this.markUsed(entry.id, true);
        }
    }

    has(id: number): boolean {
        return this.index.has(id);
    }

    // The ids of the valid records, in the order of the blocks and their FITs
    ids(): IterableIterator<number> {
        return this.index.keys();
    }

    // The record's data, which may be a view of the fullflash: it is only valid until the next write
    read(id: number): Uint8Array {
        const [block, entry] = this.locate(id);

        return this.readEntry(block, entry);
    }

    size(id: number): number {
        return this.locate(id)[1].size;
    }

    // A new record, of an id that has none
    add(id: number, data: Uint8Array): void {
        if (this.has(id)) {
            throw new FFSError(`${this.partition}: record ${id} exists already`);
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
        const [block, entry] = this.locate(id);

        if (offset + bytes.length > entry.size) {
            throw new FFSError(`${this.partition}: patch of ${bytes.length} bytes at ${offset} is beyond record ${id} of ${entry.size} bytes`);
        }

        this.touch(this.index.get(id)![0]);

        for (let i = 0; i < bytes.length; ++i) {
            const address = this.entryAddress(block, entry, offset + i);

            if ((this.image.data[address] & bytes[i]) !== bytes[i]) {
                throw new FFSError(`${this.partition}: changing record ${id} in place would set bits the flash cannot`);
            }

            this.write(address, bytes.subarray(i, i + 1));
        }
    }

    remove(id: number): void {
        const [block, entry] = this.locate(id);

        this.touch(this.index.get(id)![0]);
        this.write(block.addr + entry.fitOffset, le32(FLAGS_DELETED));

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
                throw new FFSError(`${this.partition} has no free ids left`);
            }

            id += 2;
        }

        this.pending[id]     = 1;
        this.pending[id + 1] = 1;
        this.freeHint        = id + 2;

        return id;
    }

    // Everything the operation writes, or on an error nothing
    transaction(operation: () => void): void {
        this.inTransaction = true;
        this.savedBlocks.clear();

        try {
            operation();
        } catch (e) {
            for (const [blockIndex, saved] of this.savedBlocks) {
                this.image.writable().set(saved, this.blocks[blockIndex].addr);
            }

            this.scan();

            throw e;
        } finally {
            this.inTransaction = false;
            this.savedBlocks.clear();
            this.pending.fill(0);
        }
    }

    private locate(id: number): [RecordsBlock, Entry] {
        const location = this.index.get(id);

        if (!location) {
            throw new FFSError(`${this.partition}: record ${id} not found`);
        }

        const block = this.blocks[location[0]];

        return [block, block.entries[location[1]]];
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
            this.freeHint = id & ~1;
        }
    }

    private touch(blockIndex: number): void {
        if (!this.inTransaction || this.savedBlocks.has(blockIndex)) {
            return;
        }

        const block = this.blocks[blockIndex];

        this.savedBlocks.set(blockIndex, this.image.data.slice(block.addr, block.addr + block.size));
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
        let bestFree    = Infinity;

        for (let i = 0; i < this.blocks.length; ++i) {
            if (i === this.spare || !this.fits(this.blocks[i], size)) {
                continue;
            }

            const free = this.blocks[i].fitNext - this.blocks[i].dataEnd;

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

        candidates.sort((a, b) => this.deadSpace(this.blocks[b]) - this.deadSpace(this.blocks[a]));

        for (const candidate of candidates) {
            this.compact(candidate);

            if (this.fits(this.blocks[candidate], size)) {
                return candidate;
            }
        }

        throw new FFSError(`Not enough free space in ${this.partition}`);
    }

    private compact(blockIndex: number): void {
        const block = this.blocks[blockIndex];
        const valid: [number, Uint8Array][] = [];

        for (const entry of block.entries) {
            if (entry.flags === FLAGS_VALID) {
                valid.push([entry.id, this.readEntry(block, entry).slice()]);
            }
        }

        this.touch(blockIndex);
        this.erase(block);

        for (const [id, data] of valid) {
            this.append(block, id, data);

            this.index.set(id, [blockIndex, block.entries.length - 1]);
        }
    }

    protected write(address: number, data: Uint8Array): void {
        this.image.writable().set(data, address);
    }

    protected fill(address: number, size: number): void {
        this.image.writable().fill(0xFF, address, address + size);
    }

    protected incrementEraseCounter(address: number): void {
        const counter = u16(this.image.data, address);

        if (counter !== 0xFFFF) {
            this.write(address, Uint8Array.of((counter + 1) & 0xFF, (counter + 1) >>> 8));
        }
    }

    protected fitEntry(block: RecordsBlock, fitOffset: number): Entry {
        const data = this.image.data;
        const addr = block.addr + fitOffset;

        return { fitOffset, flags: u32(data, addr), id: u32(data, addr + 4), size: u32(data, addr + 8), offset: u32(data, addr + 12) };
    }

    protected writeFitEntry(block: RecordsBlock, id: number, size: number): void {
        const addr = block.addr + block.fitNext;

        this.write(addr + 4, concat([le32(id), le32(size), le32(block.dataEnd)]));
        // Valid only once the rest is written
        this.write(addr, le32(FLAGS_VALID));

        block.entries.push({ fitOffset: block.fitNext, flags: FLAGS_VALID, id, size, offset: block.dataEnd });
    }

    // What differs between the layouts of the blocks
    protected abstract scanBlock(block: RecordsBlock): void;
    // Whether the valid record's data is in its block, as it must be to be read
    protected abstract inBlock(block: RecordsBlock, entry: Entry): boolean;
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
    constructor(image: Image, partition: Partition) {
        super(image, partition.name, partition.blocks);

        this.scan();
    }

    protected scanBlock(block: RecordsBlock): void {
        block.entries = [];
        block.dataEnd = LINEAR_HEADER_SIZE;

        let offset = block.size - LINEAR_FIT_ENTRY_SIZE;

        while (offset > 0) {
            const entry = this.fitEntry(block, offset);

            if (entry.flags === FLAGS_FREE) {
                break;
            }

            block.entries.push(entry);

            const end = entry.offset + entry.size;

            if (end <= block.size) {
                block.dataEnd = Math.max(block.dataEnd, end);
            }

            offset -= LINEAR_FIT_ENTRY_SIZE;
        }

        block.fitNext = Math.max(offset, 0);
    }

    protected inBlock(block: RecordsBlock, entry: Entry): boolean {
        return entry.offset + entry.size <= block.size;
    }

    protected readEntry(block: RecordsBlock, entry: Entry): Uint8Array {
        const start = block.addr + entry.offset;

        return this.image.data.subarray(start, start + entry.size);
    }

    protected entryAddress(block: RecordsBlock, entry: Entry, offset: number): number {
        return block.addr + entry.offset + offset;
    }

    protected fits(block: RecordsBlock, size: number): boolean {
        // The entry, and the free entry that ends the FIT after it
        return block.dataEnd + size + LINEAR_FIT_ENTRY_SIZE <= block.fitNext;
    }

    protected append(block: RecordsBlock, id: number, data: Uint8Array): void {
        this.write(block.addr + block.dataEnd, data);
        this.writeFitEntry(block, id, data.length);

        block.dataEnd += data.length;
        block.fitNext -= LINEAR_FIT_ENTRY_SIZE;
    }

    protected erase(block: RecordsBlock): void {
        this.incrementEraseCounter(block.addr + 8);
        this.fill(block.addr + LINEAR_HEADER_SIZE, block.size - LINEAR_HEADER_SIZE);

        block.entries = [];
        block.dataEnd = LINEAR_HEADER_SIZE;
        block.fitNext = block.size - LINEAR_FIT_ENTRY_SIZE;
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

const enum Kind {
    // In the FIT, under its entry
    INLINE,
    // The 1 KiB units in the data area, the rest inline
    SPLIT,
    DATA_AREA,
}

function kind(size: number): Kind {
    const tail = size & (ELKA_DATA_UNIT - 1);

    if (size <= ELKA_INLINE_MAX) {
        return Kind.INLINE;
    }

    if ((size & 0x1C00) && tail > 0 && tail <= ELKA_INLINE_MAX) {
        return Kind.SPLIT;
    }

    return Kind.DATA_AREA;
}

function inlineSlots(size: number): number {
    return Math.ceil(size / ELKA_SLOT_DATA_SIZE);
}

// The part of a record in the data area
function head(size: number): number {
    switch (kind(size)) {
        case Kind.INLINE:   return 0;
        case Kind.SPLIT:    return (size & ~(ELKA_DATA_UNIT - 1)) >>> 0;
        default:            return size;
    }
}

// How much of the FIT a record takes
function fitSize(size: number): number {
    return kind(size) === Kind.DATA_AREA ? ELKA_SLOT_SIZE : (1 + inlineSlots(size - head(size))) * ELKA_SLOT_SIZE;
}

// How much of the data area a record takes
function dataAreaSize(size: number): number {
    return Math.ceil(head(size) / ELKA_DATA_UNIT) * ELKA_DATA_UNIT;
}

// SGOLD2_ELKA, whose flash programs 1 KiB regions either in control mode, where only the first 16
// bytes of every 32 hold data but can be programmed again, or in object mode, all of it, once. The
// header is at the block's end, the FIT grows down from below it in 32 byte slots with records up
// to 512 bytes inline under their entry, and larger records go to the data area growing up from
// the block's start in 1 KiB units. A record ending in up to 512 bytes past a 1 KiB multiple keeps
// that tail inline.
class ElkaRecords extends Records {
    constructor(image: Image, partition: Partition) {
        super(image, partition.name, partition.blocks);

        this.scan();
    }

    protected scanBlock(block: RecordsBlock): void {
        block.entries = [];
        block.dataEnd = 0;

        let offset = block.size - ELKA_FIT_OFFSET;

        while (offset > 0) {
            const entry = this.fitEntry(block, offset);

            if (entry.flags === FLAGS_FREE && entry.id === 0xFFFFFFFF && entry.size === 0xFFFFFFFF && entry.offset === 0xFFFFFFFF) {
                break;
            }

            block.entries.push(entry);

            // An inline record notes where the data area ended when it was written
            const dataEnd = entry.offset + dataAreaSize(entry.size);

            if (dataEnd <= offset) {
                block.dataEnd = Math.max(block.dataEnd, dataEnd);
            }

            offset -= fitSize(entry.size);
        }

        block.fitNext = Math.max(offset, 0);
    }

    protected inBlock(block: RecordsBlock, entry: Entry): boolean {
        return entry.offset + head(entry.size) <= block.size &&
               entry.fitOffset >= inlineSlots(entry.size - head(entry.size)) * ELKA_SLOT_SIZE;
    }

    // The slot right under the entry holds the last 16 bytes, the lowest one the first bytes,
    // aligned to the end of its 16
    private inlineAddress(block: RecordsBlock, fitOffset: number, size: number, offset: number): number {
        const slot = Math.floor((size - 1 - offset) / ELKA_SLOT_DATA_SIZE);

        return block.addr + fitOffset - ELKA_SLOT_SIZE * (slot + 1) + ELKA_SLOT_DATA_SIZE - (size - ELKA_SLOT_DATA_SIZE * slot - offset);
    }

    // A slot's bytes are contiguous, and only the first slot's are fewer than 16
    private *inlineChunks(size: number): Generator<[number, number]> {
        for (let offset = 0; offset < size;) {
            const chunk = (size - offset) % ELKA_SLOT_DATA_SIZE || ELKA_SLOT_DATA_SIZE;

            yield [offset, chunk];

            offset += chunk;
        }
    }

    protected readEntry(block: RecordsBlock, entry: Entry): Uint8Array {
        const size      = entry.size;
        const headSize  = head(size);
        const data      = new Uint8Array(size);
        const start     = block.addr + entry.offset;

        data.set(this.image.data.subarray(start, start + headSize));

        for (const [offset, chunk] of this.inlineChunks(size - headSize)) {
            const address = this.inlineAddress(block, entry.fitOffset, size - headSize, offset);

            data.set(this.image.data.subarray(address, address + chunk), headSize + offset);
        }

        return data;
    }

    protected entryAddress(block: RecordsBlock, entry: Entry, offset: number): number {
        const headSize = head(entry.size);

        if (offset < headSize) {
            return block.addr + entry.offset + offset;
        }

        return this.inlineAddress(block, entry.fitOffset, entry.size - headSize, offset - headSize);
    }

    protected fits(block: RecordsBlock, size: number): boolean {
        if (size > ELKA_RECORD_MAX) {
            return false;
        }

        const fit = fitSize(size);

        // The free entry that ends the FIT after it must stay above the data area
        return fit <= block.fitNext && block.fitNext - fit >= block.dataEnd + dataAreaSize(size);
    }

    protected append(block: RecordsBlock, id: number, data: Uint8Array): void {
        const size      = data.length;
        const headSize  = head(size);

        this.write(block.addr + block.dataEnd, data.subarray(0, headSize));

        for (const [offset, chunk] of this.inlineChunks(size - headSize)) {
            this.write(this.inlineAddress(block, block.fitNext, size - headSize, offset), data.subarray(headSize + offset, headSize + offset + chunk));
        }

        this.writeFitEntry(block, id, size);

        block.dataEnd += dataAreaSize(size);
        block.fitNext -= fitSize(size);
    }

    protected erase(block: RecordsBlock): void {
        this.incrementEraseCounter(block.addr + block.size - ELKA_HEADER_OFFSET + 8);
        this.fill(block.addr, block.size - ELKA_HEADER_OFFSET);

        block.entries = [];
        block.dataEnd = 0;
        block.fitNext = block.size - ELKA_FIT_OFFSET;
    }
}

// =========================================================================

const EGOLD_FIT_ENTRY_SIZE = 12;

// EGOLD, which is only read: FIT entries of 12 bytes, whose records are anywhere in the fullflash,
// by their address in the phone's
class EgoldRecords extends Records {
    // The fullflash ends at 16 MiB in the phone's address space
    private readonly base: number;

    constructor(image: Image, partition: Partition) {
        super(image, partition.name, partition.blocks);

        this.base = 0x1000000 - image.data.length;

        this.scan();
    }

    protected scanBlock(block: RecordsBlock): void {
        const data = this.image.data;

        block.entries = [];

        for (let offset = block.size - EGOLD_FIT_ENTRY_SIZE; offset > 0; offset -= EGOLD_FIT_ENTRY_SIZE) {
            const addr  = block.addr + offset;
            const flags = u16(data, addr);

            if (flags === 0xFFFF) {
                break;
            }

            block.entries.push({
                fitOffset:  offset,
                flags:      (flags & 0xFF) === 0xFC ? FLAGS_VALID : FLAGS_DELETED,
                size:       u16(data, addr + 2),
                offset:     u32(data, addr + 4) - this.base,
                id:         u16(data, addr + 8),
            });
        }
    }

    protected inBlock(_block: RecordsBlock, entry: Entry): boolean {
        return entry.offset >= 0 && entry.offset + entry.size <= this.image.data.length;
    }

    protected readEntry(_block: RecordsBlock, entry: Entry): Uint8Array {
        return this.image.data.subarray(entry.offset, entry.offset + entry.size);
    }

    protected entryAddress(): number {
        throw new FFSError("EGOLD records are read only");
    }

    protected fits(): boolean {
        throw new FFSError("EGOLD records are read only");
    }

    protected append(): void {
        throw new FFSError("EGOLD records are read only");
    }

    protected erase(): void {
        throw new FFSError("EGOLD records are read only");
    }
}

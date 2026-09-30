/*
    Thanks to:

        Partitions search algorithm:
            Azq2, marry_on_me, Feyman

        SGOLD/SGOLD2/ELKA partitions table start address:
            Feyman

        EGOLD Disk resizing patches
        (Their patches assisted in the analysis of the disk partition table):
            kay, AlexSid, SiNgle, Chaos, avkiev, Baloo
*/

import { cString, hex, isPrintable, latin1, peek16, peek32 } from "../bytes.js";
import { FFSError } from "../errors.js";
import { Log } from "../log.js";
import type { Platform } from "./detector.js";
import { Pattern } from "./pattern.js";

export interface Block {
    addr: number;
    size: number;
}

// Only the filesystem's partitions are kept: FFS, FFS_0, FFS_C, ...
export interface Partition {
    name: string;
    blocks: Block[];
}

export interface Partitions {
    // The filesystem's, which the partition table may tell apart from the detected one
    platform: Platform;
    partitions: Partition[];
    // Where the fullflash starts in the phone's address space, by which EGOLD's FITs address records
    base: number;
}

// The partitions found, and what was wrong with the blocks, which is only reported if they are used
interface Found {
    platform: Platform;
    partitions: Map<string, Block[]>;
    problems: string[];
}

// "OTP\0" and the address of the partition table
export const TABLE_POINTER = new Pattern("4F 54 50 00  ?? ?? ?? A?");

// The first entry of a partition table: its name, the size and address of its list of blocks, ...
const SGOLD_TABLE = new Pattern(`
    ?? ?? ?? A?  ?? ?? 00 00  ?? ?? 00 00  ?? ?? ?? A?  ?? ?? 00 00  ?? ?? 00 00
    ?? ?? ?? A?  ?? ?? ?? ??  ?? ?? ?? A?  ?? ?? ?? A?  ?? ?? ?? ??
`);

const NEW_SGOLD_TABLE = new Pattern(`
    ?? ?? ?? A?  ?? ?? 00 00  ?? ?? 00 00  ?? ?? ?? ??  ?? ?? ?? ??  ?? ?? ?? ??  ?? ?? ?? A?
    ?? ?? 00 00  ?? ?? 00 00  ?? ?? ?? A?  ?? ?? ?? ??  ?? ?? ?? A?  ?? ?? ?? ??
`);

// The number of records, the number of blocks of the first, and the table's segment address
const EGOLD_TABLE_POINTER = new Pattern("?? 00 00 00  0? 00  ?? ?? ?? 0?");

// A block header between FE FE and FE FE
const EGOLD_BLOCK = new Pattern("FE FE ?? ??  ?? ?? ?? ??  ?? ?? ?? ??  ?? ?? FE FE");
export const EGOLD_HEADER_SIZE      = 16;
export const EGOLD_FIT_ENTRY_SIZE   = 12;
// The state a FIT entry begins and ends with
export const EGOLD_VALID            = 0xFC;
export const EGOLD_DELETED          = 0xF0;

export type EgoldPlatform = "EGOLD_CE" | "EGOLD";

// Where an EGOLD block has its header, after which its records are, and what blocks are multiples
// of: with Card-Explorer at 0x80 and of 64 KiB, without it at 0x10 and of 32 KiB
interface EgoldLayout {
    header: number;
    unit: number;
}

export function egoldLayout(platform: EgoldPlatform): EgoldLayout {
    return platform === "EGOLD_CE" ? { header: 0x80, unit: 0x10000 } : { header: 0x10, unit: 0x8000 };
}

// The x45's partition of a FAT disk, whose records are its sectors
export const LBA_FS = "LBA_FS";

const ADDRESS_MASK      = 0x0FFFFFFF;
const FORMATTED         = 0xFFFFFFF0;

interface TableLayout {
    platform: Platform;
    pattern: Pattern;
    entrySize: number;
    // Where an entry has the size and the address of its list of blocks
    sizeOffset: number;
    listOffset: number;
    // Where a block has its header: at its start, or 32 bytes before its end
    headerAtEnd: boolean;
}

const SGOLD_LAYOUT: TableLayout         = { platform: "SGOLD", pattern: SGOLD_TABLE, entrySize: 0x2C, sizeOffset: 0x14, listOffset: 0x18, headerAtEnd: false };
const SGOLD2_LAYOUT: TableLayout        = { platform: "SGOLD2", pattern: NEW_SGOLD_TABLE, entrySize: 0x34, sizeOffset: 0x20, listOffset: 0x24, headerAtEnd: false };
const SGOLD2_ELKA_LAYOUT: TableLayout   = { ...SGOLD2_LAYOUT, platform: "SGOLD2_ELKA", headerAtEnd: true };

function isFsName(name: Uint8Array): boolean {
    return name.length <= 8 && isPrintable(name) && latin1(name).includes("FFS");
}

// An SGOLD, SGOLD2 or ELKA block's header ends with 0xFFFFFFF0 once the block is formatted
function isFormatted(data: Uint8Array, header: number): boolean {
    return peek32(data, header + 12) === FORMATTED;
}

function formattedBlockName(data: Uint8Array, header: number): string | undefined {
    if (!isFormatted(data, header)) {
        return undefined;
    }

    const name = cString(data, header, 8);

    return name.length < 8 && isPrintable(name) ? latin1(name) : undefined;
}

class Search {
    readonly partitions = new Map<string, Block[]>();
    readonly problems: string[] = [];
    // Of a dump cut short, by partition: the addresses of the blocks past its end
    private readonly cut = new Map<string, number[]>();

    constructor(readonly data: Uint8Array, readonly log: Log) {
    }

    // With the address of its header when it has to be formatted
    add(name: string, block: Block, header?: number): void {
        if (block.size === 0) {
            this.problems.push(`The block of ${name} at ${hex(block.addr)} is empty`);

            return;
        }

        if (block.addr + block.size > this.data.length) {
            this.cut.set(name, [...this.cut.get(name) ?? [], block.addr]);

            return;
        }

        if (header !== undefined && !isFormatted(this.data, header)) {
            this.problems.push(`The block of ${name} at ${hex(block.addr)} is not formatted`);

            return;
        }

        this.log.debug(`${name}: block at ${hex(block.addr)}, ${hex(block.size)} bytes`);

        const blocks = this.partitions.get(name);

        if (blocks) {
            blocks.push(block);
        } else {
            this.partitions.set(name, [block]);
        }
    }

    found(platform: Platform): Found | undefined {
        for (const [name, [first, ...others]] of this.cut) {
            this.problems.push(others.length
                ? `${others.length + 1} blocks of ${name}, starting from ${hex(first)}, end past the end of the fullflash`
                : `The block of ${name} at ${hex(first)} ends past the end of the fullflash`);
        }

        return this.partitions.size ? { platform, partitions: this.partitions, problems: this.problems } : undefined;
    }
}

// =========================================================================
// The partition table of SGOLD, SGOLD2 and ELKA

// Where the partition tables may be: where "OTP\0" points to, else wherever the pattern matches
function* tableCandidates(data: Uint8Array, pattern: Pattern): Generator<{ addr: number, pointed: boolean }> {
    let pointed = false;

    for (const pointer of TABLE_POINTER.find(data, 4)) {
        pointed = true;

        yield { addr: peek32(data, pointer + 4)! & ADDRESS_MASK, pointed: true };
    }

    if (!pointed) {
        for (const addr of pattern.find(data, 4)) {
            yield { addr, pointed: false };
        }
    }
}

function parseTable(data: Uint8Array, table: number, layout: TableLayout, sl75: boolean, log: Log): Found | undefined {
    const search = new Search(data, log);

    log.debug(`${layout.platform} partition table at ${hex(table)}`);

    for (let entry = table; entry < table + 64 * layout.entrySize; entry += layout.entrySize) {
        const nameAddr  = peek32(data, entry);
        const size      = peek32(data, entry + layout.sizeOffset);
        const list      = peek32(data, entry + layout.listOffset);

        if (nameAddr === undefined || size === undefined || list === undefined) {
            break;
        }

        if ((nameAddr & 0xF0000000) >>> 0 !== 0xA0000000 || (list & 0xF0000000) >>> 0 !== 0xA0000000) {
            break;
        }

        const nameBytes = cString(data, nameAddr & ADDRESS_MASK);

        if (!size || !isFsName(nameBytes) || nameBytes.includes(0x20)) {
            continue;
        }

        const name      = latin1(nameBytes);
        const listAddr  = list & ADDRESS_MASK;

        for (let i = 0; i < size; ++i) {
            let   addr      = peek32(data, listAddr + i * 8);
            const blockSize = peek32(data, listAddr + i * 8 + 4);

            if (addr === undefined || blockSize === undefined) {
                break;
            }

            // Its fullflash is mapped from 0xA2000000, its flash from 0xA4000000
            if (sl75 && layout === SGOLD2_LAYOUT && (addr & 0xFF000000) >>> 0 > 0xA2000000) {
                addr -= 0x2000000;
            }

            const block = { addr: addr & ADDRESS_MASK, size: blockSize & ADDRESS_MASK };

            search.add(name, block, layout.headerAtEnd ? block.addr + block.size - 0x20 : block.addr);
        }
    }

    return search.found(layout.platform);
}

function searchTables(data: Uint8Array, layout: TableLayout, sl75: boolean, log: Log): Found | undefined {
    for (const candidate of tableCandidates(data, layout.pattern)) {
        const { addr } = candidate;

        if (layout === SGOLD2_LAYOUT && !NEW_SGOLD_TABLE.matches(data, addr)) {
            if (SGOLD_TABLE.matches(data, addr)) {
                log.debug(`The partition table at ${hex(addr)} is an SGOLD one: the filesystem is SGOLD's`);

                return searchTables(data, SGOLD_LAYOUT, sl75, log);
            }

            log.debug(`No partition table at ${hex(addr)}`);

            continue;
        }

        if (layout === SGOLD_LAYOUT && candidate.pointed && !SGOLD_TABLE.matches(data, addr)) {
            log.debug(`No partition table at ${hex(addr)}`);

            continue;
        }

        const found = parseTable(data, addr, layout, sl75, log);

        if (found) {
            return found;
        }
    }

    // An ELKA prototype, with an SGOLD2 boot core
    if (layout === SGOLD2_LAYOUT) {
        return searchTables(data, SGOLD2_ELKA_LAYOUT, sl75, log);
    }

    return undefined;
}

// Whether "OTP\0" points to a partition table of ELKA's, with formatted blocks: of a dump without the
// boot core's name where the detector reads it, as some E71s' have it elsewhere or erased
export function hasElkaTable(data: Uint8Array): boolean {
    for (const pointer of TABLE_POINTER.find(data, 4)) {
        const table = peek32(data, pointer + 4)! & ADDRESS_MASK;

        if (NEW_SGOLD_TABLE.matches(data, table) && parseTable(data, table, SGOLD2_ELKA_LAYOUT, false, new Log())) {
            return true;
        }
    }

    return false;
}

// =========================================================================
// The partition table of EGOLD

// Addresses are segment:offset, with 16 KiB segments
function segmentToPage(segmentAddr: number): number {
    return (segmentAddr >>> 16) * 0x4000 + (segmentAddr & 0xFFFF);
}

function isEgoldFsName(name: Uint8Array): boolean {
    return isFsName(name) || latin1(name) === LBA_FS;
}

function isEgoldBlock(data: Uint8Array, addr: number, layout: EgoldLayout): boolean {
    return EGOLD_BLOCK.matches(data, addr + layout.header) && isEgoldFsName(cString(data, addr + layout.header + 2, 6));
}

// Whether there are blocks of an EGOLD filesystem of the platform
export function hasEgoldBlocks(data: Uint8Array, platform: EgoldPlatform): boolean {
    const layout = egoldLayout(platform);

    for (let addr = 0; addr + layout.header + EGOLD_HEADER_SIZE <= data.length; addr += layout.unit) {
        if (isEgoldBlock(data, addr, layout)) {
            return true;
        }
    }

    return false;
}

// A block ends a multiple of the layout's unit on, where its FIT ends with the entry of its first
// record, which is right after the block's header: the block's size, and where the phone has that
// record. Undefined for an erased block.
function egoldFirstRecord(data: Uint8Array, addr: number, layout: EgoldLayout): { size: number, address: number } | undefined {
    for (let size = layout.unit; addr + size <= data.length; size += layout.unit) {
        const entry = addr + size - EGOLD_FIT_ENTRY_SIZE;
        const state = data[entry];

        if ((state === EGOLD_VALID || state === EGOLD_DELETED) && data[entry + 11] === state) {
            return { size, address: peek32(data, entry + 4)! };
        }

        // Of any block, of the filesystem or not
        if (EGOLD_BLOCK.matches(data, addr + size + layout.header)) {
            return undefined;
        }
    }

    return undefined;
}

// Where the fullflash starts in the phone's address space, which depends on the phone and on what
// the dump was made of. Most of the blocks tell. Without any, the fullflash is taken to end at 16
// MiB.
function egoldBase(data: Uint8Array, layout: EgoldLayout): number {
    const votes = new Map<number, number>();

    for (let addr = 0; addr + layout.header + EGOLD_HEADER_SIZE <= data.length; addr += layout.unit) {
        const first = isEgoldBlock(data, addr, layout) ? egoldFirstRecord(data, addr, layout) : undefined;

        if (!first) {
            continue;
        }

        // Of a mirror of the flash, where the addresses are of the other copy, it is negative
        const base = first.address - (addr + layout.header + EGOLD_HEADER_SIZE);

        if (base >= 0 && !(base & 0xFFFF)) {
            votes.set(base, (votes.get(base) ?? 0) + 1);
        }
    }

    const [best] = [...votes].sort((a, b) => b[1] - a[1]);

    return best ? best[0] : 0x1000000 - data.length;
}

// The record of a block in a table: its number of sectors, and where its address and the size of
// its sectors in KiB are
function egoldRecord(data: Uint8Array, base: number, offset: number, layout: EgoldLayout): { size: number, addr: number, name: Uint8Array } | undefined {
    const sectors   = peek16(data, offset);
    const segment   = peek32(data, offset + 2);

    if (sectors === undefined || segment === undefined) {
        return undefined;
    }

    const page      = segmentToPage(segment) - base;
    const address   = peek32(data, page);
    const kib       = peek16(data, page + 4);

    if (page <= 0 || address === undefined || !kib || kib > 0x80 || (kib & (kib - 1))) {
        return undefined;
    }

    const addr = address - base;

    if (addr < 0 || (addr & 0xFFF) !== 0 || addr + layout.header + 14 >= data.length) {
        return undefined;
    }

    return { size: sectors * kib * 0x400, addr, name: cString(data, addr + layout.header + 2, 6) };
}

function searchEgoldTables(data: Uint8Array, base: number, platform: EgoldPlatform, log: Log): Found | undefined {
    const search = new Search(data, log);
    const tables = new Set<number>();
    const layout = egoldLayout(platform);

    // From the last on. Where there are no records, or no blocks of the first, which the pattern
    // matches wherever the fullflash is of zeros, is passed over at once.
    for (let pointer = (data.length - EGOLD_TABLE_POINTER.length) & ~1; pointer >= 0; pointer -= 2) {
        if (!data[pointer] || !data[pointer + 4] || !EGOLD_TABLE_POINTER.matches(data, pointer)) {
            continue;
        }

        const records   = peek32(data, pointer)!;
        const blocks    = peek16(data, pointer + 4)!;
        const table     = segmentToPage(peek32(data, pointer + 6)!) - base;

        if (!records || !blocks || blocks > 4 || table <= 0 || table >= data.length || tables.has(table)) {
            continue;
        }

        const entries = Array.from({ length: records }, (_, i) => egoldRecord(data, base, table + i * 6, layout));

        if (entries.some((entry) => !entry || !isPrintable(entry.name))) {
            continue;
        }

        log.debug(`EGOLD partition table at ${hex(table)}, ${records} records`);

        tables.add(table);

        for (const entry of entries) {
            if (isEgoldFsName(entry!.name)) {
                search.add(latin1(entry!.name), { addr: entry!.addr, size: entry!.size });
            }
        }
    }

    return search.found(platform);
}

// =========================================================================
// Without a partition table: the blocks by their headers

// A partition's blocks are of one size, which their FITs tell: a dump may lack some of the blocks,
// and have others of the flash in between
function searchEgoldBlocks(data: Uint8Array, base: number, platform: EgoldPlatform, log: Log): Found | undefined {
    const search = new Search(data, log);
    const layout = egoldLayout(platform);
    const blocks: { addr: number, name: string, size?: number }[] = [];

    for (const addr of EGOLD_BLOCK.find(data, 4)) {
        const name = cString(data, addr + 2, 6);

        if ((addr & 0xFFF) === layout.header && isEgoldFsName(name)) {
            blocks.push({ addr: addr - layout.header, name: latin1(name) });
        }
    }

    // Up to the next block
    const limits = blocks.map((block, i) => (blocks[i + 1]?.addr ?? data.length) - block.addr);

    blocks.forEach((block, i) => {
        const first = egoldFirstRecord(data, block.addr, layout);

        if (first && first.size <= limits[i] && first.address === base + block.addr + layout.header + EGOLD_HEADER_SIZE) {
            block.size = first.size;
        }
    });

    blocks.forEach((block, i) => {
        // An erased block is of the size of its partition's others
        const other = blocks.find((other) => other.name === block.name && other.size);

        search.add(block.name, { addr: block.addr, size: block.size ?? Math.min(other?.size ?? 0x10000, limits[i]) });
    });

    return search.found(platform);
}

// Blocks of 64 KiB, the first of every partition's pair with a header
function searchSgoldBlocks(data: Uint8Array, platform: Platform, log: Log): Found | undefined {
    const search = new Search(data, log);

    for (let addr = 0; addr < data.length; addr += 0x10000) {
        const name = formattedBlockName(data, addr);

        if (name?.includes("FFS")) {
            search.add(name, { addr, size: 0x20000 });

            addr += 0x10000;
        }
    }

    return search.found(platform);
}

// Blocks of 256 KiB, the header 32 bytes before their end. The last sector's start is no matter, as
// the data grows up from the block's start and the FIT down from its end.
function searchElkaBlocks(data: Uint8Array, log: Log): Found | undefined {
    const search = new Search(data, log);

    for (let addr = 0x30000; addr < data.length; addr += 0x10000) {
        const name = formattedBlockName(data, addr + 0x10000 - 0x20);

        if (name?.includes("FFS")) {
            search.add(name, { addr: addr - 0x30000, size: 0x40000 });
        }
    }

    return search.found("SGOLD2_ELKA");
}

// =========================================================================

export function findPartitions(data: Uint8Array, platform: Platform, sl75: boolean, log: Log): Partitions {
    const egold = platform === "EGOLD_CE" || platform === "EGOLD";
    const base  = egold ? egoldBase(data, egoldLayout(platform)) : 0;

    let found: Found | undefined;

    switch (platform) {
        case "SGOLD":       found = searchTables(data, SGOLD_LAYOUT, sl75, log); break;
        case "SGOLD2":      found = searchTables(data, SGOLD2_LAYOUT, sl75, log); break;
        case "SGOLD2_ELKA": found = searchTables(data, SGOLD2_ELKA_LAYOUT, sl75, log); break;
        case "EGOLD_CE":
        case "EGOLD":       found = searchEgoldTables(data, base, platform, log); break;
    }

    if (!found) {
        log.debug("No partition table found, searching for the blocks");

        switch (platform) {
            case "SGOLD":
            case "SGOLD2":      found = searchSgoldBlocks(data, platform, log); break;
            case "SGOLD2_ELKA": found = searchElkaBlocks(data, log); break;
            case "EGOLD_CE":
            case "EGOLD":       found = searchEgoldBlocks(data, base, platform, log); break;
        }
    }

    if (!found) {
        throw new FFSError("No filesystem partitions found");
    }

    for (const problem of found.problems) {
        log.warn(problem);
    }

    if (egold) {
        log.debug(`The fullflash starts at ${hex(base)} in the phone`);
    }

    return {
        platform:   found.platform,
        partitions: [...found.partitions].map(([name, blocks]) => ({ name, blocks })),
        base,
    };
}

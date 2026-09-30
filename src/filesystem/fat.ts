// The LBA_FS of the x45 phones: a disk of 512-byte sectors, each a record under its number, whose
// first partition, or the whole of it without a partition table, is FAT12 or FAT16, as a memory
// card's. The phones leave the sectors they never wrote to out, as the root directory's last ones,
// which are then of zeros.

import { concat, u16, u32 } from "../bytes.js";
import { FFSError } from "../errors.js";
import { decodeName } from "./codepage.js";
import { fatTimeToDate } from "./fattime.js";
import { Attributes, type Header } from "./format.js";
import type { Records } from "./records.js";
import { foldAscii } from "./sgold.js";
import type { Child, Filesystem, Volume } from "./volume.js";

const SECTOR_SIZE   = 512;
const ENTRY_SIZE    = 32;
const ZEROS         = new Uint8Array(SECTOR_SIZE);

// A name may start with U+FEFF, which is no byte order mark in it
const utf16Decoder = new TextDecoder("utf-16le", { ignoreBOM: true });

const LONG_NAME     = 0x0F;
const VOLUME_LABEL  = 0x08;
const DELETED       = 0xE5;
// The last of a long name's entries, which comes first
const LAST_PART     = 0x40;
// The short name's base and extension are shown in lower case
const LOWER_BASE    = 0x08;
const LOWER_EXT     = 0x10;

// A directory is known by its first cluster, the root by 1, which is no cluster's, and a file by
// where its entry is, past every cluster
const ROOT_ID       = 1;
const FILE_ID       = 0x10000;
// The root has no timestamp: 1980-01-01
const ROOT_FAT_TIME = 0x00210000;

interface Geometry {
    // Where the first FAT, the root directory and cluster 2 start, in sectors
    fat: number;
    root: number;
    rootSectors: number;
    data: number;
    clusterSectors: number;
    clusters: number;
    fat16: boolean;
}

function isBootSector(sector: Uint8Array): boolean {
    return (sector[0] === 0xEB || sector[0] === 0xE9) && u16(sector, 11) === SECTOR_SIZE;
}

// A long name's 13 UTF-16 characters of an entry
function longNamePart(sector: Uint8Array, offset: number): Uint8Array {
    return concat([sector.subarray(offset + 1, offset + 11), sector.subarray(offset + 14, offset + 26), sector.subarray(offset + 28, offset + 32)]);
}

function shortNameChecksum(name: Uint8Array): number {
    return name.reduce((sum, byte) => ((((sum & 1) << 7) | (sum >>> 1)) + byte) & 0xFF, 0);
}

function decodeLongName(parts: Uint8Array[]): string {
    const units = concat(parts);
    let   end   = 0;

    while (end + 2 <= units.length && (units[end] | units[end + 1])) {
        end += 2;
    }

    return utf16Decoder.decode(units.subarray(0, end));
}

export class FatVolume implements Filesystem {
    private readonly geometry: Geometry | undefined;

    constructor(readonly name: string, private readonly records: Records) {
        this.geometry = this.readGeometry();
    }

    root(): Header | undefined {
        return this.geometry && { id: ROOT_ID, parentId: ROOT_ID, dataId: 0, nextPart: 0, fatTime: ROOT_FAT_TIME, attributes: Attributes.DIRECTORY, size: 0, name: new Uint8Array(0) };
    }

    size(header: Header): number | string {
        return this.fileSectors(header).problem ?? header.size;
    }

    read(header: Header): Uint8Array {
        const { sectors, problem } = this.fileSectors(header);

        if (problem) {
            throw new FFSError(problem);
        }

        return concat(sectors.map((sector) => this.sector(sector)!)).slice(0, header.size);
    }

    children(dir: Header, report: (problem: string) => void = () => {}): Child[] {
        const { sectors, problem } = this.directorySectors(dir);
        const children: Child[] = [];
        let   longName: { parts: Uint8Array[], checksum: number, next: number } | undefined;

        if (problem) {
            report(problem);
        }

        for (const sector of sectors) {
            const data = this.sector(sector) ?? ZEROS;

            for (let offset = 0; offset < SECTOR_SIZE; offset += ENTRY_SIZE) {
                const first         = data[offset];
                const attributes    = data[offset + 11];

                // The end of the directory
                if (first === 0) {
                    return children;
                }

                if (first === DELETED) {
                    longName = undefined;

                    continue;
                }

                if ((attributes & 0x3F) === LONG_NAME) {
                    const sequence = first & 0x1F;
                    const checksum = data[offset + 13];

                    if (first & LAST_PART) {
                        longName = { parts: [longNamePart(data, offset)], checksum, next: sequence - 1 };
                    } else if (longName && sequence === longName.next && checksum === longName.checksum) {
                        longName.parts.unshift(longNamePart(data, offset));
                        longName.next = sequence - 1;
                    } else {
                        longName = undefined;
                    }

                    continue;
                }

                const shortName = data.slice(offset, offset + 11);
                const long      = longName?.next === 0 && longName.checksum === shortNameChecksum(shortName) ? decodeLongName(longName.parts) : undefined;

                longName = undefined;

                if (attributes & VOLUME_LABEL) {
                    continue;
                }

                const name = long || this.decodeShortName(shortName, data[offset + 12]);

                if (name === "." || name === "..") {
                    continue;
                }

                const cluster   = u16(data, offset + 26);
                const directory = (attributes & Attributes.DIRECTORY) !== 0;

                const header: Header = {
                    id:         directory ? cluster : FILE_ID + sector * SECTOR_SIZE + offset,
                    parentId:   dir.id,
                    dataId:     cluster,
                    nextPart:   0,
                    fatTime:    ((u16(data, offset + 24) << 16) | u16(data, offset + 22)) >>> 0,
                    attributes,
                    size:       directory ? 0 : u32(data, offset + 28),
                    name:       shortName,
                };

                children.push({ entry: { record: sector, offset, id: header.id }, header, name });
            }
        }

        return children;
    }

    find(dir: Header, name: string): Child | undefined {
        const key = foldAscii(name);

        return this.children(dir).find((child) => foldAscii(child.name) === key);
    }

    timestamp(header: Header): Date {
        return fatTimeToDate(header.fatTime, false);
    }

    writable(): Volume {
        throw new FFSError(`${this.name}: writes to EGOLD without Card-Explorer are not supported`);
    }

    // =========================================================================

    // Undefined when it was never written, or when its record is of another size
    private sector(sector: number): Uint8Array | undefined {
        const data = this.records.has(sector) ? this.records.read(sector) : undefined;

        return data?.length === SECTOR_SIZE ? data : undefined;
    }

    private readGeometry(): Geometry | undefined {
        const first = this.sector(0) ?? ZEROS;
        // The first partition of the partition table, else the disk
        const start = isBootSector(first) ? 0 : u32(first, 446 + 8);
        const boot  = this.sector(start);

        if (!boot || !isBootSector(boot)) {
            return undefined;
        }

        const clusterSectors    = boot[13];
        const reserved          = u16(boot, 14);
        const fats              = boot[16];
        const rootEntries       = u16(boot, 17);
        const total             = u16(boot, 19) || u32(boot, 32);
        const fatSectors        = u16(boot, 22);

        if (!clusterSectors || (clusterSectors & (clusterSectors - 1)) || !reserved || !fats || !rootEntries || !fatSectors) {
            return undefined;
        }

        const fat           = start + reserved;
        const root          = fat + fats * fatSectors;
        const rootSectors   = Math.ceil(rootEntries * ENTRY_SIZE / SECTOR_SIZE);
        const data          = root + rootSectors;
        const clusters      = Math.floor((start + total - data) / clusterSectors);

        // Of FAT32, which the phones do not have
        if (clusters < 1 || clusters > 65524) {
            return undefined;
        }

        return { fat, root, rootSectors, data, clusterSectors, clusters, fat16: clusters >= 4085 };
    }

    // The FAT's entry of a cluster: the next one, or what it is
    private next(cluster: number): number {
        const { fat, fat16 } = this.geometry!;
        const byte = (offset: number) => (this.sector(fat + Math.floor(offset / SECTOR_SIZE)) ?? ZEROS)[offset % SECTOR_SIZE];

        if (fat16) {
            return byte(cluster * 2) | (byte(cluster * 2 + 1) << 8);
        }

        const at    = cluster + (cluster >>> 1);
        const value = byte(at) | (byte(at + 1) << 8);

        return cluster & 1 ? value >>> 4 : value & 0xFFF;
    }

    // A chain's clusters from the first on, `count` of them at most, or what breaks it
    private chain(first: number, count = Infinity): { clusters: number[], problem?: string } {
        const { clusters: total, fat16 } = this.geometry!;
        const end       = fat16 ? 0xFFF8 : 0xFF8;
        const clusters: number[] = [];
        const visited   = new Set<number>();
        let   cluster   = first;

        while (clusters.length < count) {
            if (cluster < 2 || cluster >= total + 2) {
                return { clusters, problem: `its cluster chain is broken at ${cluster}` };
            }

            if (visited.has(cluster)) {
                return { clusters, problem: "its cluster chain loops" };
            }

            visited.add(cluster);
            clusters.push(cluster);

            cluster = this.next(cluster);

            if (cluster >= end) {
                break;
            }
        }

        return { clusters };
    }

    private clusterSectors(clusters: number[]): number[] {
        const { data, clusterSectors } = this.geometry!;

        return clusters.flatMap((cluster) => Array.from({ length: clusterSectors }, (_, i) => data + (cluster - 2) * clusterSectors + i));
    }

    // The sectors of a file's data, or what breaks it
    private fileSectors(header: Header): { sectors: number[], problem?: string } {
        const count = Math.ceil(header.size / (this.geometry!.clusterSectors * SECTOR_SIZE));

        if (!count) {
            return { sectors: [] };
        }

        const { clusters, problem } = this.chain(header.dataId, count);

        if (problem || clusters.length < count) {
            return { sectors: [], problem: problem ?? "its cluster chain ends before its size" };
        }

        const sectors = this.clusterSectors(clusters).slice(0, Math.ceil(header.size / SECTOR_SIZE));
        const missing = sectors.find((sector) => !this.sector(sector));

        return missing === undefined ? { sectors } : { sectors: [], problem: `its sector ${missing} is missing` };
    }

    private directorySectors(dir: Header): { sectors: number[], problem?: string } {
        const { root, rootSectors } = this.geometry!;

        if (dir.id === ROOT_ID) {
            return { sectors: Array.from({ length: rootSectors }, (_, i) => root + i) };
        }

        const { clusters, problem } = this.chain(dir.dataId);

        return { sectors: this.clusterSectors(clusters), problem };
    }

    // Its base and extension apart, in lower case where it says so, in CP1252 as the phones' other
    // names. They make short names of ASCII only, and always a long name.
    private decodeShortName(stored: Uint8Array, caseFlags: number): string {
        const bytes = stored.slice();

        // 0xE5 is kept as 0x05, since it marks deleted entries
        if (bytes[0] === 0x05) {
            bytes[0] = DELETED;
        }

        const decode    = (part: Uint8Array, lower: boolean) => {
            const name = decodeName(part).replace(/ +$/, "");

            return lower ? name.replace(/[A-Z]/g, (c) => c.toLowerCase()) : name;
        };
        const base      = decode(bytes.subarray(0, 8), (caseFlags & LOWER_BASE) !== 0);
        const extension = decode(bytes.subarray(8, 11), (caseFlags & LOWER_EXT) !== 0);

        return extension ? `${base}.${extension}` : base;
    }
}

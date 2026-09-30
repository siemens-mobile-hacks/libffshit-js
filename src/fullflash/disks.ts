import type { Platform } from "./detector.js";
import { LBA_FS } from "./partitions.js";

// A drive's name, and how its firmware keeps it
interface Drive {
    name: string;
    stored: Uint8Array;
}

// The firmwares of SGOLD, SGOLD2 and ELKA phones name their drives 0:, 1: and 2: Data, Cache and
// Config, which their OBEX servers list in the root. They keep the names as UTF-16 strings after
// their length.
function named(name: string): Drive {
    const text      = `\\${name}`;
    const stored    = new Uint8Array(2 + 2 * text.length);

    stored[0] = text.length;

    for (let i = 0; i < text.length; ++i) {
        stored[2 + 2 * i] = text.charCodeAt(i);
    }

    return { name, stored };
}

// EGOLD firmwares know their drives by letters alone, and keep their roots as C strings: "A:\"
function lettered(letter: string): Drive {
    return { name: letter, stored: Uint8Array.from(`\0${letter}:\\\0`, (c) => c.charCodeAt(0)) };
}

const DATA      = named("Data");
const CACHE     = named("Cache");
const CONFIG    = named("Config");
const A         = lettered("A");
const B         = lettered("B");

// The drive each partition is. The FFS_C of EGOLD phones with Card-Explorer is drive 3:, which has no
// letter.
const DRIVES: Partial<Record<Platform, Record<string, Drive>>> = {
    SGOLD:          { FFS: DATA, FFS_B: CACHE, FFS_C: CONFIG },
    SGOLD2:         { FFS_0: DATA, FFS_1: CACHE, FFS_2: CONFIG },
    SGOLD2_ELKA:    { FFS_0: DATA, FFS_1: CACHE, FFS_2: CONFIG },
    EGOLD_CE:       { FFS: A, FFS_B: B },
    EGOLD:          { FFS: A, [LBA_FS]: A },
};

function contains(data: Uint8Array, needle: Uint8Array): boolean {
    // Looked for by its first byte that is not 0, as a flash has many
    const anchor = needle.findIndex((byte) => byte !== 0);

    for (let at = data.indexOf(needle[anchor], anchor); at >= 0; at = data.indexOf(needle[anchor], at + 1)) {
        const start = at - anchor;
        let   i     = 0;

        while (i < needle.length && data[start + i] === needle[i]) {
            ++i;
        }

        if (i === needle.length) {
            return true;
        }
    }

    return false;
}

// Where the partition's drive comes among the platform's, from 0: or A: on, and a partition of no
// drive after them
export function driveOrder(platform: Platform, partition: string): number {
    const order = Object.keys(DRIVES[platform] ?? {}).indexOf(partition);

    return order < 0 ? Number.MAX_SAFE_INTEGER : order;
}

// The name the phone knows a partition by, where its firmware has one for the partition's drive
export function diskName(data: Uint8Array, platform: Platform, partition: string): string | undefined {
    const drive = DRIVES[platform]?.[partition];

    return drive && contains(data, drive.stored) ? drive.name : undefined;
}

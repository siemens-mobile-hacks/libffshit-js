import type { Platform } from "./detector.js";

// The names the firmwares of SGOLD, SGOLD2 and ELKA phones give their drives 0:, 1: and 2:, which
// their OBEX servers list in the root. They keep them as UTF-16 strings after their length.
const DRIVE_NAMES = ["Data", "Cache", "Config"];

// The drive each partition is
const DRIVES: Partial<Record<Platform, Record<string, number>>> = {
    SGOLD:          { FFS: 0, FFS_B: 1, FFS_C: 2 },
    SGOLD2:         { FFS_0: 0, FFS_1: 1, FFS_2: 2 },
    SGOLD2_ELKA:    { FFS_0: 0, FFS_1: 1, FFS_2: 2 },
};

function stored(name: string): Uint8Array {
    const text = `\\${name}`;
    const data = new Uint8Array(2 + 2 * text.length);

    data[0] = text.length;

    for (let i = 0; i < text.length; ++i) {
        data[2 + 2 * i] = text.charCodeAt(i);
    }

    return data;
}

function contains(data: Uint8Array, needle: Uint8Array): boolean {
    for (let at = data.indexOf(needle[0]); at >= 0; at = data.indexOf(needle[0], at + 1)) {
        let i = 1;

        while (i < needle.length && data[at + i] === needle[i]) {
            ++i;
        }

        if (i === needle.length) {
            return true;
        }
    }

    return false;
}

// The name the phone knows a partition by, where its firmware has one for the partition's drive
export function diskName(data: Uint8Array, platform: Platform, partition: string): string | undefined {
    const drive = DRIVES[platform]?.[partition];
    const name  = drive === undefined ? undefined : DRIVE_NAMES[drive];

    return name && contains(data, stored(name)) ? name : undefined;
}

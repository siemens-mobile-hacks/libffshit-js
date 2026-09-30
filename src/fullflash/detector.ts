import { cString, isPrintable, latin1 } from "../bytes.js";
import { hasEgoldBlocks } from "./partitions.js";

// EGOLD_CE is EGOLD with Card-Explorer, EGOLD without it: the A55, A56, A57, C55 and S46, and the
// S45, S45i, M50, MT50 and SL42, whose filesystem is a FAT disk
export type Platform = "SGOLD" | "SGOLD2" | "SGOLD2_ELKA" | "EGOLD_CE" | "EGOLD";

export const PLATFORMS: readonly Platform[] = ["SGOLD", "SGOLD2", "SGOLD2_ELKA", "EGOLD_CE", "EGOLD"];

export interface Detection {
    // Undefined when the fullflash is of none of the platforms
    platform: Platform | undefined;
    model: string | undefined;
    imei: string | undefined;
    // The SL75, whose flash is mapped in two parts
    sl75: boolean;
}

// Where the name of the boot core is
const BCORE_OFFSET      = 0x870;
const ELKA_BCORE_OFFSET = 0xC70;

// EGOLD's flash configuration block ends a 64 KiB block with the language pack, the model and the
// vendor, 16 bytes each
const EGOLD_CONFIG_MODEL    = 0x90;
const EGOLD_CONFIG_VENDOR   = 0x80;

function string(data: Uint8Array, offset: number): string | undefined {
    const bytes = cString(data, offset);

    return bytes.length && isPrintable(bytes) ? latin1(bytes) : undefined;
}

function imei(data: Uint8Array, ...offsets: number[]): string | undefined {
    for (const offset of offsets) {
        const value = string(data, offset);

        if (value?.length === 15) {
            return value;
        }
    }

    return undefined;
}

function detectPlatform(data: Uint8Array): Platform | undefined {
    switch (latin1(cString(data, BCORE_OFFSET))) {
        case "BC65":
        case "BCORE65": return "SGOLD";
        case "BC75":    return "SGOLD2";
    }

    if (latin1(cString(data, ELKA_BCORE_OFFSET)) === "BC85") {
        return "SGOLD2_ELKA";
    }

    // Of EGOLD phones, only those with a filesystem
    if (hasEgoldBlocks(data, "EGOLD_CE")) {
        return "EGOLD_CE";
    }

    return hasEgoldBlocks(data, "EGOLD") ? "EGOLD" : undefined;
}

function egoldModel(data: Uint8Array): string | undefined {
    for (let end = 0x10000; end <= data.length; end += 0x10000) {
        if (latin1(cString(data, end - EGOLD_CONFIG_VENDOR, 16)) === "SIEMENS") {
            return string(data, end - EGOLD_CONFIG_MODEL);
        }
    }

    return undefined;
}

// The platform, unless it is given, and the model and IMEI of a fullflash
export function detect(data: Uint8Array, platform = detectPlatform(data)): Detection {
    const detection: Detection = { platform, model: undefined, imei: undefined, sl75: false };

    switch (platform) {
        case "SGOLD": {
            detection.model = string(data, 0x210);
            // Of the x65, or of the x7x
            detection.imei  = imei(data, 0x65C, 0x660);

            break;
        }

        case "SGOLD2": {
            detection.model = string(data, 0x210);
            detection.imei  = imei(data, 0x660);
            detection.sl75  = detection.model?.toLowerCase().includes("sl75") || data.length > 0x04000000;

            break;
        }

        case "SGOLD2_ELKA": {
            detection.model = string(data, 0x3E000);
            detection.imei  = imei(data, 0x3E410);

            // Some keep both 16 bytes further on
            if (!detection.model || !detection.imei) {
                detection.model = string(data, 0x3E010) ?? detection.model;
                detection.imei  = imei(data, 0x3E420) ?? detection.imei;
            }

            break;
        }

        case "EGOLD_CE":
        case "EGOLD": {
            detection.model = egoldModel(data);

            break;
        }
    }

    return detection;
}

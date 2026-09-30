import { cString, isPrintable, latin1 } from "../bytes.js";

export type Platform = "SGOLD" | "SGOLD2" | "SGOLD2_ELKA" | "EGOLD_CE";

export const PLATFORMS: readonly Platform[] = ["SGOLD", "SGOLD2", "SGOLD2_ELKA", "EGOLD_CE"];

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

// EGOLD keeps "SIEMENS" and the model in one of these places
const EGOLD_INFO_OFFSETS    = [0x400300, 0x600300, 0x800300];
const EGOLD_MODEL           = 0x0C;
const EGOLD_MAGIC           = 0x1C;

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

    return egoldInfo(data) === undefined ? undefined : "EGOLD_CE";
}

function egoldInfo(data: Uint8Array): number | undefined {
    return EGOLD_INFO_OFFSETS.find((offset) => latin1(cString(data, offset + EGOLD_MAGIC)) === "SIEMENS");
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

        case "EGOLD_CE": {
            const info = egoldInfo(data);

            detection.model = info === undefined ? undefined : string(data, info + EGOLD_MODEL);

            break;
        }
    }

    return detection;
}

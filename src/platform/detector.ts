import { Logger } from "../log.js";
import { decodeUtf8, isPrint, readString, toBinaryString } from "../rawdata.js";
import type { PlatformType } from "./types.js";

export const BC65_BC75_OFFSET           = 0x870;
export const BC85_OFFSET                = 0xC70;

export const X65_MODEL_OFFSET           = 0x210;
export const X75_MODEL_OFFSET           = 0x210;
export const X85_MODEL_OFFSET           = 0x3E000;

export const X65_IMEI_OFFSET            = 0x65C;
export const X65_7X_IMEI_OFFSET         = 0x660;
export const X75_IMEI_OFFSET            = 0x660;
export const X85_IMEI_OFFSET            = 0x3E410;

export const SGOLD_FF_ADDRESS_MASK      = 0x0FFFFFFF;

export const EGOLD_INFO_OFFSETS         = [0x400300, 0x600300, 0x800300];

export const EGOLD_MODEL_OFFSET         = 0x0C;
export const EGOLD_MAGICK_SIEMENS_OFFSET = 0x1C;

const EMPTY: Uint8Array = new Uint8Array(0);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.length + b.length);

    result.set(a);
    result.set(b, a.length);

    return result;
}

function checkString(str: Uint8Array): boolean {
    return str.every(isPrint);
}

// The platform, model and IMEI of a fullflash
export class Detector {
    private readonly data: Uint8Array;

    private platform: PlatformType = "UNK";
    private egoldOffset: number | undefined;
    private bcoreName: Uint8Array = EMPTY;
    private imei: Uint8Array = EMPTY;
    private model: Uint8Array = EMPTY;
    private baseAddress = 0;
    private sl75 = false;

    // Detects the platform unless it is given
    constructor(data: Uint8Array, platform?: PlatformType) {
        this.data = data;

        if (platform === undefined) {
            this.detectPlatform();
        } else {
            this.platform = platform;
        }

        this.detectImeiModel();
    }

    getPlatform(): PlatformType {
        return this.platform;
    }

    getModel(): string {
        return decodeUtf8(this.model);
    }

    getIMEI(): string {
        return decodeUtf8(this.imei);
    }

    isSL75(): boolean {
        return this.sl75;
    }

    // Where the fullflash is in the phone's address space. For EGOLD negative when the fullflash
    // is larger than 16 MiB, which the C++ library keeps as a size_t that wrapped around.
    getBaseAddress(): number {
        return this.baseAddress;
    }

    private detectPlatform(): void {
        let bcoreName = toBinaryString(this.bcoreName = readString(this.data, BC65_BC75_OFFSET));

        if (bcoreName === "BC65" || bcoreName === "BCORE65") {
            this.platform    = "SGOLD";
            this.baseAddress = 0xA0000000;
        } else if (bcoreName === "BC75") {
            this.platform    = "SGOLD2";
            this.baseAddress = 0xA0000000;
        } else {
            bcoreName = toBinaryString(this.bcoreName = readString(this.data, BC85_OFFSET));

            if (bcoreName === "BC85") {
                this.platform    = "SGOLD2_ELKA";
                this.baseAddress = 0xA0000000;
            } else {
                this.platform = "UNK";
            }
        }

        if (this.platform === "UNK") {
            for (const offset of EGOLD_INFO_OFFSETS) {
                const magick = toBinaryString(readString(this.data, offset + EGOLD_MAGICK_SIEMENS_OFFSET));

                if (magick !== "SIEMENS") {
                    continue;
                }

                this.platform    = "EGOLD_CE";
                // Max address size
                this.baseAddress = 16777216 - this.data.length;
                this.egoldOffset = offset;

                break;
            }
        }
    }

    private detectImeiModel(): void {
        switch (this.platform) {
            case "EGOLD_CE": {
                // The C++ library leaves the offset unset when the platform is given, and reads
                // the model from wherever that points
                const offset = this.egoldOffset ?? EGOLD_INFO_OFFSETS.find((offset) => {
                    return toBinaryString(readString(this.data, offset + EGOLD_MAGICK_SIEMENS_OFFSET)) === "SIEMENS";
                });

                if (offset !== undefined) {
                    this.model = readString(this.data, offset + EGOLD_MODEL_OFFSET);
                }

                break;
            }

            case "SGOLD": {
                this.model = readString(this.data, X65_MODEL_OFFSET);
                this.imei  = readString(this.data, X65_IMEI_OFFSET);

                if (this.imei.length !== 15) {
                    this.imei = readString(this.data, X65_7X_IMEI_OFFSET);
                }

                if (!checkString(this.imei)) {
                    this.imei = readString(this.data, X65_7X_IMEI_OFFSET);
                }

                break;
            }

            case "SGOLD2": {
                this.model = readString(this.data, X75_MODEL_OFFSET);
                this.imei  = readString(this.data, X75_IMEI_OFFSET);

                if (toBinaryString(this.model).replace(/[A-Z]/g, (c) => c.toLowerCase()).includes("sl75")) {
                    this.sl75 = true;
                } else if (this.data.length > 0x04000000) {
                    this.sl75 = true;
                }

                break;
            }

            case "SGOLD2_ELKA": {
                this.model = readString(this.data, X85_MODEL_OFFSET);
                this.imei  = readString(this.data, X85_IMEI_OFFSET);

                if (!(checkString(this.model) && checkString(this.imei))) {
                    // The model read here is appended to the one read before
                    this.model = concat(this.model, readString(this.data, X85_MODEL_OFFSET + 0x10));
                    this.imei  = readString(this.data, X85_IMEI_OFFSET + 0x10);
                }

                break;
            }

            case "UNK": {
                break;
            }
        }

        const brokenImei  = this.imei.length !== 15 || !checkString(this.imei);
        const brokenModel = !checkString(this.model);

        if (brokenImei) {
            Logger.warn("Couldn't detect IMEI");

            this.imei = EMPTY;
        }

        if (brokenModel) {
            Logger.warn("Couldn't detect model");

            this.model = this.bcoreName;
        }
    }
}

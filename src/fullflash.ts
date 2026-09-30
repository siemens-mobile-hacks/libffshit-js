import { FullflashError } from "./errors.js";
import { hex } from "./format.js";
import { Image } from "./image.js";
import { Logger } from "./log.js";
import { Partitions } from "./partition/partitions.js";
import { Detector } from "./platform/detector.js";
import type { PlatformType } from "./platform/types.js";
import { checkRead, slice } from "./rawdata.js";

// A fullflash: a dump of a phone's flash. The bytes stay the caller's, who must not change them
// while it is in use: the first write goes to a copy.
export class FullFlash {
    private readonly image: Image;
    private readonly x65flasherHeader: Uint8Array;
    private readonly detector: Detector;
    private partitions: Partitions | undefined;

    // Detects the platform unless it is given
    constructor(data: Uint8Array, platform?: PlatformType) {
        if (data.length === 0) {
            throw new FullflashError("RawData() from raw ptr. data_size == 0");
        }

        // x65flasher puts a 16 byte header before the fullflash
        checkRead(data, 0, 3);

        if (data[0] === 0x46 && data[1] === 0x42 && data[2] === 0x4B) {
            Logger.warn("x65flasher detected");

            const oldSize = data.length;
            const newSize = oldSize - 0x10;

            this.x65flasherHeader = slice(data, 0, 0x10);
            data = slice(data, 0x10, newSize);

            Logger.warn(`x65flasher fixed ${hex(oldSize, 8)} -> ${hex(newSize, 8)}`);
        } else {
            this.x65flasherHeader = new Uint8Array(0);
        }

        this.image    = new Image(data);
        this.detector = new Detector(data, platform);
    }

    loadPartitions(oldSearchAlgorithm = false, searchStartAddr = 0): void {
        Logger.info("Loading partitions");

        const startTime = Date.now();

        this.partitions = new Partitions(this.image, this.detector, oldSearchAlgorithm, searchStartAddr);

        Logger.info(`Done in ${Date.now() - startTime} ms`);
    }

    // The fullflash, with what the filesystem wrote to it, in the format it was read in
    save(): Uint8Array {
        const data   = this.image.getData();
        const result = new Uint8Array(this.x65flasherHeader.length + data.length);

        result.set(this.x65flasherHeader);
        result.set(data, this.x65flasherHeader.length);

        return result;
    }

    getDetector(): Detector {
        return this.detector;
    }

    // Undefined before loadPartitions()
    getPartitions(): Partitions | undefined {
        return this.partitions;
    }
}

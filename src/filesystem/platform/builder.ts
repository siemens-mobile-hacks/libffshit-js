import { FullflashError } from "../../errors.js";
import type { Partitions } from "../../partition/partitions.js";
import type { PlatformType } from "../../platform/types.js";
import type { Filesystem } from "./base.js";
import { EGOLD_CE } from "./egold_ce.js";
import { SGOLD } from "./sgold.js";
import { SGOLD2 } from "./sgold2.js";
import { SGOLD2_ELKA } from "./sgold2_elka.js";

// The filesystem of the partitions: pass partitions.getFsPlatform(), which the partition tables
// may tell apart from the detected platform
export function buildFilesystem(platform: PlatformType, partitions: Partitions): Filesystem {
    switch (platform) {
        case "EGOLD_CE":    return new EGOLD_CE(partitions);
        case "SGOLD":       return new SGOLD(partitions);
        case "SGOLD2":      return new SGOLD2(partitions);
        case "SGOLD2_ELKA": return new SGOLD2_ELKA(partitions);
        default: {
            throw new FullflashError("Unknown platform");
        }
    }
}

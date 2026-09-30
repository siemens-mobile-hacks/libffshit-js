export { BaseError, FilesystemError, FullflashError, PartitionsError, PatternsError } from "./errors.js";
export { Logger, type LogInterface } from "./log.js";

export { FullFlash } from "./fullflash.js";
export { Detector } from "./platform/detector.js";
export { PLATFORM_TYPES, isPlatformType, type PlatformType } from "./platform/types.js";

export { Partitions } from "./partition/partitions.js";
export { Partition } from "./partition/partition.js";
export { Block, type BlockHeader } from "./partition/block.js";

export { Filesystem, ROOT_NAME, ROOT_PATH } from "./filesystem/platform/base.js";
export { buildFilesystem } from "./filesystem/platform/builder.js";
export { EGOLD_CE } from "./filesystem/platform/egold_ce.js";
export { SGOLD } from "./filesystem/platform/sgold.js";
export { SGOLD2 } from "./filesystem/platform/sgold2.js";
export { SGOLD2_ELKA } from "./filesystem/platform/sgold2_elka.js";
export { Attributes, Directory, File, FileAttributes } from "./filesystem/structure.js";
export { fatTimestampToUnix, unixToFatTimestamp, type TimePoint } from "./filesystem/help.js";
export { foldCase8bit, foldCaseUtf16, nameHash8bit, nameHashUtf16 } from "./filesystem/hash.js";

export { FFS, type FFSEntry, type FFSOpenOptions, type FFSTreeEntry } from "./ffs.js";

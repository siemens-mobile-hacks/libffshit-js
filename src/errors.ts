// The exceptions of libffshit. What the loaders catch to skip a broken file or directory is a
// BaseError; a PatternsError, like a JavaScript error, is not one and always gets through.

export abstract class BaseError extends Error {
}

// FULLFLASH::Exception
export class FullflashError extends BaseError {
    override name = "FullflashError";
}

// FULLFLASH::Partitions::Exception
export class PartitionsError extends BaseError {
    override name = "PartitionsError";
}

// FULLFLASH::Filesystem::Exception
export class FilesystemError extends BaseError {
    override name = "FilesystemError";
}

// Patterns::Exception
export class PatternsError extends Error {
    override name = "PatternsError";
}

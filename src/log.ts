import { FFSError } from "./errors.js";

export interface Logger {
    debug?(message: string): void;
    warn?(message: string): void;
}

// What opening a fullflash reports: debug messages, and the warnings about what is broken, which in
// strict mode fail it
export class Log {
    readonly warnings: string[] = [];

    constructor(private readonly logger: Logger = {}, private readonly strict = false) {
    }

    debug(message: string): void {
        this.logger.debug?.(message);
    }

    warn(message: string): void {
        if (this.strict) {
            throw new FFSError(message);
        }

        this.warnings.push(message);
        this.logger.warn?.(message);
    }
}

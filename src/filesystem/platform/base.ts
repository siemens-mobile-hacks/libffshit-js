import { FilesystemError } from "../../errors.js";
import { hex } from "../../format.js";
import { Logger } from "../../log.js";
import type { Partitions } from "../../partition/partitions.js";
import type { PlatformType } from "../../platform/types.js";
import { checkCodepage } from "../codepage.js";
import type { TimePoint } from "../help.js";
import type { Directory } from "../structure.js";
import { Session } from "../write/session.js";

export const ROOT_NAME = "FFS";
export const ROOT_PATH = `/${ROOT_NAME}/`;

// The records of a partition's filesystem, by id. The C++ library keys them by a uint16_t, so an id
// stands for itself modulo 0x10000.
export class RecordMap<T> {
    private readonly map = new Map<number, T>();

    has(id: number): boolean {
        return this.map.has(id & 0xFFFF);
    }

    get(id: number): T {
        return this.map.get(id & 0xFFFF)!;
    }

    set(id: number, value: T): void {
        this.map.set(id & 0xFFFF, value);
    }

    entries(): IterableIterator<[number, T]> {
        return this.map.entries();
    }

    get size(): number {
        return this.map.size;
    }
}

// A loop in a chain of parts: the C++ library recurses along it until the stack overflows
export function checkChainLength(length: number, records: number): void {
    if (length > records) {
        throw new RangeError("Maximum call stack size exceeded: the parts of a file loop");
    }
}

// The filesystem of a fullflash: its partitions, each a directory under the root
export abstract class Filesystem {
    protected verboseProcessing = false;
    protected verboseHeaders = false;
    protected verboseData = false;

    protected codepage = "CP1252";

    private session: Session | undefined;

    logVerboseProcessing(enabled: boolean): void {
        this.verboseProcessing = enabled;
    }

    logVerboseHeaders(enabled: boolean): void {
        this.verboseHeaders = enabled;
    }

    logVerboseData(enabled: boolean): void {
        this.verboseData = enabled;
    }

    // The 8-bit codepage SGOLD keeps file names in, which is the one of the phone's language:
    // CP1252 (the default) for Western European languages, CP1251 for Cyrillic ones, CP1250 for
    // Central European ones. Set it before load().
    setCodepage(codepage: string): void {
        this.codepage = checkCodepage(codepage);
        this.session  = undefined;
    }

    // Reads the partitions into the directory tree. With `skipBroken` a broken file or directory
    // is left out with a warning instead of failing the load, with `skipDup` a record whose id is
    // taken already.
    abstract load(skipBroken?: boolean, skipDup?: boolean, partsToExtract?: readonly string[]): void;

    abstract getRoot(): Directory;

    // Paths start with the partition name, e.g. "FFS_0/Misc/photo.jpg". The changes go to the
    // fullflash in memory, FullFlash.save() returns it. An operation that throws leaves the
    // fullflash unchanged.

    // Creates the file, or replaces the file of that name. The parent directory must exist.
    writeFile(path: string, data: Uint8Array, timestamp: TimePoint): void {
        throw new FilesystemError("Writing is not supported on this platform");
    }

    // The parent directory must exist
    createDirectory(path: string, timestamp: TimePoint): void {
        throw new FilesystemError("Writing is not supported on this platform");
    }

    // Removes a file or an empty directory
    remove(path: string): void {
        throw new FilesystemError("Writing is not supported on this platform");
    }

    // Built on the first write
    protected writeSession(platform: PlatformType, partitions: Partitions, root: Directory): Session {
        if (!this.session) {
            this.session = new Session(platform, partitions, root, this.codepage);
        }

        return this.session;
    }

    protected printData(data: Uint8Array): void {
        if (!this.verboseData) {
            return;
        }

        let dataPrint = "";

        for (let i = 0; i < data.length; ++i) {
            dataPrint += `${hex(data[i], 2)} `;

            if (!((i + 1) % 16) || (data.length < 16 && i + 1 === data.length)) {
                Logger.debug(`    ${dataPrint}`);

                dataPrint = "";
            }
        }

        if (data.length % 16) {
            Logger.debug(`    ${dataPrint}`);
        }
    }
}

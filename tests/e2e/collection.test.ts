// Every fullflash in the directories SIE_FFS_E2E_FULLFLASHES lists, separated by the path
// delimiter, that the library writes to: the suites of the phones, on what the library finds in
// them. The emulator picks the board, and fails the suites of the phones it has none for. The phone
// is talked to once it shows the screen of the PNG next to the fullflash, named after it with ".png"
// added, which a phone without one saves where the failure says.

import fs from "node:fs";
import path from "node:path";
import { describe } from "node:test";
import { FFS } from "../../src/index.js";
import { detect } from "../../src/fullflash/detector.js";
import { findPartitions } from "../../src/fullflash/partitions.js";
import { NewSgoldFormat } from "../../src/filesystem/newsgold.js";
import { Records } from "../../src/filesystem/records.js";
import { SgoldFormat } from "../../src/filesystem/sgold.js";
import { Image } from "../../src/image.js";
import { Log } from "../../src/log.js";
import { allFullflashes, readFullflash } from "../helpers/fullflashes.js";
import { SGOLD_OBEX, type Phone } from "./phone.js";
import { phoneSuite } from "./suites.js";

const DIRS = process.env.SIE_FFS_E2E_FULLFLASHES?.split(path.delimiter).filter(Boolean) ?? [];

function chunkSize(data: Uint8Array, name: string): number {
    const detection                         = detect(data);
    const { platform, partitions, base }    = findPartitions(data, detection.platform!, detection.sl75, new Log());
    const records                           = Records.open(platform, new Image(data), partitions.find((partition) => partition.name === name)!, base);
    const format                            = platform === "SGOLD" ? new SgoldFormat(records, 0) : new NewSgoldFormat(records);

    return format.chunkSize(records.read(0));
}

// The phone, or why it is not one to run
function phoneOf(fullflash: string): Phone | string {
    const data = readFullflash(fullflash)!;
    let   ffs: FFS;

    try {
        ffs = FFS.open(data);
    } catch (e) {
        return (e as Error).message;
    }

    if (ffs.platform === "EGOLD_CE") {
        return "pmb887x-emu runs no EGOLD phones";
    }

    const partition = ffs.platform === "SGOLD" ? "FFS" : "FFS_0";

    if (!ffs.stat(`/${partition}/Misc`)?.isDirectory) {
        return `it has no /${partition}/Misc`;
    }

    try {
        FFS.open(data).mkdir(`/${partition}/Misc/sie-ffs-check`);
    } catch (e) {
        return (e as Error).message;
    }

    const pieces = chunkSize(data, partition);

    // Small, so that the emulated SGOLD phones download it, in more than one piece
    const firmwareFile = (function find(dir: string): string | undefined {
        for (const entry of ffs.readDir(dir)) {
            if (entry.isDirectory) {
                const found = find(entry.path);

                if (found) {
                    return found;
                }
            } else if (entry.size > pieces && entry.size <= 16384 && /^[\x20-\x7E]+$/.test(entry.path)) {
                return entry.path.slice(partition.length + 2);
            }
        }

        return undefined;
    })(`/${partition}`);

    if (!firmwareFile) {
        return "it has no file for the phone to be read before the test";
    }

    const sgold = ffs.platform === "SGOLD";

    return {
        fullflash, partition, chunkSize: pieces, firmwareFile, readyScreen: `${fullflash}.png`,
        platform: sgold ? "SGOLD" : "NewSGOLD", unreliableObex: sgold ? SGOLD_OBEX : undefined,
    };
}

for (const fullflash of allFullflashes(DIRS)) {
    const absolute  = DIRS.map((dir) => path.join(dir, fullflash)).find((file) => fs.existsSync(file))!;
    const phone     = phoneOf(absolute);

    if (typeof phone === "string") {
        describe(fullflash, { skip: phone }, () => {});

        continue;
    }

    phoneSuite(fullflash, phone);
}

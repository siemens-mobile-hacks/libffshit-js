// What the firmware makes of the library's writes, and the library of the firmware's: the library
// writes into a fullflash, the phone boots on it in pmb887x-emu and its own firmware lists, reads,
// writes and deletes files over OBEX, and then the library reads the flash the phone left, and
// writes into it.

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { FFS } from "../../src/index.js";
import { detect } from "../../src/fullflash/detector.js";
import { findPartitions } from "../../src/fullflash/partitions.js";
import { Log } from "../../src/log.js";
import { equalBytes, pattern } from "../helpers/data.js";
import { findFullflash, NO_FULLFLASHES, readFullflash } from "../helpers/fullflashes.js";
import { emulatorMissing } from "./emulator.js";
import { boot, findPanic, reconnect, shutdown, workDir, type Phone, type Session } from "./phone.js";

interface TestFile {
    // Below /Data on the phone, below the partition for the library
    path: string;
    data: Uint8Array;
    // Where the library writes it, before RENAMES move it to its path
    writtenAs?: string;
}

// What the library renames, the directories with what is in them
const RENAMES = [
    ["Misc/sie-ffs-e2e/to rename.bin", "Misc/sie-ffs-e2e/renamed.bin"],
    ["Misc/sie-ffs-e2e/to move", "Misc/sie-ffs-e2e/sub/moved"],
    ["Misc/sie-ffs-phone/sub/to move.bin", "Misc/sie-ffs-phone/moved.bin"],
];

const text = (content: string) => new TextEncoder().encode(`${content}\r\n`);

const BOOT_TIMEOUT      = 20 * 60000;
const TEST_TIMEOUT      = 5 * 60000;
// Of an even second, which FAT timestamps are kept to
const TIMESTAMP         = new Date(2024, 4, 17, 13, 45, 30);

// What the phone lists a file of a timestamp with, as the OBEX client takes it: for the time here.
// Undefined when the phone's time zone is not known.
function listedTime(phone: Phone, timestamp: Date): number | undefined {
    if (phone.platform !== "NewSGOLD") {
        return timestamp.getTime();
    }

    if (phone.utcOffset === undefined) {
        return undefined;
    }

    const shown = new Date(timestamp.getTime() + phone.utcOffset * 60000);

    return new Date(shown.getUTCFullYear(), shown.getUTCMonth(), shown.getUTCDate(), shown.getUTCHours(), shown.getUTCMinutes(), shown.getUTCSeconds()).getTime();
}

// Unless the phone lists no time, or its time zone is not known
function assertListedTime(phone: Phone, listed: Date | undefined, timestamp: Date, file: string): void {
    const expected = listedTime(phone, timestamp);

    if (listed && expected !== undefined) {
        assert.equal(listed.getTime(), expected, file);
    }
}

function unavailable(phone: Phone): string | false {
    return emulatorMissing() ?? (!findFullflash(phone.fullflash) && `${phone.fullflash} ${NO_FULLFLASHES}`);
}

function partitionSize(data: Uint8Array, name: string): number {
    const detection = detect(data);
    const partition = findPartitions(data, detection.platform!, detection.sl75, new Log()).partitions.find((partition) => partition.name === name)!;

    return partition.blocks.reduce((size, block) => size + block.size, 0);
}

// What the phone lists in its directories
async function listing(session: Session, dirs: string[]): Promise<Map<string, { size: number, isDir: boolean, mtime?: Date }>> {
    const entries = new Map<string, { size: number, isDir: boolean, mtime?: Date }>();

    for (const dir of dirs) {
        for (const entry of await session.obex.readDir(`/Data/${dir}`)) {
            entries.set(`${dir}/${entry.name}`, { size: entry.size, isDir: entry.isDir, mtime: entry.mtime });
        }
    }

    return entries;
}

async function download(session: Session, file: TestFile): Promise<Uint8Array> {
    return session.obex.getFile(`/Data/${file.path}`).catch((e: Error) => {
        throw new Error(`${file.path}: ${e.message}`, { cause: e });
    });
}

// What the library reads from the flash the phone left, which has to be broken in no new way
function reopen(fullflash: string, original: Uint8Array): FFS {
    const known = new Set(FFS.open(original).warnings);
    const ffs   = FFS.open(fs.readFileSync(fullflash));

    assert.deepEqual(ffs.warnings.filter((warning) => !known.has(warning)), []);

    return ffs;
}

function assertFile(ffs: FFS, partition: string, file: TestFile): void {
    const data = ffs.readFile(`/${partition}/${file.path}`);

    assert.ok(equalBytes(data, file.data), `${file.path}: ${data.length} bytes, expected ${file.data.length}`);
}

// The library's files, which the phone reads
function libraryFiles(phone: Phone): TestFile[] {
    const dir = "Misc/sie-ffs-e2e";

    return [
        { path: `${dir}/small.bin`, data: pattern(100, 1) },
        { path: `${dir}/empty.bin`, data: new Uint8Array(0) },
        { path: `${dir}/one piece.bin`, data: pattern(phone.chunkSize, 2) },
        { path: `${dir}/two pieces.bin`, data: pattern(phone.chunkSize + 1, 3) },
        { path: `${dir}/replaced.bin`, data: pattern(3000, 6) },
        { path: `${dir}/sub/nested.txt`, data: text("Written by node-sie-ffs") },
        // Next to what the firmware keeps there
        { path: "Misc/sie-ffs-e2e.txt", data: text("Written by node-sie-ffs into a directory of the firmware") },
        // SGOLD keeps the first in CP1252, and the second as 0x1F and UTF-8
        { path: `${dir}/Ärger.txt`, data: text("Written by node-sie-ffs, with a name in CP1252") },
        { path: `${dir}/файл.txt`, data: text("Written by node-sie-ffs, with a name beyond CP1252") },
        { path: `${dir}/renamed.bin`, data: pattern(phone.chunkSize + 1, 8), writtenAs: `${dir}/to rename.bin` },
        { path: `${dir}/sub/moved/moved.txt`, data: text("Written by node-sie-ffs, and moved with its directory"), writtenAs: `${dir}/to move/moved.txt` },
    ];
}

// The capacity and free space the phone tells over OBEX are the library's of the flash as the phone
// has it now
async function assertSpace(session: Session, fullflash: string, partition: string): Promise<void> {
    const capacity  = await session.obex.getCapacity();
    const available = await session.obex.getAvailable();
    const { size, free } = FFS.open(fs.readFileSync(fullflash)).statfs(`/${partition}`);

    assert.deepEqual({ size, free }, { size: capacity, free: available });
}

export function phoneSuite(name: string, phone: Phone): void {
    const dir       = "Misc/sie-ffs-e2e";
    const files     = libraryFiles(phone);
    // Long enough for the emulated SGOLD phones to lose the session
    const big: TestFile = { path: `${dir}/big.bin`, data: pattern(50000, 4) };
    const removed   = `${dir}/removed.bin`;

    // What the phone changes of the library's files, and writes
    const phoneDir                  = "Misc/sie-ffs-phone";
    const kept: TestFile            = { path: `${phoneDir}/kept.bin`, data: pattern(3000, 11) };
    const replaced: TestFile        = { path: `${phoneDir}/replaced.bin`, data: pattern(300, 12) };
    const deleted: TestFile[]       = [
        { path: `${phoneDir}/small.bin`, data: pattern(100, 13) },
        { path: `${phoneDir}/two pieces.bin`, data: pattern(phone.chunkSize + 1, 14) },
        { path: `${phoneDir}/Ärger.txt`, data: text("Deleted by the phone") },
        { path: `${phoneDir}/sub/nested.txt`, data: text("Deleted by the phone, and then its directory") },
        { path: `${phoneDir}/moved.bin`, data: pattern(phone.chunkSize + 1, 23), writtenAs: `${phoneDir}/sub/to move.bin` },
    ];
    // Into the directory the library moved
    const intoMoved: TestFile       = { path: `${dir}/sub/moved/by phone.bin`, data: pattern(500, 22) };
    const written: TestFile[]       = [
        { path: `${phoneDir}/by phone/small.bin`, data: pattern(100, 15) },
        { path: `${phoneDir}/by phone/one piece.bin`, data: pattern(phone.chunkSize, 16) },
        { path: `${phoneDir}/by phone/two pieces.bin`, data: pattern(phone.chunkSize + 1, 17) },
        { path: `${phoneDir}/by phone/Ärger.txt`, data: text("Written by the phone, with a name in CP1252") },
        { path: `${phoneDir}/by phone/файл.txt`, data: text("Written by the phone, with a name beyond CP1252") },
        { path: `${phoneDir}/by phone/big.bin`, data: pattern(20000, 18) },
    ];

    describe(`The ${name}`, { skip: unavailable(phone) }, () => {
        let original: Uint8Array;
        let work: { dir: string, fullflash: string };
        let session: Session | undefined;
        // What the phone listed the files it wrote with
        let listed = new Map<string, { size: number, isDir: boolean, mtime?: Date }>();

        before(async () => {
            original = readFullflash(phone.fullflash)!;

            const ffs   = FFS.open(original);
            const root  = `/${phone.partition}`;

            ffs.mkdir(`${root}/${dir}`, TIMESTAMP);
            ffs.mkdir(`${root}/${dir}/sub`, TIMESTAMP);
            ffs.writeFile(`${root}/${dir}/replaced.bin`, pattern(7000, 5), TIMESTAMP);

            // Twice the partition in writes over one file, which gets its blocks compacted
            const churn = 256 * 1024;

            for (let written = 0; written < 2 * partitionSize(original, phone.partition); written += churn) {
                ffs.writeFile(`${root}/${dir}/churn.bin`, pattern(churn, written / churn), TIMESTAMP);
            }

            ffs.remove(`${root}/${dir}/churn.bin`);
            ffs.mkdir(`${root}/${dir}/to move`, TIMESTAMP);

            for (const file of [...files, big]) {
                ffs.writeFile(`${root}/${file.writtenAs ?? file.path}`, file.data, TIMESTAMP);
            }

            ffs.writeFile(`${root}/${removed}`, pattern(5000, 7), TIMESTAMP);
            ffs.remove(`${root}/${removed}`);

            ffs.mkdir(`${root}/${phoneDir}`);
            ffs.mkdir(`${root}/${phoneDir}/sub`);

            for (const file of [kept, { ...replaced, data: pattern(5000, 19) }, ...deleted]) {
                ffs.writeFile(`${root}/${file.writtenAs ?? file.path}`, file.data);
            }

            for (const [from, to] of RENAMES) {
                ffs.rename(`${root}/${from}`, `${root}/${to}`);
            }

            work    = workDir(phone, ffs.save());
            session = await boot(phone, work.fullflash);
        }, { timeout: BOOT_TIMEOUT });

        beforeEach(async () => {
            if (session) {
                await reconnect(session);
            }
        });

        after(async () => {
            if (session) {
                await shutdown(session);
            }

            if (work) {
                fs.rmSync(work.dir, { recursive: true, force: true });
            }
        });

        it("boots", () => {
            if (phone.deviceName) {
                assert.equal(session!.obex.getDeviceName(), phone.deviceName);
                assert.equal(session!.obex.getPlatform(), phone.platform);
            }

            assert.equal(findPanic(session!.received()), undefined);
        });

        it("tells the capacity and free space the library tells", { timeout: TEST_TIMEOUT }, async () => {
            await assertSpace(session!, work.fullflash, phone.partition);
        });

        it("lists the library's files and directories, with their sizes and timestamps", { timeout: TEST_TIMEOUT }, async () => {
            const entries = await listing(session!, ["Misc", dir, `${dir}/sub`, `${dir}/sub/moved`]);

            assert.equal(entries.get(dir)?.isDir, true);
            assert.equal(entries.get(`${dir}/sub`)?.isDir, true);
            assert.equal(entries.get(`${dir}/sub/moved`)?.isDir, true);

            for (const [from] of RENAMES) {
                assert.ok(!entries.has(from), from);
            }

            for (const file of [...files, big]) {
                const entry = entries.get(file.path);

                assert.deepEqual(entry && { size: entry.size, isDir: entry.isDir }, { size: file.data.length, isDir: false }, file.path);
                assertListedTime(phone, entry!.mtime, TIMESTAMP, file.path);
            }

            assert.ok(!entries.has(removed));
            assert.ok(!entries.has(`${dir}/churn.bin`));
        });

        it("reads the library's files, and one of the firmware", { timeout: TEST_TIMEOUT }, async () => {
            const firmware = { path: phone.firmwareFile, data: FFS.open(original).readFile(`/${phone.partition}/${phone.firmwareFile}`) };

            for (const file of [...files, firmware]) {
                const data = await download(session!, file);

                assert.ok(equalBytes(data, file.data), `${file.path}: ${data.length} bytes, expected ${file.data.length}`);
            }

            assert.equal(findPanic(session!.received()), undefined);
        });

        it("reads a long file of the library's", { timeout: TEST_TIMEOUT, skip: phone.unreliableObex }, async () => {
            assert.ok(equalBytes(await download(session!, big), big.data));
        });

        it("writes, replaces and deletes files", { timeout: TEST_TIMEOUT, skip: phone.unreliableObex }, async () => {
            const obex = session!.obex;

            await obex.mkdir(`/Data/${phoneDir}/by phone`);

            for (const file of [...written, replaced]) {
                await obex.putFile(`/Data/${file.path}`, file.data).catch((e: Error) => {
                    throw new Error(`${file.path}: ${e.message}`, { cause: e });
                });
            }

            for (const file of deleted) {
                await obex.deleteFile(`/Data/${file.path}`).catch((e: Error) => {
                    throw new Error(`${file.path}: ${e.message}`, { cause: e });
                });
            }

            await obex.deleteFile(`/Data/${phoneDir}/sub`);
            await obex.putFile(`/Data/${intoMoved.path}`, intoMoved.data);

            assert.deepEqual((await listing(session!, [`${dir}/sub/moved`])).get(intoMoved.path)?.size, intoMoved.data.length);

            listed = await listing(session!, [phoneDir, `${phoneDir}/by phone`]);

            assert.deepEqual([...listed].map(([path, entry]) => `${path} ${entry.isDir ? "dir" : entry.size}`).sort(), [
                `${phoneDir}/by phone dir`,
                ...[kept, replaced, ...written].map((file) => `${file.path} ${file.data.length}`),
            ].sort());
            assert.equal(findPanic(session!.received()), undefined);

            await assertSpace(session!, work.fullflash, phone.partition);
        });

        // It writes to the flash as it runs, and may move the records around
        it("leaves the library's files for the library to read", { timeout: TEST_TIMEOUT }, async () => {
            await shutdown(session!);
            session = undefined;

            const ffs = reopen(work.fullflash, original);

            for (const file of [...files, big]) {
                assertFile(ffs, phone.partition, file);
            }

            assert.ok(!ffs.exists(`/${phone.partition}/${removed}`));
        });

        it("leaves what it wrote for the library to read", { skip: phone.unreliableObex }, () => {
            const ffs = reopen(work.fullflash, original);

            assert.deepEqual(ffs.readDir(`/${phone.partition}/${phoneDir}`).map((entry) => entry.name).sort(), ["by phone", "kept.bin", "replaced.bin"]);

            for (const file of [kept, replaced, ...written, intoMoved]) {
                assertFile(ffs, phone.partition, file);
            }

            // At the time the phone kept, as it shows it
            for (const file of written) {
                assertListedTime(phone, listed.get(file.path)?.mtime, ffs.stat(`/${phone.partition}/${file.path}`)!.timestamp, file.path);
            }

            for (const file of deleted) {
                assert.ok(!ffs.exists(`/${phone.partition}/${file.path}`), file.path);
            }
        });

        it("writes into what the phone left", () => {
            const ffs   = reopen(work.fullflash, original);
            const root  = `/${phone.partition}`;
            const again: TestFile[] = [
                { path: `${dir}/small.bin`, data: pattern(200, 20) },
                { path: `${dir}/new.bin`, data: pattern(phone.chunkSize * 3, 21) },
            ];

            for (const file of again) {
                ffs.writeFile(`${root}/${file.path}`, file.data);
            }

            ffs.remove(`${root}/${big.path}`);

            const reopened = FFS.open(ffs.save());

            assert.deepEqual(reopened.warnings, ffs.warnings);

            for (const file of [...again, ...files.slice(1)]) {
                assertFile(reopened, phone.partition, file);
            }

            assert.ok(!reopened.exists(`${root}/${big.path}`));
        });
    });
}

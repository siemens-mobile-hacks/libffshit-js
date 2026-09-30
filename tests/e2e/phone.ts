// A phone booted until its screen says it has, and its filesystem answers over OBEX

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { OBEX, type AsyncSerialPort, type PhonePlatform } from "@sie-js/serial";
import { findFullflash } from "../helpers/fullflashes.js";
import { emulate, type Emulated } from "./emulator.js";
import { difference, readPng, type Screen } from "./screen.js";

export interface Phone {
    // The pmb887x-emu board, else the one the emulator detects
    device?: string;
    fullflash: string;
    // What it names itself over OBEX, and its platform as the OBEX client takes it
    deviceName?: string;
    platform?: PhonePlatform;
    // The partition it shows as /Data
    partition: string;
    // The size of the pieces files are cut in on that partition
    chunkSize: number;
    // A file of the firmware in /Data, of several pieces, which the phone leaves alone
    firmwareFile: string;
    // A picture of the screen it shows once it has booted, in screens/ or a path
    readyScreen: string;
    // Why its OBEX transfers fail now and then, when they do
    unreliableObex?: string;
    // The time zone SGOLD2 and ELKA phones are set to, in minutes from UTC, which they show the
    // timestamps they keep in UTC in
    utcOffset?: number;
}

export const SGOLD_OBEX = "the emulated SGOLD phones drop serial data, which OBEX transfers of more than a few packets rarely survive";

const SCREENS = path.join(path.dirname(fileURLToPath(import.meta.url)), "screens");

// How long the phone gets to show its screen: in the emulator they take 30-70 s
const READY_TIMEOUT_MS = 300000;

// How often the screen is looked at meanwhile
const SCREEN_INTERVAL_MS = 500;

// The share of the pixels that may differ from the picture: the date, the time and blinking icons
// take up to 3 %, while the screens before it differ by 7.8 % and more
const SCREEN_MATCH = 0.05;

// A booted phone has its filesystem up, the attempts after the first are for the exchanges the
// emulated SGOLD phones lose
const OBEX_ATTEMPTS = 3;

// How much of what the phone sent is kept for the panic check
const RECEIVED_TAIL_SIZE = 4096;

export interface Session {
    emulated: Emulated;
    obex: OBEX;
    // The last bytes the phone sent
    received(): Buffer;
}

// A directory holding the fullflash for the emulator to run on, and the ESN the emulator recovered
// from the original, which spares it doing that again
export function workDir(phone: Phone, data: Uint8Array): { dir: string, fullflash: string } {
    const dir       = fs.mkdtempSync(path.join(os.tmpdir(), "sie-ffs-e2e-"));
    const fullflash = path.join(dir, path.basename(phone.fullflash));
    const esn       = `${findFullflash(phone.fullflash)}.esn`;

    fs.writeFileSync(fullflash, data);

    if (fs.existsSync(esn)) {
        fs.copyFileSync(esn, `${fullflash}.esn`);
    }

    return { dir, fullflash };
}

// The last bytes the phone sent, tapped below the stream so that the protocols see the port as it
// is. A phone that panics writes ">>EXIT<< ... FILE: ..." to its serial line and never answers
// again, which the OBEX client skips as garbage.
function tapReceived(port: AsyncSerialPort): () => Buffer {
    const stream    = port.getParentPort() as unknown as Readable;
    const binding   = (stream as any).port;
    const read      = binding.read;
    let   tail      = Buffer.alloc(0);

    binding.read = async (buffer: Buffer, offset: number, length: number) => {
        const result = await read.call(binding, buffer, offset, length);

        tail = Buffer.concat([tail, buffer.subarray(offset, offset + result.bytesRead)]).subarray(-RECEIVED_TAIL_SIZE);

        return result;
    };

    // The stream reads only when asked, and nothing asks while the phone boots
    stream.read(0);

    return () => tail;
}

export function findPanic(received: Buffer): string | undefined {
    const text  = received.toString("latin1");
    const at    = text.indexOf(">>EXIT<<");

    return at < 0 ? undefined : text.slice(at, at + 300).replace(/[^\x20-\x7e]+/g, " ").trim();
}

// Talking to the phone before it has booted can have it panic, or leave its OBEX server silent for
// good, so it is left alone until its screen says it has
async function waitForScreen(emulated: Emulated, phone: Phone, expected: Screen | undefined, received: () => Buffer): Promise<void> {
    for (const deadline = Date.now() + READY_TIMEOUT_MS; Date.now() < deadline;) {
        if (expected && difference(await emulated.screen(), expected) <= SCREEN_MATCH) {
            return;
        }

        if (findPanic(received())) {
            throw new Error("the phone did not boot");
        }

        await delay(SCREEN_INTERVAL_MS);
    }

    const file  = path.resolve(SCREENS, phone.readyScreen);
    const saved = path.join(os.tmpdir(), `${path.basename(phone.fullflash)}.png`);

    await emulated.saveScreen(saved);

    throw new Error(expected
        ? `the phone did not show the screen of ${file} within ${READY_TIMEOUT_MS / 1000} s, but ${saved}`
        : `there is no ${file} of the screen the phone shows once booted, the one it showed after ${READY_TIMEOUT_MS / 1000} s is ${saved}`);
}

async function waitUntilReady(obex: OBEX, phone: Phone): Promise<void> {
    for (let attempt = 1; ; ++attempt) {
        try {
            if (!obex.isConnected) {
                await obex.connect(0);
            }

            await obex.getFile(`/Data/${phone.firmwareFile}`);

            return;
        } catch (e) {
            if (attempt === OBEX_ATTEMPTS) {
                throw new Error(`the phone booted, but did not send /Data/${phone.firmwareFile}: ${(e as Error).message}`);
            }
        }
    }
}

// Now and then an emulated phone panics, does not get to its screen or never answers, on a fullflash
// it boots on otherwise, so it is booted once more, on the fullflash as it was: what the phone wrote
// to it is undone. The EL71 panics in l1bbcsg in about a third of its boots on the suites' fullflash,
// before anything is sent to it.
export async function boot(phone: Phone, fullflash: string): Promise<Session> {
    const original  = fs.readFileSync(fullflash);
    const screen    = path.resolve(SCREENS, phone.readyScreen);
    const expected  = fs.existsSync(screen) ? readPng(screen) : undefined;

    for (let attempt = 1; ; ++attempt) {
        const emulated  = await emulate(fullflash, phone.device);
        const received  = tapReceived(emulated.port);
        const obex      = new OBEX(emulated.port);

        try {
            await waitForScreen(emulated, phone, expected, received);
            await waitUntilReady(obex, phone);

            return { emulated, obex, received };
        } catch (e) {
            const panic = findPanic(received());
            const log   = emulated.log();

            await emulated.stop();

            if (attempt === 1 && expected) {
                console.warn(`${phone.fullflash}: ${(e as Error).message}${panic ? ` (it panicked: ${panic})` : ""}, booting it again`);
                fs.writeFileSync(fullflash, original);

                continue;
            }

            throw new Error(`${(e as Error).message}${panic ? `\nThe phone panicked: ${panic}` : ""}${log ? `\nThe emulator's output:\n${log}` : ""}`);
        }
    }
}

// A session lost in one test is opened again, so that only that test fails
export async function reconnect(session: Session): Promise<void> {
    if (!session.obex.isConnected) {
        await session.obex.connect(0);
    }
}

export async function shutdown(session: Session): Promise<void> {
    await session.obex.disconnect().catch(() => {});
    await session.emulated.port.close().catch(() => {});
    await session.emulated.stop();
}

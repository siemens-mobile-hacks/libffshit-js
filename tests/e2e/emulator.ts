// Runs a Siemens phone in pmb887x-emu on a fullflash, without a display, its USART0 a QEMU TCP
// chardev that serialport reaches through serialport-bindings-socket. What answers there is the
// phone's own firmware: its AT interpreter, its filesystem and its OBEX server. What its display
// shows is read through QEMU's monitor.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SerialPortStream } from "@serialport/stream";
import { AsyncSerialPort } from "@sie-js/serial";
import { SocketBinding, type SocketBindingInterface } from "serialport-bindings-socket";
import { parsePpm, writePng, type Screen } from "./screen.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// SIE_FFS_E2E_EMU, else a gitignored symlink to a build directory, else the one in PATH
const EMULATORS = [process.env.SIE_FFS_E2E_EMU, path.join(HERE, ".emu", "pmb887x-emu")].filter((candidate): candidate is string => !!candidate);

function findEmulator(): string | undefined {
    const inPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "pmb887x-emu"));

    return [...EMULATORS, ...inPath].find((candidate) => fs.existsSync(candidate) && spawnSync(candidate, ["--version"]).status === 0);
}

// Why the phones cannot run here, or undefined when they can
export function emulatorMissing(): string | undefined {
    const emulator = findEmulator();

    if (!emulator) {
        return `pmb887x-emu not found in ${EMULATORS.join(", ")} or PATH: build https://github.com/siemens-mobile-hacks/pmb887x-emu and set SIE_FFS_E2E_EMU`;
    }

    if (!spawnSync(emulator, ["--help"], { encoding: "utf8" }).stdout?.includes("--headless")) {
        return `${emulator} has no --headless option, update it`;
    }

    return undefined;
}

export interface Emulated {
    port: AsyncSerialPort;
    // What the display shows
    screen(): Promise<Screen>;
    saveScreen(png: string): Promise<void>;
    // Everything the emulator printed, for a failure message
    log(): string;
    stop(): Promise<void>;
}

// They are spawned detached, to be killed as a group, and would otherwise outlive this process and
// eat the CPU the next run's phones need to keep their timing
const running = new Set<() => void>();

function exited(emu: ChildProcess): boolean {
    return emu.exitCode !== null || emu.signalCode !== null;
}

function killAll(): void {
    for (const kill of running) {
        kill();
    }

    running.clear();
}

process.on("exit", killAll);

// A listener replaces Node's default of terminating, so the signal is raised again without it
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        killAll();
        process.kill(process.pid, signal);
    });
}

async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as net.AddressInfo;

            server.close(() => resolve(port));
        });
    });
}

// Connected once the emulator listens there, which it does once QEMU has started
async function connectWhenOpen(options: net.NetConnectOpts, emu: ChildProcess, timeoutMs: number): Promise<net.Socket> {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
        const socket = await new Promise<net.Socket | undefined>((resolve) => {
            const socket = net.connect(options);

            socket.once("connect", () => resolve(socket));
            socket.once("error", () => resolve(undefined));
        });

        if (socket) {
            return socket;
        }

        if (exited(emu)) {
            throw new Error(`the emulator exited with ${emu.exitCode ?? emu.signalCode} before QEMU started`);
        }

        await delay(100);
    }

    throw new Error(`QEMU did not start within ${timeoutMs} ms`);
}

// QEMU's human monitor, which answers every command with its output and a new prompt
class Monitor {
    private output  = "";
    private queue   = Promise.resolve("");

    private constructor(private readonly socket: net.Socket) {
        socket.setEncoding("latin1");
        socket.on("data", (data: string) => this.output += data);
        socket.on("error", () => {});
    }

    static async open(socket: net.Socket): Promise<Monitor> {
        const monitor = new Monitor(socket);

        await monitor.prompt();

        return monitor;
    }

    private prompt(): Promise<string> {
        return new Promise((resolve, reject) => {
            const check = () => {
                const end = this.output.indexOf("(qemu) ");

                if (end >= 0) {
                    // After its echo of the command, which is redrawn a character at a time
                    const output = this.output.slice(0, end).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/^[^\n]*\n/, "");

                    this.output = this.output.slice(end + 7);
                    this.socket.off("data", check).off("close", closed);
                    resolve(output);
                }
            };
            const closed = () => reject(new Error("QEMU closed its monitor"));

            this.socket.on("data", check).once("close", closed);
            check();
        });
    }

    command(command: string): Promise<string> {
        const run = () => {
            this.socket.write(`${command}\n`);

            return this.prompt();
        };

        return this.queue = this.queue.then(run, run);
    }

    close(): void {
        this.socket.destroy();
    }
}

// Boots the phone on the fullflash, which it writes to as it runs, and opens its serial port, on which
// nothing is sent until the phone is talked to
export async function emulate(fullflash: string, device?: string): Promise<Emulated> {
    const tcpPort   = await freePort();
    const dir       = fs.mkdtempSync(path.join(os.tmpdir(), "sie-ffs-emu-"));
    const emu       = spawn(findEmulator()!, [
        ...(device ? ["--device", device] : []),
        "--fullflash", fullflash,
        "--rw",
        "--serial", `tcp:127.0.0.1:${tcpPort},server=on,wait=off`,
        "--qemu-monitor", `unix:${path.join(dir, "monitor")},server=on,wait=off`,
        "--headless",
    ], {
        detached: true,
        env: { ...process.env, QEMU_AUDIO_DRV: "none" },
        stdio: ["ignore", "pipe", "pipe"],
    });

    const output: Buffer[] = [];

    emu.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    emu.stderr.on("data", (chunk: Buffer) => output.push(chunk));

    const log = () => Buffer.concat(output).toString().trimEnd();

    const kill = () => {
        if (!exited(emu)) {
            try {
                process.kill(-emu.pid!, "SIGKILL");
            } catch {
                emu.kill("SIGKILL");
            }
        }
    };

    running.add(kill);

    let monitor: Monitor | undefined;

    const stop = async () => {
        running.delete(kill);
        monitor?.close();

        if (!exited(emu)) {
            const done = new Promise((resolve) => emu.once("exit", resolve));

            kill();
            await done;
        }

        fs.rmSync(dir, { recursive: true, force: true });
    };

    // PPM, since QEMU writes PNGs only when it was built with libpng
    const screen = async () => {
        const file = path.join(dir, "screen.ppm");

        fs.rmSync(file, { force: true });

        const answer = await monitor!.command(`screendump ${file}`);

        if (!fs.existsSync(file)) {
            throw new Error(`no screendump: ${answer.trim()}`);
        }

        return parsePpm(fs.readFileSync(file));
    };

    const saveScreen = async (png: string) => {
        writePng(png, await screen());
    };

    try {
        monitor = await Monitor.open(await connectWhenOpen({ path: path.join(dir, "monitor") }, emu, 60000));
        (await connectWhenOpen({ host: "127.0.0.1", port: tcpPort }, emu, 60000)).destroy();

        // The baud rate means nothing on a TCP chardev
        const port = new AsyncSerialPort(new SerialPortStream<SocketBindingInterface>({
            binding:    SocketBinding,
            path:       `tcp://127.0.0.1:${tcpPort}`,
            baudRate:   115200,
            autoOpen:   false,
        }));

        await port.open();

        return { port, screen, saveScreen, log, stop };
    } catch (e) {
        await stop();

        throw new Error(`${(e as Error).message}${log() ? `\nThe emulator's output:\n${log()}` : ""}`);
    }
}

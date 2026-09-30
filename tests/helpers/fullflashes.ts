// The phones' fullflashes, which are their firmware and not part of the repository:
// FFSHIT_TEST_FULLFLASHES lists directories holding them, separated by the path delimiter, else
// tests/fullflashes, which may be a symlink. They are known by their paths in the directories.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function directories(): string[] {
    const dirs = process.env.FFSHIT_TEST_FULLFLASHES?.split(path.delimiter).filter(Boolean) ?? [];

    dirs.push(path.join(ROOT, "tests", "fullflashes"));

    return dirs.filter((dir) => fs.existsSync(dir));
}

// By its path in the directories, or by an absolute one
export function findFullflash(name: string): string | undefined {
    const files = path.isAbsolute(name) ? [name] : directories().map((dir) => path.join(dir, name));

    return files.find((file) => fs.existsSync(file));
}

export function readFullflash(name: string): Uint8Array | undefined {
    const file = findFullflash(name);

    return file ? new Uint8Array(fs.readFileSync(file)) : undefined;
}

// All there are, in subdirectories too: raw dumps, and x65flasher's
export function allFullflashes(dirs = directories()): string[] {
    const names = dirs.flatMap((dir) => fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((name) => /\.(bin|fls|fbk)$/i.test(name) && fs.statSync(path.join(dir, name)).isFile())
        .map((name) => name.split(path.sep).join("/")));

    return [...new Set(names)].sort();
}

export const NO_FULLFLASHES = "not found: set FFSHIT_TEST_FULLFLASHES";

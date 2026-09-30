// The phones' fullflashes, which are their firmware and not part of the repository:
// FFSHIT_TEST_FULLFLASHES lists directories holding them, separated by the path delimiter, else
// tests/fullflashes, which may be a symlink.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

function directories(): string[] {
    const dirs = process.env.FFSHIT_TEST_FULLFLASHES?.split(path.delimiter).filter(Boolean) ?? [];

    dirs.push(path.join(ROOT, "tests", "fullflashes"));

    return dirs.filter((dir) => fs.existsSync(dir));
}

export function readFullflash(name: string): Uint8Array | undefined {
    const file = directories().map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file));

    return file ? new Uint8Array(fs.readFileSync(file)) : undefined;
}

// The names of all there are
export function allFullflashes(): string[] {
    const names = directories().flatMap((dir) => fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".bin")));

    return [...new Set(names)].sort();
}

export const NO_FULLFLASHES = "not found: set FFSHIT_TEST_FULLFLASHES";

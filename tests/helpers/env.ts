// Where the tests find what is not part of the repository: the fullflashes, which are the phones'
// firmware, and ffshit-ref, the C++ libffshit to compare with.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// FFSHIT_TEST_FULLFLASHES: directories holding fullflashes, separated by the path delimiter, as
// for the C++ tests. Else tests/fullflashes, which may be a symlink.
export function fullflashDirs(): string[] {
    const dirs = process.env.FFSHIT_TEST_FULLFLASHES?.split(path.delimiter).filter(Boolean) ?? [];

    dirs.push(path.join(ROOT, "tests", "fullflashes"));

    return dirs.filter((dir) => fs.existsSync(dir));
}

export function findFullflash(name: string): string | undefined {
    return fullflashDirs().map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file));
}

// Every fullflash there is
export function allFullflashes(): string[] {
    const files = fullflashDirs().flatMap((dir) => fs.readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith(".bin"))
        .map((name) => path.join(dir, name)));

    return [...new Map(files.map((file) => [path.basename(file), file])).values()].sort();
}

// LIBFFSHIT_REF, else what `pnpm build:reference` builds
export function referenceBinary(): string | undefined {
    const binary = process.env.LIBFFSHIT_REF ?? path.join(ROOT, "tests", "reference", "build", "ffshit-ref");

    return fs.existsSync(binary) ? binary : undefined;
}

export interface ReferenceRun {
    // Undefined when the C++ library crashed, which it does where its behavior is undefined
    output: string | undefined;
    signal?: string;
}

export function runReference(args: string[], input?: string): ReferenceRun {
    try {
        const output = execFileSync(referenceBinary()!, args, {
            input,
            maxBuffer: 2 * 1024 * 1024 * 1024,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });

        return { output };
    } catch (e) {
        const error = e as { signal?: string, status?: number, stderr?: string };

        if (error.signal || (error.status !== undefined && error.status > 128)) {
            return { output: undefined, signal: error.signal ?? `exit ${error.status}` };
        }

        throw new Error(`ffshit-ref ${args.join(" ")} failed: ${error.stderr}`);
    }
}

export function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "libffshit-js-"));
}

export const SKIP_NO_REFERENCE = referenceBinary() ? false : "ffshit-ref is not built: run `pnpm build:reference`";

// The helpers of the rewrite against the C++ library's: FAT timestamps in time zones with and
// without daylight saving time, the name hashes, the codepages and the conversion of UTF-16 names
// with iconv, on inputs made to hit their edges and on random ones.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCodepage, sgoldNameFromUtf8, sgoldNameToUtf8 } from "../../src/filesystem/codepage.js";
import { CODEPAGE_ALIASES, CODEPAGE_TABLES } from "../../src/filesystem/codepages.js";
import { nameHash8bit, nameHashUtf16 } from "../../src/filesystem/hash.js";
import { fatTimestampToUnix, unixToFatTimestamp } from "../../src/filesystem/help.js";
import { decodeUtf16Name } from "../../src/filesystem/utf16.js";
import { unhexString } from "../helpers/dump.js";
import { runReference, SKIP_NO_REFERENCE } from "../helpers/env.js";
import { random } from "../helpers/write.js";

function hex(bytes: Uint8Array | number[]): string {
    return Buffer.from(bytes).toString("hex");
}

function reference(lines: string[], tz?: string): string[] {
    const previous = process.env.TZ;

    if (tz !== undefined) {
        process.env.TZ = tz;
    }

    try {
        return runReference(["units"], lines.join("\n") + "\n").output!.split("\n").slice(0, lines.length);
    } finally {
        if (tz !== undefined) {
            process.env.TZ = previous;
        }
    }
}

// Compares every line, reporting the first few that differ
function compareAll(lines: string[], expected: string[], actual: string[]): void {
    const differences: string[] = [];

    for (let i = 0; i < lines.length && differences.length < 10; ++i) {
        if (actual[i] !== expected[i]) {
            differences.push(`${lines[i]}: ${actual[i]} (rewrite) != ${expected[i]} (C++)`);
        }
    }

    assert.deepEqual(differences, [], `${differences.length} of ${lines.length} differ`);
}

function fat(year: number, month: number, day: number, hour: number, minute: number, second2: number): number {
    return (((year - 1980) << 25) | (month << 21) | (day << 16) | (hour << 11) | (minute << 5) | second2) >>> 0;
}

// The days on which the time zone's offset changes, in the years FAT timestamps hold
function transitionDays(): Date[] {
    const days: Date[] = [];

    for (let year = 1980; year <= 2107; ++year) {
        for (let day = new Date(year, 0, 1, 12); day.getFullYear() === year; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 12)) {
            const before    = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0).getTimezoneOffset();
            const after     = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0).getTimezoneOffset();

            if (before !== after) {
                days.push(day);
            }
        }
    }

    return days;
}

// Whether the local time the date shows also shows at another time, as when daylight saving time
// ends: the date is the earlier of the two
function isRepeated(date: Date): boolean {
    const local = (d: Date) => [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].join();

    return [30, 60, 120].some((minutes) => local(new Date(date.getTime() + minutes * 60000)) === local(date));
}

const TIME_ZONES = ["UTC", "America/Chicago", "Europe/Berlin", "Europe/Moscow", "Australia/Lord_Howe", "America/Sao_Paulo", "Asia/Tehran", "Pacific/Apia"];

describe("Helpers match the C++ library", { skip: SKIP_NO_REFERENCE }, () => {
    for (const tz of TIME_ZONES) {
        describe(`in ${tz}`, () => {
            it("converts FAT timestamps to time points", () => {
                const previous = process.env.TZ;

                process.env.TZ = tz;

                try {
                    const next = random(1);
                    const values: number[] = [];

                    // Every field out of range too, which mktime() carries over
                    for (let i = 0; i < 20000; ++i) {
                        values.push(Math.floor(next() * 0x100000000));
                    }

                    for (const month of [0, 1, 2, 12, 13, 15]) {
                        for (const day of [0, 1, 28, 29, 30, 31]) {
                            for (const hour of [0, 23, 24, 31]) {
                                values.push(fat(2000, month, day, hour, 63, 31), fat(1980, month, day, hour, 0, 0), fat(2107, month, day, hour, 59, 29));
                            }
                        }
                    }

                    // Around the changes to and from daylight saving time, every 2 minutes
                    for (const day of transitionDays()) {
                        for (let minute = 0; minute < 24 * 60; minute += 2) {
                            values.push(fat(day.getFullYear(), day.getMonth() + 1, day.getDate(), Math.floor(minute / 60), minute % 60, 0));
                        }
                    }

                    // But for the hour that repeats when daylight saving time ends, whose times
                    // glibc's mktime() tells apart by what it was asked before: see below
                    const unambiguous = values.filter((value) => !isRepeated(fatTimestampToUnix(value)));

                    assert.ok(unambiguous.length > values.length * 0.97);

                    const lines     = unambiguous.map((value) => `fat2unix ${value}`);
                    const expected  = reference(lines, tz);
                    const actual    = unambiguous.map((value) => String(fatTimestampToUnix(value).getTime() / 1000));

                    compareAll(lines, expected, actual);
                } finally {
                    process.env.TZ = previous;
                }
            });

            it("converts time points to FAT timestamps", () => {
                const previous = process.env.TZ;

                process.env.TZ = tz;

                try {
                    const next = random(2);
                    const seconds: number[] = [0, -1, 1, 315532799, 315532800, 4354819199, 4354819200, 4354862399, 4354905600, -2208988800];

                    for (let i = 0; i < 20000; ++i) {
                        seconds.push(Math.floor(-1e9 + next() * 9e9));
                    }

                    for (const day of transitionDays()) {
                        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() / 1000;

                        for (let second = 0; second < 86400; second += 599) {
                            seconds.push(start + second);
                        }
                    }

                    const lines     = seconds.map((second) => `unix2fat ${second}`);
                    const expected  = reference(lines, tz);
                    const actual    = seconds.map((second) => String(unixToFatTimestamp(second * 1000)));

                    compareAll(lines, expected, actual);
                } finally {
                    process.env.TZ = previous;
                }
            });
        });
    }

    it("takes a time that repeats for its first occurrence, which glibc does after a summer time", () => {
        // 2003-10-26 02:47:02 in Berlin, first in summer time, then an hour later in winter time
        const repeated  = fat(2003, 10, 26, 2, 47, 1);
        const winter    = fat(2003, 1, 15, 12, 0, 0);
        const summer    = fat(2003, 7, 15, 12, 0, 0);
        const lines     = [winter, repeated, summer, repeated].map((value) => `fat2unix ${value}`);
        const expected  = reference(lines, "Europe/Berlin");

        assert.equal(expected[1], "1067132822");
        assert.equal(expected[3], "1067129222");

        const previous = process.env.TZ;

        process.env.TZ = "Europe/Berlin";

        try {
            assert.equal(fatTimestampToUnix(repeated).getTime() / 1000, 1067129222);
        } finally {
            process.env.TZ = previous;
        }
    });

    it("hashes UTF-16 names", () => {
        const next  = random(3);
        const names: number[][] = [];
        const ranges = [[0x20, 0x7F], [0x80, 0x250], [0x370, 0x530], [0x530, 0x590], [0x1E00, 0x2000], [0x2100, 0x2500], [0xD800, 0xE000], [0xFF00, 0x10000], [0, 0x10000]];

        for (let i = 0; i < 20000; ++i) {
            const range = ranges[i % ranges.length];
            const name  = Array.from({ length: Math.floor(next() * 40) }, () => range[0] + Math.floor(next() * (range[1] - range[0])));

            names.push(name);
        }

        // Every character on its own and after every shift the previous one makes
        for (let c = 0; c < 0x10000; ++c) {
            names.push([c], [c, c], [7, c]);
        }

        const toBytes   = (name: number[]) => name.flatMap((unit) => [unit & 0xFF, unit >>> 8]);
        const lines     = names.map((name) => `hash16 ${hex(toBytes(name))}`);
        const expected  = reference(lines);
        const actual    = names.map((name) => String(nameHashUtf16(name)));

        compareAll(lines, expected, actual);
    });

    it("hashes 8-bit names", () => {
        const next  = random(4);
        const names: number[][] = [];

        for (let i = 0; i < 20000; ++i) {
            names.push(Array.from({ length: 1 + Math.floor(next() * 60) }, () => 1 + Math.floor(next() * 255)));
        }

        for (let c = 1; c < 256; ++c) {
            names.push([c], [c, c, c], [0x1F, c]);
        }

        const lines     = names.map((name) => `hash8 ${hex(name)}`);
        const expected  = reference(lines);
        const actual    = names.map((name) => String(nameHash8bit(name)));

        compareAll(lines, expected, actual);
    });

    it("knows the codepages it knows by every name", () => {
        const names     = [...Object.keys(CODEPAGE_TABLES), ...Object.keys(CODEPAGE_ALIASES), "utf-8", "UTF8", "cp1251", "Windows-1252", "koi8-r"];
        const lines     = names.map((name) => `checkcp ${hex([...Buffer.from(name)])}`);
        const expected  = reference(lines);
        const actual    = names.map((name) => {
            checkCodepage(name);

            return "OK:";
        });

        compareAll(lines, expected, actual);
    });

    it("rejects codepages neither knows", () => {
        const names     = ["NO-SUCH-CODEPAGE", "CP99999", "ISO-8859-99", "WINDOWS-9999"];
        const lines     = names.map((name) => `checkcp ${hex([...Buffer.from(name)])}`);
        const expected  = reference(lines);
        const actual    = names.map((name) => {
            try {
                checkCodepage(name);

                return "OK:";
            } catch (e) {
                return `E:${hex([...Buffer.from((e as Error).message)])}`;
            }
        });

        compareAll(lines, expected, actual);
    });

    for (const codepage of [...Object.keys(CODEPAGE_TABLES), "UTF-8"]) {
        it(`converts SGOLD names in ${codepage}`, () => {
            const next  = random(5);
            const table = CODEPAGE_TABLES[codepage];

            // Stored names: every byte, runs of the codepage's bytes, names in UTF-8
            const stored: number[][] = [];

            for (let byte = 1; byte < 256; ++byte) {
                stored.push([byte], [0x41, byte, 0x42], [0x1F, byte], [byte, 0x1F]);
            }

            for (let i = 0; i < 3000; ++i) {
                stored.push(Array.from({ length: 1 + Math.floor(next() * 30) }, () => (i % 3 ? 0x80 : 1) + Math.floor(next() * (i % 3 ? 128 : 255))));
                stored.push([0x1F, ...Buffer.from(`ф${i}ä中`)]);
            }

            const toUtf8Lines     = stored.map((name) => `name2utf8 ${codepage} ${hex(name)}`);
            const toUtf8Expected  = reference(toUtf8Lines).map((line) => line.startsWith("OK:") ? unhexString(line.slice(3)) : line);
            const toUtf8Actual    = stored.map((name) => sgoldNameToUtf8(Uint8Array.from(name), codepage));

            compareAll(toUtf8Lines, toUtf8Expected, toUtf8Actual);

            // Names in UTF-8: of the codepage's characters, and of others it lacks
            const repertoire = table ? table.filter((c) => c > 0).map((c) => String.fromCodePoint(c)) : ["ф", "ä", "€"];
            const others     = ["中", "😀", "Ω", "ф", "ä", "€", " ", "�", "́"];
            const names: string[] = [...repertoire, ...others];

            for (let i = 0; i < 3000; ++i) {
                const pool = i % 4 ? repertoire : [...repertoire, ...others];

                names.push(Array.from({ length: 1 + Math.floor(next() * 20) }, () => pool[Math.floor(next() * pool.length)]).join(""));
            }

            const fromUtf8Lines     = names.map((name) => `utf82name ${codepage} ${hex([...Buffer.from(name)])}`);
            const fromUtf8Expected  = reference(fromUtf8Lines);
            const fromUtf8Actual    = names.map((name) => `OK:${hex(sgoldNameFromUtf8(name, codepage))}`);

            compareAll(fromUtf8Lines, fromUtf8Expected, fromUtf8Actual);
        });
    }

    it("rejects names that are not Unicode", () => {
        // A lone surrogate in a string, which is what UTF-8 with a surrogate encoded in it is
        const names     = ["\uD800", "a\uDC00b", "ф\uD83D", "\uDE00ä"];
        const encode    = (name: string) => [...name].flatMap((c) => {
            const code = c.codePointAt(0)!;

            return code >= 0xD800 && code <= 0xDFFF ? [0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F)] : [...Buffer.from(c)];
        });
        const lines     = names.map((name) => `utf82name CP1252 ${hex(encode(name))}`);
        const expected  = reference(lines).map((line) => line.startsWith("E:") ? "error" : line);
        const actual    = names.map((name) => {
            try {
                return `OK:${hex(sgoldNameFromUtf8(name, "CP1252"))}`;
            } catch {
                return "error";
            }
        });

        compareAll(lines, expected, actual);
    });

    it("converts UTF-16 names as iconv does", () => {
        const next  = random(6);
        const names: number[][] = [];
        const units = [0x0000, 0x0041, 0x007F, 0x0080, 0x07FF, 0x0800, 0x4E2D, 0xD800, 0xDBFF, 0xDC00, 0xDFFF, 0xFEFF, 0xFFFE, 0xFFFF];

        // Every pair of interesting units, then random names: the conversion fails when the UTF-8
        // takes more bytes than there are, on a lone surrogate and on an odd byte
        for (const a of units) {
            for (const b of units) {
                names.push([a, b], [a, b, 0], [0x41, a, b, 0, 0]);
            }
        }

        for (let i = 0; i < 20000; ++i) {
            const length    = Math.floor(next() * 20);
            const name      = Array.from({ length }, () => next() < 0.3 ? units[Math.floor(next() * units.length)] : Math.floor(next() * (next() < 0.5 ? 0x800 : 0x10000)));
            const padding   = Math.floor(next() * 6);

            names.push([...name, ...Array(padding).fill(0)]);
        }

        const toBytes = (name: number[], odd: boolean) => [...name.flatMap((unit) => [unit & 0xFF, unit >>> 8]), ...(odd ? [0x41] : [])];
        const inputs  = names.flatMap((name, i) => [toBytes(name, false), ...(i % 10 === 0 ? [toBytes(name, true)] : [])]);
        const lines   = inputs.map((bytes) => `utf16name ${hex(bytes)}`);
        const expected = reference(lines).map((line) => line.startsWith("OK:") ? `OK:${unhexString(line.slice(3))}` : line);
        const actual   = inputs.map((bytes) => {
            if (!bytes.length) {
                return "OK:";
            }

            const name = decodeUtf16Name(Uint8Array.from(bytes));

            return name === undefined ? "FAIL" : `OK:${name}`;
        });

        compareAll(lines, expected, actual);
    });
});

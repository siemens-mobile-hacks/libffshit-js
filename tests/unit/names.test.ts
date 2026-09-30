import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeName, encodeName, resolveCodepage } from "../../src/filesystem/codepage.js";
import { dateToFatTime, fatTimeToDate } from "../../src/filesystem/fattime.js";
import { FFSError } from "../../src/index.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("FAT timestamps", () => {
    const withTz = (tz: string, run: () => void) => () => {
        const previous = process.env.TZ;

        process.env.TZ = tz;

        try {
            run();
        } finally {
            process.env.TZ = previous;
        }
    };

    it("are in the local time, in whole even seconds", withTz("UTC", () => {
        // 2024-05-17 13:37:42
        const fat = ((2024 - 1980) << 25 | 5 << 21 | 17 << 16 | 13 << 11 | 37 << 5 | 21) >>> 0;

        assert.equal(fatTimeToDate(fat).toISOString(), "2024-05-17T13:37:42.000Z");
        assert.equal(dateToFatTime(Date.UTC(2024, 4, 17, 13, 37, 43, 999)), fat);
        assert.equal(dateToFatTime(new Date(Date.UTC(2024, 4, 17, 13, 37, 42))), fat);
    }));

    it("count daylight saving time in", withTz("Europe/Berlin", () => {
        const fat = ((2024 - 1980) << 25 | 7 << 21 | 1 << 16 | 12 << 11) >>> 0;

        assert.equal(fatTimeToDate(fat).toISOString(), "2024-07-01T10:00:00.000Z");
        assert.equal(dateToFatTime(Date.UTC(2024, 6, 1, 10)), fat);
    }));

    it("carry out of range fields over", withTz("UTC", () => {
        // Month 13, day 0, hour 25, minute 63, second 62: 2000-12-31 25:63:62
        const fat = ((2000 - 1980) << 25 | 13 << 21 | 0 << 16 | 25 << 11 | 63 << 5 | 31) >>> 0;

        assert.equal(fatTimeToDate(fat).toISOString(), "2001-01-01T02:04:02.000Z");
    }));

    it("hold the years 1980 to 2107", withTz("UTC", () => {
        assert.equal(dateToFatTime(0), (1 << 21) | (1 << 16));
        assert.equal(dateToFatTime(Date.UTC(2200, 0)), ((127 << 25) | (12 << 21) | (31 << 16) | (23 << 11) | (59 << 5) | 29) >>> 0);
        assert.throws(() => dateToFatTime(NaN), FFSError);
    }));
});

describe("8-bit names", () => {
    it("are kept in the codepage when it has every character, else as 0x1F and UTF-8", () => {
        assert.equal(hex(encodeName("Misc", "CP1252")), "4d697363");
        assert.equal(hex(encodeName("Ärger", "CP1252")), "c472676572");
        assert.equal(hex(encodeName("файл", "CP1251")), "f4e0e9eb");
        assert.equal(hex(encodeName("файл", "CP1252")), "1fd184d0b0d0b9d0bb");
        assert.equal(hex(encodeName("Ärger", "CP1251")), "1fc38472676572");
        assert.equal(hex(encodeName("Ärger", "ANSI_X3.4-1968")), "1fc38472676572");
    });

    it("are read in the codepage, and taken for UTF-8 where it has no character for a byte", () => {
        assert.equal(decodeName(Uint8Array.of(0xC4, 0x72), "CP1252"), "Är");
        assert.equal(decodeName(Uint8Array.of(0xF4, 0xE0, 0xE9, 0xEB), "CP1251"), "файл");
        assert.equal(decodeName(Uint8Array.of(0xF4, 0xE0, 0xE9, 0xEB), "CP1252"), "ôàéë");
        assert.equal(decodeName(Uint8Array.of(0x1F, 0xD1, 0x84), "CP1252"), "ф");
        // glibc's CP1252 has no character for 0x81
        assert.equal(decodeName(Uint8Array.of(0x81, 0x41), "CP1252"), "�A");
        assert.equal(decodeName(Uint8Array.of(0x1F), "CP1252"), "\x1F");
    });

    it("must be Unicode", () => {
        assert.throws(() => encodeName("a\uD800", "CP1252"), FFSError);
    });

    it("are in codepages known by the names iconv knows them by", () => {
        assert.equal(resolveCodepage("cp1251"), "CP1251");
        assert.equal(resolveCodepage("Windows-1251"), "CP1251");
        assert.equal(resolveCodepage("latin1"), "ISO-8859-1");
        assert.equal(resolveCodepage("utf8"), "UTF-8");
        assert.throws(() => resolveCodepage("NO-SUCH-CODEPAGE"), { name: "FFSError", message: "Unknown codepage NO-SUCH-CODEPAGE" });
    });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeName, encodeName } from "../../src/filesystem/codepage.js";
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

    it("are in the local time on SGOLD and EGOLD, in whole even seconds", withTz("UTC", () => {
        // 2024-05-17 13:37:42
        const fat = ((2024 - 1980) << 25 | 5 << 21 | 17 << 16 | 13 << 11 | 37 << 5 | 21) >>> 0;

        assert.equal(fatTimeToDate(fat, false).toISOString(), "2024-05-17T13:37:42.000Z");
        assert.equal(dateToFatTime(Date.UTC(2024, 4, 17, 13, 37, 43, 999), false), fat);
        assert.equal(dateToFatTime(new Date(Date.UTC(2024, 4, 17, 13, 37, 42)), false), fat);
    }));

    it("count daylight saving time in", withTz("Europe/Berlin", () => {
        const fat = ((2024 - 1980) << 25 | 7 << 21 | 1 << 16 | 12 << 11) >>> 0;

        assert.equal(fatTimeToDate(fat, false).toISOString(), "2024-07-01T10:00:00.000Z");
        assert.equal(dateToFatTime(Date.UTC(2024, 6, 1, 10), false), fat);
    }));

    it("are in UTC on SGOLD2 and ELKA", withTz("Europe/Berlin", () => {
        const fat = ((2024 - 1980) << 25 | 7 << 21 | 1 << 16 | 12 << 11) >>> 0;

        assert.equal(fatTimeToDate(fat, true).toISOString(), "2024-07-01T12:00:00.000Z");
        assert.equal(dateToFatTime(Date.UTC(2024, 6, 1, 12), true), fat);
    }));

    it("carry out of range fields over", withTz("UTC", () => {
        // Month 13, day 0, hour 25, minute 63, second 62: 2000-12-31 25:63:62
        const fat = ((2000 - 1980) << 25 | 13 << 21 | 0 << 16 | 25 << 11 | 63 << 5 | 31) >>> 0;

        assert.equal(fatTimeToDate(fat, false).toISOString(), "2001-01-01T02:04:02.000Z");
    }));

    it("hold the years 1980 to 2107", withTz("UTC", () => {
        assert.equal(dateToFatTime(0, false), (1 << 21) | (1 << 16));
        assert.equal(dateToFatTime(Date.UTC(2200, 0), false), ((127 << 25) | (12 << 21) | (31 << 16) | (23 << 11) | (59 << 5) | 29) >>> 0);
        assert.throws(() => dateToFatTime(NaN, false), FFSError);
    }));
});

// As the emulated SGOLD phones keep and list names, whatever their language
describe("8-bit names", () => {
    it("are kept in CP1252 when it has every character", () => {
        // Every character it has from 0x80 to 0x9F
        const upper = "\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178";

        assert.equal(hex(encodeName("Misc")), "4d697363");
        assert.equal(hex(encodeName("Ärger")), "c472676572");
        assert.equal(hex(encodeName("ärger")), "e472676572");
        assert.equal(hex(encodeName(upper)), "8082838485868788898a8b8c8e9192939495969798999a9b9c9e9f");
        assert.equal(decodeName(encodeName(upper)), upper);
        assert.equal(hex(encodeName("\u00A0ÿ")), "a0ff");
    });

    it("are kept as 0x1F and UTF-8, all of them, when CP1252 lacks a character", () => {
        assert.equal(hex(encodeName("файл")), "1fd184d0b0d0b9d0bb");
        assert.equal(hex(encodeName("Ärger ф")), "1fc3847267657220d184");
        assert.equal(hex(encodeName("łódź")), "1fc582c3b364c5ba");
        assert.equal(hex(encodeName("Ωmega")), "1fcea96d656761");
        assert.equal(hex(encodeName("😀")), "1ff09f9880");
        // Latin-1's control characters, where CP1252 has others
        assert.equal(hex(encodeName("\u0080")), "1fc280");
        assert.equal(hex(encodeName("\u0081")), "1fc281");
    });

    it("are read in CP1252 without the 0x1F, even when they are UTF-8", () => {
        assert.equal(decodeName(Uint8Array.of(0xC4, 0x72)), "Är");
        assert.equal(decodeName(Uint8Array.of(0x80, 0x8A, 0x9C, 0x84)), "€Šœ„");
        // "файл" in CP1251, and in UTF-8
        assert.equal(decodeName(Uint8Array.of(0xF4, 0xE0, 0xE9, 0xEB)), "ôàéë");
        assert.equal(decodeName(Uint8Array.of(0xD1, 0x84, 0xD0, 0xB0, 0xD0, 0xB9, 0xD0, 0xBB)), "Ñ„Ð°Ð¹Ð»");
        assert.equal(decodeName(Uint8Array.of(0x1F)), "\x1F");
    });

    it("read the bytes CP1252 has no characters for as spaces, as the firmware does", () => {
        assert.equal(decodeName(Uint8Array.of(0x81, 0x41, 0x8D, 0x8F, 0x90, 0x9D)), " A    ");
        // "с" in UTF-8 is D1 81
        assert.equal(decodeName(Uint8Array.of(0xD1, 0x81)), "Ñ ");
    });

    it("are read as UTF-8 after the 0x1F", () => {
        assert.equal(decodeName(Uint8Array.of(0x1F, 0xD1, 0x84)), "ф");
        assert.equal(decodeName(Uint8Array.of(0x1F, 0xC3, 0x84)), "Ä");
        assert.equal(decodeName(Uint8Array.of(0x1F, 0xFF, 0xFE)), "��");
    });

    it("read back as they were written", () => {
        for (let byte = 0x20; byte < 0x100; ++byte) {
            if (![0x81, 0x8D, 0x8F, 0x90, 0x9D].includes(byte)) {
                assert.equal(hex(encodeName(decodeName(Uint8Array.of(byte)))), hex(Uint8Array.of(byte)));
            }
        }

        for (const name of ["Ärger", "€", "файл", "łódź", "中文", "😀"]) {
            assert.equal(decodeName(encodeName(name)), name);
        }
    });

    it("must be Unicode", () => {
        assert.throws(() => encodeName("a\uD800"), FFSError);
    });
});

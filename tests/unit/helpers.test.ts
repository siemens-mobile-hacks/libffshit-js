// The helpers, on what their C++ counterparts are known to do. tests/differential/units.test.ts
// compares them with the C++ library on many more inputs.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCodepage, sgoldNameFromUtf8, sgoldNameToUtf8 } from "../../src/filesystem/codepage.js";
import { decodeUtf16Name } from "../../src/filesystem/utf16.js";
import { fatTimestampToUnix, FilesystemError, unixToFatTimestamp } from "../../src/index.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const utf16 = (str: string) => Uint8Array.from(Buffer.from(str, "utf16le"));

describe("FAT timestamps", () => {
    const withTz = (tz: string, run: () => void) => {
        const previous = process.env.TZ;

        process.env.TZ = tz;

        try {
            run();
        } finally {
            process.env.TZ = previous;
        }
    };

    it("are in the local time, in whole even seconds", () => withTz("UTC", () => {
        // 2024-05-17 13:37:42
        const fat = ((2024 - 1980) << 25 | 5 << 21 | 17 << 16 | 13 << 11 | 37 << 5 | 21) >>> 0;

        assert.equal(fatTimestampToUnix(fat).toISOString(), "2024-05-17T13:37:42.000Z");
        assert.equal(unixToFatTimestamp(Date.UTC(2024, 4, 17, 13, 37, 43, 999)), fat);
        assert.equal(unixToFatTimestamp(new Date(Date.UTC(2024, 4, 17, 13, 37, 42))), fat);
    }));

    it("count daylight saving time in", () => withTz("Europe/Berlin", () => {
        const fat = ((2024 - 1980) << 25 | 7 << 21 | 1 << 16 | 12 << 11) >>> 0;

        assert.equal(fatTimestampToUnix(fat).toISOString(), "2024-07-01T10:00:00.000Z");
        assert.equal(unixToFatTimestamp(Date.UTC(2024, 6, 1, 10)), fat);
    }));

    it("carry out of range fields over, as mktime() does", () => withTz("UTC", () => {
        // Month 13, day 0, hour 25, minute 63, second 62: 2000-12-31 25:63:62
        const fat = ((2000 - 1980) << 25 | 13 << 21 | 0 << 16 | 25 << 11 | 63 << 5 | 31) >>> 0;

        assert.equal(fatTimestampToUnix(fat).toISOString(), "2001-01-01T02:04:02.000Z");
    }));

    it("hold the years 1980 to 2107", () => withTz("UTC", () => {
        assert.equal(unixToFatTimestamp(0), (1 << 21) | (1 << 16));
        assert.equal(unixToFatTimestamp(Date.UTC(2200, 0)), ((127 << 25) | (12 << 21) | (31 << 16) | (23 << 11) | (59 << 5) | 29) >>> 0);
        assert.throws(() => unixToFatTimestamp(NaN), TypeError);
    }));
});

describe("SGOLD names", () => {
    it("are kept in the codepage when it has every character, else as 0x1F and UTF-8", () => {
        assert.equal(hex(sgoldNameFromUtf8("Misc", "CP1252")), "4d697363");
        assert.equal(hex(sgoldNameFromUtf8("Ärger", "CP1252")), "c472676572");
        assert.equal(hex(sgoldNameFromUtf8("файл", "CP1251")), "f4e0e9eb");
        assert.equal(hex(sgoldNameFromUtf8("файл", "CP1252")), "1fd184d0b0d0b9d0bb");
        assert.equal(hex(sgoldNameFromUtf8("Ärger", "CP1251")), "1fc38472676572");
    });

    it("are read in the codepage, and taken for UTF-8 where it has no character for a byte", () => {
        assert.equal(sgoldNameToUtf8(Uint8Array.of(0xC4, 0x72), "CP1252"), "Är");
        assert.equal(sgoldNameToUtf8(Uint8Array.of(0xF4, 0xE0, 0xE9, 0xEB), "CP1251"), "файл");
        assert.equal(sgoldNameToUtf8(Uint8Array.of(0xF4, 0xE0, 0xE9, 0xEB), "CP1252"), "ôàéë");
        assert.equal(sgoldNameToUtf8(Uint8Array.of(0x1F, 0xD1, 0x84), "CP1252"), "ф");
        // glibc has no character for 0x81 in CP1252
        assert.equal(sgoldNameToUtf8(Uint8Array.of(0x81, 0x41), "CP1252"), "�A");
    });

    it("must be Unicode", () => {
        assert.throws(() => sgoldNameFromUtf8("a\uD800", "CP1252"), FilesystemError);
    });

    it("know codepages by the names iconv knows them by", () => {
        assert.equal(checkCodepage("cp1251"), "CP1251");
        assert.equal(checkCodepage("Windows-1251"), "CP1251");
        assert.equal(checkCodepage("latin1"), "ISO-8859-1");
        assert.equal(checkCodepage("utf8"), "UTF-8");
        assert.throws(() => checkCodepage("NO-SUCH-CODEPAGE"), { message: "Unknown codepage NO-SUCH-CODEPAGE" });
    });
});

describe("UTF-16 names", () => {
    it("end at a 0", () => {
        assert.equal(decodeUtf16Name(utf16("Misc\0\0garbage")), "Misc");
    });

    // iconv gets as many bytes to write to as it reads, as the C++ library gives it
    it("fail where iconv would", () => {
        assert.equal(decodeUtf16Name(Uint8Array.of(0x41, 0x00, 0x42)), undefined);
        assert.equal(decodeUtf16Name(Uint8Array.of(0x00, 0xD8, 0x41, 0x00)), undefined);
        assert.equal(decodeUtf16Name(utf16("中中")), undefined);
        assert.equal(decodeUtf16Name(utf16("中中\0\0")), "中中");
        assert.equal(decodeUtf16Name(utf16("😀")), "😀");
    });
});

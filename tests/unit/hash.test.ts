// The C++ library's hash_test.cpp: the hashes the phones keep next to these names in their
// directories, of the S75 v40 and the EL71 v41 for UTF-16 names, of the CX70 v56 and the SL65 v49
// for 8-bit names. The uploads are what the emulated phones stored for files sent to them over OBEX.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nameHash8bit, nameHashUtf16 } from "../../src/index.js";

const latin1 = (str: string) => Uint8Array.from(Buffer.from(str, "latin1"));
const stored = (str: string) => Uint8Array.from([0x1F, ...Buffer.from(str, "utf8")]);

describe("Name hashes", () => {
    it("hash UTF-16 names like the NewSGOLD firmware", () => {
        assert.equal(nameHashUtf16("Misc"),                  0xCA77);
        assert.equal(nameHashUtf16("Pictures"),              0x805A);
        assert.equal(nameHashUtf16("00"),                    0xBF4C);
        assert.equal(nameHashUtf16("09"),                    0x3F55);
        assert.equal(nameHashUtf16("Marble Madness.jad"),    0xC26A);
        assert.equal(nameHashUtf16("Siemens wallpaper.jpg"), 0x107F);
        assert.equal(nameHashUtf16("small.bin"),             0xBB37);
        assert.equal(nameHashUtf16("big.bin"),               0x3D00);
        assert.equal(nameHashUtf16("newdir"),                0x6273);
    });

    it("fold the case of UTF-16 names", () => {
        assert.equal(nameHashUtf16("tmp"),                   0x8445);
        assert.equal(nameHashUtf16("Tmp"),                   0x8445);
        assert.equal(nameHashUtf16("Аркады"),                0xAEE9);
        assert.equal(nameHashUtf16("аркады"),                0xAEE9);
        assert.equal(nameHashUtf16("Логические"),            0xD999);
        assert.equal(nameHashUtf16("призрак.mid"),           0x693A);
        assert.equal(nameHashUtf16("будильник.mp3"),         0xAF7F);
    });

    it("hash 8-bit names like the SGOLD firmware", () => {
        assert.equal(nameHash8bit(latin1("Misc")),           0x14B8);
        assert.equal(nameHash8bit(latin1("Voice memo")),     0xE07B);
        assert.equal(nameHash8bit(latin1("main")),           0x9E63);
        assert.equal(nameHash8bit(latin1("Cfg")),            0x52A9);
        assert.equal(nameHash8bit(latin1("default.cfg")),    0xB2BA);
        assert.equal(nameHash8bit(latin1("s100.bin")),       0x6C06);
        assert.equal(nameHash8bit(latin1("s2200.bin")),      0xABDE);
    });

    // As the emulated CX70 v56 stored names made over OBEX: in its codepage, CP1252, and else as
    // 0x1F and the name in UTF-8. The hash is of the stored bytes.
    it("hash 8-bit names as they are stored", () => {
        assert.equal(nameHash8bit(latin1("\xC4rger")),       0x98DC);
        assert.equal(nameHash8bit(latin1("\xE4rger")),       0xA456);
        assert.equal(nameHash8bit(latin1("a\xE9\x80")),      0x9462);
        assert.equal(nameHash8bit(stored("Файл")),           0x3152);
        assert.equal(nameHash8bit(stored("файл")),           0x92E3);
        assert.equal(nameHash8bit(stored("Ωμέγα")),          0x6F37);
        assert.equal(nameHash8bit(stored("中文")),           0x35D3);
    });

    it("fold the case of 8-bit names", () => {
        assert.equal(nameHash8bit(latin1("MISC")), nameHash8bit(latin1("misc")));
        assert.equal(nameHash8bit(latin1("Misc")), nameHash8bit(latin1("mIsC")));
    });
});

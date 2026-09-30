import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FFS, FFSError } from "../src/index.js";
import { equalBytes, pattern } from "./helpers/data.js";
import { EGOLD_LAYOUT, recordImage, SCENARIOS, SGOLD_LAYOUT, utf16 } from "./helpers/scenarios.js";
import { fatTime, filesystemRecords, RecordsBuilder, type FsFile } from "./helpers/synthetic.js";

function sgoldImage(files: FsFile[]): Uint8Array {
    const layout  = { platform: "SGOLD" as const, size: 0x800000, blockSize: 0x10000, partitions: [{ name: "FFS", blocks: 8 }] };
    const builder = new RecordsBuilder(layout);

    for (const [id, data] of filesystemRecords("SGOLD", files, { chunkSize: 1024 })) {
        builder.add("FFS", id, data);
    }

    return builder.build();
}

const FILES: FsFile[] = [
    { name: "Misc", children: [{ name: "Photo.JPG", data: pattern(3000, 1), attributes: 0x01, fat: fatTime(2008, 7, 6, 5, 4, 2) }] },
    { name: "empty.txt", data: new Uint8Array(0), attributes: 0x06 },
    // "Ärger" in CP1252, and "файл" in CP1251
    { name: Uint8Array.of(0xC4, 0x72, 0x67, 0x65, 0x72), data: pattern(5, 2) },
    { name: Uint8Array.of(0xF4, 0xE0, 0xE9, 0xEB), data: pattern(6, 3) },
];

const open = (options = {}) => FFS.open(sgoldImage(FILES), options);

// A firmware's names of drives 0:, 1: and 2:, as it keeps them: after their lengths, in UTF-16
function driveNames(image: Uint8Array, names = ["\\Data", "\\Cache", "\\Config"]): Uint8Array {
    let at = 0x8000;

    for (const name of ["0:", "1:", "2:", ...names]) {
        image.set([name.length, 0, ...utf16(name)], at);
        at += 2 + 2 * name.length;
    }

    return image;
}

// An EGOLD firmware's roots of its drives, as it keeps them: "A:\" as a C string
function driveRoots(image: Uint8Array, ...letters: string[]): Uint8Array {
    image.set(Uint8Array.from(`\0${letters.map((letter) => `${letter}:\\\0`).join("")}`, (c) => c.charCodeAt(0)), 0x8000);

    return image;
}

describe("FFS", () => {
    it("tells the platform, model and IMEI", () => {
        const ffs = open();

        assert.equal(ffs.platform, "SGOLD");
        assert.equal(ffs.model, "SYN");
        assert.equal(ffs.imei, "490154203237518");
        assert.deepEqual(ffs.warnings, []);
    });

    it("lists directories, with paths and names as the fullflash has them", () => {
        const ffs = open();

        assert.deepEqual(ffs.readDir("/").map((entry) => [entry.path, entry.isDirectory]), [["/FFS", true]]);
        assert.deepEqual(ffs.readDir("/ffs").map((entry) => entry.path), ["/FFS/Misc", "/FFS/empty.txt", "/FFS/Ärger", "/FFS/ôàéë"]);

        assert.deepEqual(ffs.readDir("/FFS/MISC/"), [{
            name:           "Photo.JPG",
            path:           "/FFS/Misc/Photo.JPG",
            isDirectory:    false,
            size:           3000,
            timestamp:      new Date(2008, 6, 6, 5, 4, 2),
            readonly:       true,
            hidden:         false,
            system:         false,
        }]);

        assert.throws(() => ffs.readDir("/nope"), { name: "FFSError", message: "/nope: no such directory" });
        assert.throws(() => ffs.readDir("/FFS/empty.txt"), { name: "FFSError", message: "/FFS/empty.txt: not a directory" });
    });

    it("finds files without regard to the case of ASCII letters, as SGOLD phones do", () => {
        const ffs = open();

        assert.equal(ffs.stat("/ffs/misc/photo.jpg")?.path, "/FFS/Misc/Photo.JPG");
        assert.equal(ffs.stat("ffs/misc/./../misc/photo.jpg")?.size, 3000);
        assert.equal(ffs.stat("/FFS/ärger"), undefined);
        assert.equal(ffs.stat("/FFS/Ärger")?.size, 5);
        assert.equal(ffs.stat("/FFS/Misc/nope"), undefined);
        assert.equal(ffs.stat("/nope/deeper"), undefined);
        assert.equal(ffs.exists("/FFS/EMPTY.TXT"), true);
        assert.equal(ffs.stat("/")?.path, "/");
    });

    it("reads files", () => {
        const ffs = open();

        assert.ok(equalBytes(ffs.readFile("/FFS/Misc/Photo.JPG"), pattern(3000, 1)));
        assert.equal(ffs.readFile("/FFS/empty.txt").length, 0);
        assert.throws(() => ffs.readFile("/FFS/Misc"), { name: "FFSError", message: "/FFS/Misc: is a directory" });
        assert.throws(() => ffs.readFile("/FFS/nope"), { name: "FFSError", message: "/FFS/nope: no such file" });
    });

    it("gives whole trees", () => {
        const ffs  = open();
        const tree = ffs.tree();

        assert.equal(tree.path, "/");
        assert.equal(tree.children?.[0].path, "/FFS");
        assert.deepEqual(tree.children?.[0].children?.[0].children?.map((entry) => [entry.name, entry.children]), [["Photo.JPG", undefined]]);
        assert.deepEqual(ffs.tree("/FFS/Misc").children?.map((entry) => entry.name), ["Photo.JPG"]);
    });

    it("tells what a partition holds, and how much of it is free", () => {
        const ffs    = open();
        const before = ffs.statfs("/ffs/misc/photo.jpg");

        // Of 8 blocks the one left alone aside, less their headers and the free entries ending the FITs
        assert.equal(before.size, 7 * (0x10000 - 32));
        assert.equal(before.readonly, false);
        assert.deepEqual(ffs.statfs("/"), { ...before, readonly: true });

        ffs.writeFile("/FFS/b.bin", pattern(2500, 9));

        // Its data in 3 pieces, 2 parts and its header, and an entry in the FIT for each
        assert.equal(before.free - ffs.statfs("/FFS").free, 2500 + 2 * 16 + 22 + 6 * 16);

        ffs.remove("/FFS/b.bin");

        assert.deepEqual(ffs.statfs("/FFS"), before);
        assert.throws(() => ffs.statfs("/FFS/nope"), { name: "FFSError", message: "/FFS/nope: no such file or directory" });
    });

    it("tells how much of every platform's partitions files take up", () => {
        for (const [scenario, partition] of [["sgold2", "FFS_0"], ["elka", "FFS_0"], ["egold", "FFS"]] as const) {
            const ffs    = FFS.open(SCENARIOS[scenario](), { experimentalEgoldWrites: true });
            const before = ffs.statfs(`/${partition}`);

            ffs.writeFile(`/${partition}/b.bin`, pattern(5000, 9));

            const taken = before.free - ffs.statfs(`/${partition}`).free;

            // Its data, and its header, parts and FIT entries, which ELKA keeps in 32 byte slots
            assert.ok(taken > 5000 && taken < 5000 + 1024, `${scenario}: ${taken}`);

            ffs.remove(`/${partition}/b.bin`);

            assert.deepEqual(ffs.statfs(`/${partition}`), before, scenario);
            assert.ok(before.free > 0 && before.free < before.size, scenario);
        }
    });

    it("tells what a FAT disk holds by its clusters", () => {
        // 697 clusters of 512 bytes, of which the files and directories take 91, or 348 of 1 KiB,
        // of which they take 63
        assert.deepEqual(FFS.open(SCENARIOS["egold lba_fs"]()).statfs("/LBA_FS"), { size: 697 * 512, free: 606 * 512, readonly: true });
        assert.deepEqual(FFS.open(SCENARIOS["egold lba_fs without a partition table, of 2-sector clusters"]()).statfs("/LBA_FS"), { size: 348 * 1024, free: 285 * 1024, readonly: true });
    });

    it("names the partitions as the phone does, where its firmware names their drives", () => {
        const layout    = { ...SGOLD_LAYOUT, partitions: [{ name: "FFS", blocks: 4 }, { name: "FFS_B", blocks: 2 }, { name: "FFS_C", blocks: 2 }] };
        const tree      = { files: [{ name: "a.txt", data: pattern(10, 1) }] };
        const ffs       = FFS.open(recordImage(layout, { FFS: tree, FFS_B: tree, FFS_C: tree }, (image) => driveNames(image)));

        assert.deepEqual(ffs.readDir("/").map((entry) => entry.path), ["/Data", "/Cache", "/Config"]);
        // The partition table's names lead to them too
        assert.equal(ffs.stat("/ffs_b/A.TXT")?.path, "/Cache/a.txt");
        assert.deepEqual(ffs.statfs("/FFS_C"), ffs.statfs("/config"));

        ffs.writeFile("/FFS/b.txt", pattern(5, 2));

        assert.deepEqual(FFS.open(ffs.save()).readDir("/data").map((entry) => entry.path), ["/Data/a.txt", "/Data/b.txt"]);
    });

    it("keeps the partition table's names where the firmware names no drive of theirs", () => {
        const layout    = { ...SGOLD_LAYOUT, partitions: [{ name: "FFS", blocks: 4 }, { name: "FFS_B", blocks: 2 }, { name: "FFS_C", blocks: 2 }] };
        const tree      = { files: [{ name: "a.txt", data: pattern(10, 1) }] };
        const names     = (image: Uint8Array) => FFS.open(image).readDir("/").map((entry) => entry.name);

        assert.deepEqual(names(recordImage(layout, { FFS: tree, FFS_B: tree, FFS_C: tree })), ["FFS", "FFS_B", "FFS_C"]);
        assert.deepEqual(names(recordImage(layout, { FFS: tree, FFS_B: tree, FFS_C: tree }, (image) => driveNames(image, ["\\Data"]))), ["Data", "FFS_B", "FFS_C"]);
        // FFS_C is no drive on SGOLD2 and ELKA
        assert.deepEqual(names(driveNames(SCENARIOS.sgold2())), ["Data", "FFS_C"]);
        assert.deepEqual(names(driveNames(SCENARIOS.elka())), ["Data", "FFS_C"]);
        // EGOLD's firmwares know their drives by letters
        assert.deepEqual(names(driveNames(SCENARIOS.egold())), ["FFS", "FFS_C"]);
    });

    it("names EGOLD partitions by their drives' letters, where the firmware has the drives' roots", () => {
        const layout    = { ...EGOLD_LAYOUT, partitions: [{ name: "FFS", blocks: 4 }, { name: "FFS_B", blocks: 2 }, { name: "FFS_C", blocks: 2 }] };
        const trees     = { FFS: { files: [{ name: "a.txt", data: pattern(10, 1) }] }, FFS_B: { files: [] }, FFS_C: { files: [] } };
        const names     = (image: Uint8Array) => FFS.open(image).readDir("/").map((entry) => entry.name);
        const ffs       = FFS.open(recordImage(layout, trees, (image) => driveRoots(image, "A", "B")), { experimentalEgoldWrites: true });

        // FFS_C is drive 3:, which has no letter
        assert.deepEqual(ffs.readDir("/").map((entry) => entry.path), ["/A", "/B", "/FFS_C"]);
        // The partition table's names lead to them too
        assert.equal(ffs.stat("/ffs/A.TXT")?.path, "/A/a.txt");
        assert.deepEqual(ffs.statfs("/FFS_B"), ffs.statfs("/b"));

        ffs.writeFile("/a/b.txt", pattern(5, 2));

        assert.deepEqual(FFS.open(ffs.save()).readDir("/A").map((entry) => entry.path), ["/A/a.txt", "/A/b.txt"]);

        assert.deepEqual(names(recordImage(layout, trees, (image) => driveRoots(image, "A"))), ["A", "FFS_B", "FFS_C"]);
        assert.deepEqual(names(recordImage(layout, trees)), ["FFS", "FFS_B", "FFS_C"]);
        // Without Card-Explorer, and the x45's LBA_FS
        assert.deepEqual(names(driveRoots(SCENARIOS["egold without card-explorer"](), "A")), ["A"]);
        assert.deepEqual(names(driveRoots(SCENARIOS["egold lba_fs"](), "A")), ["A"]);
        // SGOLD firmwares' drives have names
        assert.deepEqual(names(driveRoots(SCENARIOS.sgold(), "A")), ["FFS"]);
    });

    it("tells which partitions it does not write to", () => {
        assert.equal(FFS.open(SCENARIOS.egold()).statfs("/FFS").readonly, true);
        assert.equal(FFS.open(SCENARIOS.egold(), { experimentalEgoldWrites: true }).statfs("/FFS").readonly, false);
        assert.equal(FFS.open(SCENARIOS["egold without card-explorer"](), { experimentalEgoldWrites: true }).statfs("/FFS").readonly, true);
        assert.equal(FFS.open(SCENARIOS["sgold prototype"]()).statfs("/FFS").readonly, true);
        assert.equal(FFS.open(SCENARIOS["sgold broken"]()).statfs("/FFS").readonly, true);
    });

    it("finds 8-bit names as the phones do, in CP1252 without the 0x1F", () => {
        const ffs = FFS.open(sgoldImage([
            { name: Uint8Array.of(0x80, 0x8A, 0x9C), data: pattern(1, 1) },
            // "файл" in CP1251, in UTF-8, and in UTF-8 after the 0x1F
            { name: Uint8Array.of(0xF4, 0xE0, 0xE9, 0xEB), data: pattern(2, 2) },
            { name: Uint8Array.of(0xD1, 0x84, 0xD0, 0xB0, 0xD0, 0xB9, 0xD0, 0xBB), data: pattern(3, 3) },
            { name: Uint8Array.of(0x1F, 0xD1, 0x84, 0xD0, 0xB0, 0xD0, 0xB9, 0xD0, 0xBB, 0x2E, 0x74, 0x78, 0x74), data: pattern(4, 4) },
        ]));

        assert.deepEqual(ffs.readDir("/FFS").map((entry) => entry.name), ["€Šœ", "ôàéë", "Ñ„Ð°Ð¹Ð»", "файл.txt"]);
        assert.equal(ffs.stat("/FFS/€Šœ")?.size, 1);
        assert.equal(ffs.stat("/FFS/ôàéë")?.size, 2);
        assert.equal(ffs.stat("/FFS/Ñ„Ð°Ð¹Ð»")?.size, 3);
        assert.equal(ffs.stat("/FFS/файл"), undefined);
        assert.equal(ffs.stat("/FFS/файл.TXT")?.size, 4);
        assert.equal(ffs.stat("/FFS/ФАЙЛ.txt"), undefined);
    });

    it("throws what it cannot open", () => {
        assert.throws(() => FFS.open(new Uint8Array(0x100000)), { name: "FFSError", message: "The fullflash is of an unknown platform" });
        assert.throws(() => FFS.open(new Uint8Array(0x100000), { platform: "SGOLD" }), { name: "FFSError", message: "No filesystem partitions found" });
        assert.throws(() => FFS.open(new Uint8Array(0)), { name: "FFSError", message: "The fullflash is empty" });
        assert.throws(() => open({ platform: "NOPE" }), { name: "FFSError", message: "Unknown platform NOPE" });
    });

    it("collects the warnings, or in strict mode throws them", () => {
        const image = SCENARIOS["egold broken"]();
        const ffs   = FFS.open(image);

        assert.deepEqual(ffs.warnings, ["FFS: two records with id 6010", "/FFS: record 6018 is missing", "/FFS/broken part.bin: its part 36583 is missing"]);
        assert.deepEqual(ffs.readDir("/FFS").map((entry) => entry.name), ["fine.bin", "missing header"]);
        assert.throws(() => FFS.open(image, { strict: true }), { name: "FFSError", message: "FFS: two records with id 6010" });
    });

    it("logs to the logger it is given", () => {
        const messages: string[] = [];

        FFS.open(SCENARIOS["sgold broken"](), { logger: { debug: (msg) => messages.push(`D ${msg}`), warn: (msg) => messages.push(`W ${msg}`) } });

        assert.ok(messages.some((msg) => msg.startsWith("D ")));
        assert.ok(messages.includes("W FFS: two records with id 10"));
    });

    it("takes Buffers, and leaves them alone", () => {
        const image = Buffer.from(sgoldImage(FILES));
        const copy  = Buffer.from(image);
        const ffs   = FFS.open(image);

        ffs.writeFile("/FFS/b.bin", pattern(10000, 9));

        assert.ok(image.equals(copy));
        assert.ok(!equalBytes(ffs.save(), copy));
    });

    describe("writes", () => {
        it("files and directories, which it shows at once", () => {
            const ffs = open();

            ffs.mkdir("/ffs/misc/New", new Date(2020, 1, 2, 3, 4, 6));
            ffs.writeFile("/ffs/misc/new/a.txt", pattern(2500, 7), new Date(2021, 1, 2, 3, 4, 6));
            ffs.writeFile("/FFS/Ärger", pattern(1, 8));

            assert.deepEqual(ffs.readDir("/FFS/Misc/New").map((entry) => [entry.path, entry.size, entry.timestamp]), [["/FFS/Misc/New/a.txt", 2500, new Date(2021, 1, 2, 3, 4, 6)]]);
            assert.ok(equalBytes(ffs.readFile("/ffs/misc/new/A.TXT"), pattern(2500, 7)));
            assert.equal(ffs.stat("/FFS/Ärger")?.size, 1);
        });

        it("into a fullflash it saves", () => {
            const ffs = open();

            ffs.writeFile("/FFS/b.bin", pattern(10000, 9));
            ffs.remove("/FFS/empty.txt");
            ffs.remove("/FFS/Misc/Photo.JPG");
            ffs.remove("/FFS/Misc");

            const reopened = FFS.open(ffs.save());

            assert.deepEqual(reopened.readDir("/FFS").map((entry) => entry.name), ["Ärger", "ôàéë", "b.bin"]);
            assert.ok(equalBytes(reopened.readFile("/FFS/B.BIN"), pattern(10000, 9)));
        });

        it("replaces a file whichever way its name is kept", () => {
            // "Ärger" as 0x1F and UTF-8, which the phones list, but do not find by that name
            const ffs = FFS.open(sgoldImage([{ name: Uint8Array.of(0x1F, 0xC3, 0x84, 0x72, 0x67, 0x65, 0x72), data: pattern(5, 1) }]));

            ffs.writeFile("/FFS/Ärger", pattern(7, 2));

            assert.deepEqual(ffs.readDir("/FFS").map((entry) => [entry.name, entry.size]), [["Ärger", 7]]);
            // In CP1252 now, as they would find it
            assert.ok(Buffer.from(ffs.save()).includes(Buffer.of(0xC4, 0x72, 0x67, 0x65, 0x72, 0x00)));
        });

        it("throws what it cannot do, and changes nothing then", () => {
            const ffs = open();

            assert.throws(() => ffs.remove("/FFS/Misc"), { name: "FFSError", message: "/FFS/Misc: directory not empty" });
            assert.throws(() => ffs.writeFile("/FFS/nope/a/b", pattern(1, 1)), { name: "FFSError", message: "/FFS/nope: no such directory" });
            assert.throws(() => ffs.writeFile("/FFS/empty.txt/a", pattern(1, 1)), { name: "FFSError", message: "/FFS/empty.txt: not a directory" });
            assert.throws(() => ffs.writeFile("/NOPE/a", pattern(1, 1)), { name: "FFSError", message: "/NOPE/a: no such partition" });
            assert.throws(() => ffs.writeFile("/FFS/Misc", pattern(1, 1)), { name: "FFSError", message: "/FFS/Misc: is a directory" });
            assert.throws(() => ffs.writeFile("/FFS/a:b", pattern(1, 1)), { name: "FFSError", message: "Invalid name 'a:b': no control characters and none of \\/:*?\"<>|" });
            assert.throws(() => ffs.writeFile("/FFS/a", pattern(1, 1), NaN), { name: "FFSError", message: "Invalid timestamp: NaN" });
            assert.throws(() => ffs.writeFile("/FFS/big", pattern(8 * 0x10000, 1)), { name: "FFSError", message: "Not enough free space in FFS" });
            assert.throws(() => ffs.mkdir("/ffs"), { name: "FFSError", message: "/FFS: is a partition's root directory" });
            assert.throws(() => ffs.mkdir("/FFS/misc"), { name: "FFSError", message: "/FFS/misc: exists already" });
            assert.throws(() => ffs.remove("/FFS/nope"), { name: "FFSError", message: "/FFS/nope: no such file or directory" });

            assert.ok(equalBytes(ffs.save(), sgoldImage(FILES)));
        });

        it("not to EGOLD, unless asked to", () => {
            const ffs = FFS.open(SCENARIOS.egold());

            assert.throws(() => ffs.writeFile("/FFS/a", pattern(1, 1)), { name: "FFSError", message: "FFS: writes to EGOLD are experimental, and made with experimentalEgoldWrites only" });

            const asked = FFS.open(SCENARIOS.egold(), { experimentalEgoldWrites: true });

            asked.writeFile("/FFS/a", pattern(1, 1));

            assert.ok(equalBytes(FFS.open(asked.save()).readFile("/FFS/a"), pattern(1, 1)));
            // No longer than the phones' own
            assert.throws(() => asked.writeFile(`/FFS/${"x".repeat(63)}`, pattern(1, 1)), { name: "FFSError", message: "Names are up to 62 bytes long" });
        });

        it("not to EGOLD without Card-Explorer", () => {
            const ffs = FFS.open(SCENARIOS["egold without card-explorer"](), { experimentalEgoldWrites: true });

            assert.throws(() => ffs.writeFile("/FFS/a", pattern(1, 1)), { name: "FFSError", message: "FFS: writes to EGOLD without Card-Explorer are not supported" });
            assert.throws(() => ffs.remove("/FFS/one.bin"), { name: "FFSError", message: "FFS: writes to EGOLD without Card-Explorer are not supported" });

            const fat = FFS.open(SCENARIOS["egold lba_fs"]());

            assert.throws(() => fat.mkdir("/LBA_FS/a"), { name: "FFSError", message: "LBA_FS: writes to EGOLD without Card-Explorer are not supported" });
        });

        it("not to a prototype's filesystem", () => {
            const ffs = FFS.open(SCENARIOS["sgold prototype"]());

            assert.throws(() => ffs.mkdir("/FFS/a"), { name: "FFSError", message: "FFS: a prototype's filesystem is read only" });
        });

        it("not to a broken partition", () => {
            const ffs = FFS.open(SCENARIOS["sgold broken"]());

            assert.throws(() => ffs.mkdir("/FFS/a"), FFSError);
        });
    });
});

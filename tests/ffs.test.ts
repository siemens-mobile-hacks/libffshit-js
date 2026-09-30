import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FFS, FFSError } from "../src/index.js";
import { equalBytes, pattern } from "./helpers/data.js";
import { SCENARIOS } from "./helpers/scenarios.js";
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

    it("reads SGOLD names in the codepage asked for", () => {
        const ffs = open({ codepage: "CP1251" });

        assert.ok(ffs.stat("/FFS/файл"));
        // Ä in CP1252 is Д in CP1251
        assert.ok(ffs.stat("/FFS/Дrger"));
    });

    it("throws what it cannot open", () => {
        assert.throws(() => FFS.open(new Uint8Array(0x100000)), { name: "FFSError", message: "The fullflash is of an unknown platform" });
        assert.throws(() => FFS.open(new Uint8Array(0x100000), { platform: "SGOLD" }), { name: "FFSError", message: "No filesystem partitions found" });
        assert.throws(() => FFS.open(new Uint8Array(0)), { name: "FFSError", message: "The fullflash is empty" });
        assert.throws(() => open({ codepage: "NOPE" }), { name: "FFSError", message: "Unknown codepage NOPE" });
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
            // "Ärger" as 0x1F and UTF-8, which the codepage could have kept
            const ffs = FFS.open(sgoldImage([{ name: "Ärger", data: pattern(5, 1) }]));

            ffs.writeFile("/FFS/Ärger", pattern(7, 2));

            assert.deepEqual(ffs.readDir("/FFS").map((entry) => [entry.name, entry.size]), [["Ärger", 7]]);
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

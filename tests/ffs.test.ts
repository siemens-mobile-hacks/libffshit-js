// FFS, the API of the WebAssembly build: what it answers, what it throws, and the writes it adds.
// tests/compat/wasm.test.ts compares it with the WebAssembly build itself.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FFS, Logger, type LogInterface } from "../src/index.js";
import { egoldDirectory, egoldImage, fatTime, filesystemRecords, formattedImage, RecordsBuilder, type FsFile } from "./helpers/synthetic.js";
import { pattern } from "./helpers/write.js";

function sgoldImage(files: FsFile[]): Buffer {
    const layout  = { platform: "SGOLD" as const, size: 0x800000, blockSize: 0x10000, partitions: [{ name: "FFS", blocks: 8 }] };
    const builder = new RecordsBuilder(formattedImage(layout), "SGOLD");

    for (const [id, data] of filesystemRecords("SGOLD", files, { chunkSize: 1024 })) {
        builder.add("FFS", id, data);
    }

    return Buffer.from(builder.image());
}

const FILES: FsFile[] = [
    { name: "Misc", children: [{ name: "Photo.JPG", data: pattern(3000, 1), attributes: 0x01, fat: fatTime(2008, 7, 6, 5, 4, 2) }] },
    { name: "empty.txt", data: new Uint8Array(0), attributes: 0x06 },
    // "Ärger" in CP1252, and "файл" in CP1251
    { name: Uint8Array.of(0xC4, 0x72, 0x67, 0x65, 0x72), data: pattern(5, 2) },
    { name: Uint8Array.of(0xF4, 0xE0, 0xE9, 0xEB), data: pattern(6, 3) },
];

async function opened(image = sgoldImage(FILES), options = {}): Promise<FFS> {
    const ffs = new FFS();

    await ffs.open(image, options);

    return ffs;
}

describe("FFS", () => {
    it("tells the platform, model and IMEI", async () => {
        const ffs = await opened();

        assert.equal(ffs.getPlatform(), "SGOLD");
        assert.equal(ffs.getModel(), "SYN");
        assert.equal(ffs.getIMEI(), "490154203237518");
        assert.deepEqual(ffs.getWarnings(), []);
    });

    it("lists directories, with paths and names as the fullflash has them", async () => {
        const ffs = await opened();

        assert.deepEqual(ffs.readDir("/").map((entry) => [entry.path, entry.name, entry.isDirectory]), [["/", "FFS", true]]);
        assert.deepEqual(ffs.readDir("/ffs").map((entry) => [entry.path, entry.name]), [["/FFS", "Misc"], ["/FFS", "empty.txt"], ["/FFS", "Ärger"], ["/FFS", "ôàéë"]]);

        const [photo] = ffs.readDir("/FFS/MISC/");

        assert.deepEqual(photo, {
            name: "Photo.JPG",
            path: "/FFS/Misc",
            size: 3000,
            timestamp: new Date(2008, 6, 6, 5, 4, 2).getTime(),
            isFile: true,
            isDirectory: false,
            isReadonly: true,
            isHidden: false,
            isSystem: false,
        });

        assert.deepEqual(ffs.readDir("/nope"), []);
        assert.deepEqual(ffs.readDir("/FFS/empty.txt"), []);
    });

    it("finds files without regard to the case of ASCII letters", async () => {
        const ffs = await opened();

        assert.equal(ffs.stat("/ffs/misc/photo.jpg")?.name, "Photo.JPG");
        // The path as it was asked for
        assert.equal(ffs.stat("/ffs/misc/photo.jpg")?.path, "/ffs/misc");
        assert.equal(ffs.stat("/ffs/misc/./../misc/photo.jpg")?.size, 3000);
        assert.equal(ffs.stat("/FFS/ärger"), undefined);
        assert.equal(ffs.stat("/FFS/Ärger")?.size, 5);
        assert.equal(ffs.stat("/FFS/Misc/nope"), undefined);
        assert.equal(ffs.stat("/nope/deeper"), undefined);
        assert.equal(ffs.isExists("/FFS/EMPTY.TXT"), true);
        assert.equal(ffs.stat("/")?.name, "");
    });

    it("reads files", async () => {
        const ffs = await opened();

        assert.ok(ffs.readFile("/FFS/Misc/Photo.JPG")?.equals(Buffer.from(pattern(3000, 1))));
        assert.equal(ffs.readFile("/FFS/empty.txt")?.length, 0);
        assert.equal(ffs.readFile("/FFS/Misc"), undefined);
        assert.equal(ffs.readFile("/FFS/nope"), undefined);
    });

    it("gives the whole tree", async () => {
        const ffs  = await opened();
        const tree = ffs.getFilesTree();

        assert.equal(tree.children?.[0].name, "FFS");
        assert.deepEqual(tree.children?.[0].children?.[0].children?.map((entry) => [entry.name, entry.children]), [["Photo.JPG", []]]);
    });

    it("reads SGOLD names in the codepage asked for", async () => {
        const ffs = await opened(sgoldImage(FILES), { codepage: "CP1251" });

        assert.ok(ffs.stat("/FFS/файл"));
        // Ä in CP1252 is Д in CP1251
        assert.ok(ffs.stat("/FFS/Дrger"));
    });

    it("takes absolute paths only", async () => {
        const ffs = await opened();

        assert.throws(() => ffs.stat("FFS"), { message: "Path must be absolute" });
        assert.throws(() => ffs.readDir(""), { message: "Path must be absolute" });
    });

    it("throws before it is opened, and once it is closed", async () => {
        const ffs = new FFS();

        assert.throws(() => ffs.getPlatform(), { message: "FFS is not opened" });
        assert.throws(() => ffs.close(), { message: "FFS is not opened" });

        await ffs.open(sgoldImage(FILES));
        ffs.close();

        assert.throws(() => ffs.getPlatform(), { message: "FFS is closed." });
        assert.throws(() => ffs.readDir("/"), { message: "FFS is closed." });
    });

    it("throws what the library throws, named by the C++ exception", async () => {
        const ffs = new FFS();

        await assert.rejects(ffs.open(Buffer.alloc(0x100000)), { message: "[FULLFLASH::Exception] Unknown platform" });
        await assert.rejects(ffs.open(Buffer.alloc(0x100000), { platform: "SGOLD" }), { message: "[FULLFLASH::Partitions::Exception] Partitions not found" });
        await assert.rejects(ffs.open(sgoldImage(FILES), { codepage: "NOPE" }), { message: "[FULLFLASH::Filesystem::Exception] Unknown codepage NOPE" });

        // Closed by a failed open
        assert.throws(() => ffs.getPlatform(), { message: "FFS is closed." });
    });

    it("collects the warnings of opening", async () => {
        const image = egoldImage({
            size: 0x800000,
            blocks: 1,
            files: [
                { id: 6, parentId: 6, name: new Uint8Array(0), attributes: 0x10, fat: 0, data: egoldDirectory([7]) },
                { id: 7, parentId: 6, name: Buffer.from("a"), attributes: 0, fat: 0, data: pattern(10, 1) },
                { id: 7, parentId: 6, name: Buffer.from("b"), attributes: 0, fat: 0, data: pattern(10, 2) },
            ],
        });

        const ffs = await opened(Buffer.from(image));

        assert.deepEqual(ffs.getWarnings(), ["Couldn't detect IMEI", "File id 0007 already exists in map"]);
    });

    it("leaves the logger it found installed", async () => {
        const messages: string[] = [];
        const logger: LogInterface = {
            onInfo: (msg) => messages.push(msg),
            onWarning: (msg) => messages.push(msg),
            onError: (msg) => messages.push(msg),
            onDebug: (msg) => messages.push(msg),
        };

        const image = sgoldImage(FILES);

        Logger.init(logger);

        try {
            await opened(image);

            assert.equal(Logger.getInterface(), logger);
            assert.deepEqual(messages, []);
        } finally {
            Logger.init(undefined);
        }
    });

    describe("writes", () => {
        it("files and directories, which it shows at once", async () => {
            const ffs = await opened();

            ffs.mkdir("/ffs/misc/New", new Date(2020, 1, 2, 3, 4, 6));
            ffs.writeFile("/ffs/misc/new/a.txt", pattern(2500, 7), new Date(2021, 1, 2, 3, 4, 6));
            ffs.writeFile("/FFS/Ärger", pattern(1, 8));

            assert.deepEqual(ffs.readDir("/FFS/Misc/New").map((entry) => [entry.name, entry.size, entry.timestamp]), [["a.txt", 2500, new Date(2021, 1, 2, 3, 4, 6).getTime()]]);
            assert.ok(ffs.readFile("/ffs/misc/new/A.TXT")?.equals(Buffer.from(pattern(2500, 7))));
            assert.equal(ffs.stat("/FFS/Ärger")?.size, 1);
        });

        it("into a fullflash it returns, leaving the buffer it was given alone", async () => {
            const image = sgoldImage(FILES);
            const copy  = Buffer.from(image);
            const ffs   = await opened(image);

            ffs.writeFile("/FFS/b.bin", pattern(10000, 9));
            ffs.remove("/FFS/empty.txt");
            ffs.remove("/FFS/Misc/Photo.JPG");
            ffs.remove("/FFS/Misc");

            assert.ok(image.equals(copy));

            const reopened = await opened(ffs.getFullflash());

            assert.deepEqual(reopened.readDir("/FFS").map((entry) => entry.name), ["Ärger", "ôàéë", "b.bin"]);
            assert.ok(reopened.readFile("/FFS/B.BIN")?.equals(Buffer.from(pattern(10000, 9))));
        });

        it("throws what the library throws, and changes nothing then", async () => {
            const ffs = await opened();

            assert.throws(() => ffs.remove("/FFS/Misc"), { message: "Directory Misc is not empty" });
            assert.throws(() => ffs.writeFile("/FFS/nope/a", pattern(1, 1)), { message: "Directory nope not found" });
            assert.throws(() => ffs.writeFile("/NOPE/a", pattern(1, 1)), { message: "'NOPE/a': no such partition" });
            assert.throws(() => ffs.mkdir("/FFS"), { message: "'FFS' is a partition's root directory" });
            assert.throws(() => ffs.writeFile("relative", pattern(1, 1)), { message: "Path must be absolute" });

            assert.ok(ffs.getFullflash().equals(sgoldImage(FILES)));
        });

        it("not to EGOLD", async () => {
            const ffs = await opened(Buffer.from(egoldImage({
                size: 0x800000,
                blocks: 1,
                files: [{ id: 6, parentId: 6, name: new Uint8Array(0), attributes: 0x10, fat: 0, data: egoldDirectory([]) }],
            })));

            assert.throws(() => ffs.writeFile("/FFS/a", pattern(1, 1)), { message: "Writing is not supported on this platform" });
        });
    });
});

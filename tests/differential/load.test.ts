// Loads every fullflash there is with the rewrite and with the C++ library, in every way, and
// compares all that the loads did: the platform, model and IMEI, the partitions and their blocks,
// every file and directory with its content, the messages logged and the errors thrown.

import path from "node:path";
import { describe, it } from "node:test";
import { assertSame } from "../helpers/compare.js";
import { loadJs, loadReference, readFullflash, type LoadOptions } from "../helpers/dump.js";
import { allFullflashes, SKIP_NO_REFERENCE } from "../helpers/env.js";

const OPTIONS: [string, LoadOptions][] = [
    ["defaults", {}],
    ["skipping broken files and duplicates", { skipBroken: true, skipDup: true }],
    ["with the old search algorithm", { oldSearch: true }],
    ["with the old search algorithm, skipping", { oldSearch: true, skipBroken: true, skipDup: true }],
    ["logging verbosely", { skipBroken: true, skipDup: true, verboseProcessing: true, verboseHeaders: true }],
    ["searching from 16 MiB on", { start: 0x1000000, skipBroken: true, skipDup: true }],
    ["in CP1251", { codepage: "CP1251", skipBroken: true, skipDup: true }],
    ["taken for EGOLD_CE", { platform: "EGOLD_CE", skipBroken: true, skipDup: true }],
    ["taken for SGOLD", { platform: "SGOLD", skipBroken: true, skipDup: true }],
    ["taken for SGOLD2", { platform: "SGOLD2", skipBroken: true, skipDup: true }],
    ["taken for SGOLD2_ELKA", { platform: "SGOLD2_ELKA", skipBroken: true, skipDup: true }],
    ["taken for SGOLD2_ELKA, not skipping", { platform: "SGOLD2_ELKA" }],
];

const fullflashes = allFullflashes();

describe("Loading matches the C++ library", { skip: SKIP_NO_REFERENCE || (!fullflashes.length && "no fullflashes: set FFSHIT_TEST_FULLFLASHES") }, () => {
    for (const file of fullflashes) {
        describe(path.basename(file), () => {
            const data = readFullflash(file);

            for (const [name, options] of OPTIONS) {
                it(name, (t) => {
                    const reference = loadReference(file, options);

                    if (!reference.dump) {
                        t.skip(`the C++ library crashed (${reference.run.signal})`);

                        return;
                    }

                    const js = loadJs(data, options);

                    assertSame(js.dump, reference.dump, "The load");
                });
            }

            it("of one partition", (t) => {
                const partition = loadReference(file, { tree: false }).dump?.partitions?.list[0]?.name;

                if (!partition) {
                    t.skip("no partitions");

                    return;
                }

                const options: LoadOptions = { parts: [partition], skipBroken: true, skipDup: true };
                const reference = loadReference(file, options);

                assertSame(loadJs(data, options).dump, reference.dump, "The load");
            });
        });
    }
});

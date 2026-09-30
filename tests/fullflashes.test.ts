// The phones' fullflashes, where there are any: every entry they list is found by its path as it is
// listed, and every file reads as the size it is listed with. The ones of known phones open without
// anything broken. What each holds is reported, to compare runs on collections of them by.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FFS, FFSError, type FFSTreeEntry, type Platform } from "../src/index.js";
import { allFullflashes, NO_FULLFLASHES, readFullflash } from "./helpers/fullflashes.js";

// Their platforms, models and partitions
const KNOWN: Record<string, [Platform, string, string[]]> = {
    "CX70v56lg3.bin":       ["SGOLD", "CX70", ["Data", "Cache", "Config"]],
    "SL65v49lg1_TIM.bin":   ["SGOLD", "SL65", ["Data", "Cache", "Config"]],
    "S75v40lg1.bin":        ["SGOLD2", "S75", ["Data", "Cache", "Config"]],
    "EL71v41lg91.bin":      ["SGOLD2_ELKA", "EL71", ["Data", "Cache", "Config"]],
};

function entries(entry: FFSTreeEntry): FFSTreeEntry[] {
    return (entry.children ?? []).flatMap((child) => [child, ...entries(child)]);
}

const fullflashes = allFullflashes();

describe("The phones' fullflashes", { skip: !fullflashes.length && NO_FULLFLASHES }, () => {
    for (const name of fullflashes) {
        it(name, (t) => {
            const data  = readFullflash(name)!;
            const known = KNOWN[name];
            let   ffs: FFS;

            try {
                ffs = FFS.open(data, { strict: !!known });
            } catch (e) {
                // Of a phone of another platform, or of none
                assert.ok(!known && e instanceof FFSError, String(e));

                t.diagnostic(`not opened: ${e.message}`);

                return;
            }

            const all           = entries(ffs.tree());
            const partitions    = ffs.readDir("/").map((entry) => entry.name);

            t.diagnostic(`${ffs.platform} ${ffs.model}: ${all.length} entries, ${ffs.warnings.length} warnings, in ${partitions.join(", ")}`);

            if (known) {
                assert.deepEqual([ffs.platform, ffs.model, partitions], known);
                assert.ok(all.length > 100);
            }

            for (const entry of all) {
                const { children: _, ...listed } = entry;

                assert.deepEqual(ffs.stat(entry.path), listed, entry.path);

                if (!entry.isDirectory) {
                    assert.equal(ffs.readFile(entry.path).length, entry.size, entry.path);
                }
            }

            // What is not free holds the files at least
            for (const partition of ffs.readDir("/")) {
                const { size, free } = ffs.statfs(partition.path);
                const files = all.filter((entry) => entry.path.startsWith(`${partition.path}/`)).reduce((sum, entry) => sum + entry.size, 0);

                assert.ok(free >= 0 && size - free >= files, `${partition.path}: ${free} of ${size} free, ${files} in files`);
            }
        });
    }
});

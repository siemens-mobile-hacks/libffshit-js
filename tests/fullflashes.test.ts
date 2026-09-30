// The phones' fullflashes, where there are any: every entry they list is found by its path as it is
// listed, and every file reads as the size it is listed with. The ones of known phones open without
// anything broken. What each holds is reported, to compare runs on collections of them by.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FFS, FFSError, type FFSTreeEntry, type Platform } from "../src/index.js";
import { allFullflashes, NO_FULLFLASHES, readFullflash } from "./helpers/fullflashes.js";

const KNOWN: Record<string, [Platform, string]> = {
    "CX70v56lg3.bin":       ["SGOLD", "CX70"],
    "SL65v49lg1_TIM.bin":   ["SGOLD", "SL65"],
    "S75v40lg1.bin":        ["SGOLD2", "S75"],
    "EL71v41lg91.bin":      ["SGOLD2_ELKA", "EL71"],
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

            const all = entries(ffs.tree());

            t.diagnostic(`${ffs.platform} ${ffs.model}: ${all.length} entries, ${ffs.warnings.length} warnings`);

            if (known) {
                assert.deepEqual([ffs.platform, ffs.model], known);
                assert.ok(all.length > 100);
            }

            for (const entry of all) {
                const { children: _, ...listed } = entry;

                assert.deepEqual(ffs.stat(entry.path), listed, entry.path);

                if (!entry.isDirectory) {
                    assert.equal(ffs.readFile(entry.path).length, entry.size, entry.path);
                }
            }
        });
    }
});

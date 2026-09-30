// The phones' fullflashes, where there are any: they open without anything broken, and every file
// they list reads as the size they list it with

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

function files(entry: FFSTreeEntry): FFSTreeEntry[] {
    return (entry.children ?? []).flatMap((child) => child.isDirectory ? files(child) : [child]);
}

const fullflashes = allFullflashes();

describe("The phones' fullflashes", { skip: !fullflashes.length && NO_FULLFLASHES }, () => {
    for (const name of fullflashes) {
        it(name, () => {
            const data = readFullflash(name)!;

            if (!KNOWN[name]) {
                // Of a phone of another platform, or of none
                try {
                    FFS.open(data);
                } catch (e) {
                    assert.ok(e instanceof FFSError, String(e));
                }

                return;
            }

            const ffs = FFS.open(data, { strict: true });

            assert.deepEqual([ffs.platform, ffs.model], KNOWN[name]);

            const all = files(ffs.tree());

            assert.ok(all.length > 100);

            for (const file of all) {
                assert.equal(ffs.readFile(file.path).length, file.size, file.path);
            }
        });
    }
});

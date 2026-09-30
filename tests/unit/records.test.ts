// The ids the library hands out: none of those the firmware's own records 1 to 5 mention

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concat, le16, le32 } from "../../src/bytes.js";
import { Records } from "../../src/filesystem/records.js";
import { Image } from "../../src/image.js";
import { SGOLD_LAYOUT, SGOLD2_LAYOUT } from "../helpers/scenarios.js";
import { layoutBlocks, RecordsBuilder, type ImageLayout } from "../helpers/synthetic.js";

function records(layout: ImageLayout, partition: string, added: [number, Uint8Array][]): Records {
    const builder = new RecordsBuilder(layout);

    for (const [id, data] of added) {
        builder.add(partition, id, data);
    }

    return Records.open(layout.platform, new Image(builder.build()), { name: partition, blocks: layoutBlocks(layout, partition) }, 0);
}

describe("Records", () => {
    it("hand out no id the firmware's own records mention", () => {
        // 10, 13 and 14 mentioned, and 16 taken
        const sgold = records(SGOLD_LAYOUT, "FFS", [[1, concat([le16(10), le16(13), le16(14)])], [16, new Uint8Array(4)]]);

        assert.equal(sgold.allocatePair(10), 18);

        // 12 and 15 as the S75 and EL71 mention them, in 32 bits
        const sgold2 = records(SGOLD2_LAYOUT, "FFS_0", [[4, concat([le32(12), le32(15)])]]);

        assert.equal(sgold2.allocatePair(12), 16);
    });
});

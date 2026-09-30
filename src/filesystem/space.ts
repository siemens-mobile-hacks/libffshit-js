// How the phones' firmware reckons a partition's capacity and free space, which it tells over OBEX,
// as found in the S75's, EL71's and CX70's firmware and told by them in pmb887x-emu.
//
// At mount: the partition's blocks but one, less 32 bytes of each, and less a reserve, of 4 % of
// that or a piece for every block and two more, whichever is more, but no more than a block when
// those pieces fit in one, and of a file of the largest record. What is left, less the parts and
// FIT entries its pieces would take, is the capacity. The free space is the room the blocks but one
// leave for records, less what the valid records take up of it, the reserve, and then the same.

import type { Space } from "./volume.js";

export interface SpaceConstants {
    largestRecord: number;
    partSize: number;
    // Taken off both the reserve and the free space besides
    tail: number;
}

export const SGOLD_SPACE: SpaceConstants       = { largestRecord: 0xFFFE, partSize: 16, tail: 0 };
export const NEW_SGOLD_SPACE: SpaceConstants   = { largestRecord: 0x1FFFC, partSize: 12, tail: 0x134 };

// Of the blocks, all as large as the first: the room each leaves for records, and what the valid
// records take up, their FIT entries included
export interface Usage {
    blocks: number;
    blockSize: number;
    room: number;
    used: number;
}

const FIT_ENTRY_SIZE = 16;

export function firmwareSpace(constants: SpaceConstants, usage: Usage, pieceSize: number): Space {
    const { blocks, blockSize, room, used } = usage;
    const { largestRecord, partSize, tail } = constants;

    const usable    = (blockSize - 32) * (blocks - 1);
    const share     = Math.floor(usable * 4 / 100);
    const pieces    = pieceSize * (blocks + 2);
    let   reserve   = pieces > blockSize || share < pieces ? Math.max(pieces, share) : Math.min(share, blockSize);

    reserve += (Math.floor(largestRecord / pieceSize) + 2) * (pieceSize + partSize) + tail;

    // A piece's part, and the FIT entries of the part and of the piece
    const unit      = partSize + 2 * FIT_ENTRY_SIZE;
    const lessParts = (bytes: number) => bytes - (Math.floor(bytes / (pieceSize + unit)) + 1) * unit;
    const left      = room * (blocks - 1) - used;

    return {
        size: Math.max(lessParts(usable - reserve), 0),
        free: left < reserve ? 0 : Math.max(lessParts(left - reserve) - tail, 0),
    };
}

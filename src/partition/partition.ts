import type { Block } from "./block.js";

export class Partition {
    private readonly name: string;
    private readonly blocks: Block[] = [];

    constructor(name: string) {
        this.name = name;
    }

    addBlock(block: Block): void {
        this.blocks.push(block);
    }

    getName(): string {
        return this.name;
    }

    getBlocks(): readonly Block[] {
        return this.blocks;
    }
}

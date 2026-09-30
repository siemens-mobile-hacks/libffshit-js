// Content that tells a shifted or truncated copy from the original
export function pattern(size: number, seed: number): Uint8Array {
    const data = new Uint8Array(size);

    for (let i = 0; i < size; ++i) {
        data[i] = (i * 31 + (i >>> 8) + (seed & 0xFF) * 7) & 0xFF;
    }

    return data;
}

// A small deterministic PRNG, so that a failing sequence can be run again
export function random(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6D2B79F5) >>> 0;

        let t = state;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    return Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));
}

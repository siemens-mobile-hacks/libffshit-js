import assert from "node:assert/strict";

function show(value: unknown): string {
    const text = JSON.stringify(value);

    return text === undefined ? "undefined" : text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

// Where two values first differ, e.g. `tree.d[3].f[10].h: 123 != 456`
export function firstDifference(actual: unknown, expected: unknown, path = ""): string | undefined {
    if (Object.is(actual, expected)) {
        return undefined;
    }

    if (Array.isArray(actual) && Array.isArray(expected)) {
        for (let i = 0; i < Math.max(actual.length, expected.length); ++i) {
            const difference = firstDifference(actual[i], expected[i], `${path}[${i}]`);

            if (difference) {
                return difference;
            }
        }

        return undefined;
    }

    if (actual && expected && typeof actual === "object" && typeof expected === "object") {
        const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);

        for (const key of keys) {
            const difference = firstDifference((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], path ? `${path}.${key}` : key);

            if (difference) {
                return difference;
            }
        }

        return undefined;
    }

    return `${path}: ${show(actual)} (rewrite) != ${show(expected)} (C++)`;
}

export function assertSame(actual: unknown, expected: unknown, what: string): void {
    const difference = firstDifference(actual, expected);

    assert.ok(difference === undefined, `${what} differs from the C++ library at ${difference}`);
}

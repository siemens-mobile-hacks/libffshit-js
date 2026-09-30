// Numbers as the C++ library prints them. A negative number stands for a size_t that wrapped
// around, which prints as the 64-bit unsigned value.

const UINT64 = 1n << 64n;

function unsigned(value: number | bigint): string | bigint {
    if (typeof value === "number" && value >= 0) {
        return String(value);
    }

    const big = BigInt(value);

    return big < 0n ? big + UINT64 : big;
}

// {:0<width>X}
export function hex(value: number | bigint, width = 0): string {
    const number = typeof value === "number" && value >= 0 ? value : unsigned(value);

    return number.toString(16).toUpperCase().padStart(width, "0");
}

// {:0<width>x}
export function hexLower(value: number | bigint, width = 0): string {
    return hex(value, width).toLowerCase();
}

// {}, {:<width>d}, or with fill "0" {:0<width>}
export function dec(value: number | bigint, width = 0, fill = " "): string {
    return unsigned(value).toString().padStart(width, fill);
}

// {:<width>s}
export function left(str: string, width: number): string {
    return str.padEnd(width, " ");
}

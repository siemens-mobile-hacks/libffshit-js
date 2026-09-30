export type PlatformType = "UNK" | "EGOLD_CE" | "SGOLD" | "SGOLD2" | "SGOLD2_ELKA";

// The platforms that have a name: every one but UNK
export const PLATFORM_TYPES: readonly PlatformType[] = ["EGOLD_CE", "SGOLD", "SGOLD2", "SGOLD2_ELKA"];

export function isPlatformType(value: string): value is PlatformType {
    return (PLATFORM_TYPES as readonly string[]).includes(value);
}

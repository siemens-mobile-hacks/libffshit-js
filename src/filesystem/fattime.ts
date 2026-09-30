import { FFSError } from "../errors.js";

// FAT timestamps are in the phone's local time, taken for the local time here, daylight saving time
// included. Out of range fields carry over. Thanks, perk11.
export function fatTimeToDate(fatTime: number): Date {
    const year  = 1980 + (fatTime >>> 25);
    const month = (fatTime >>> 21) & 0x0F;
    const day   = (fatTime >>> 16) & 0x1F;
    const hour  = (fatTime >>> 11) & 0x1F;
    const mins  = (fatTime >>> 5) & 0x3F;
    const secs  = (fatTime & 0x1F) * 2;

    return new Date(year, month - 1, day, hour, mins, secs);
}

// Rounds down to even seconds, and into the years 1980 to 2107
export function dateToFatTime(timestamp: Date | number): number {
    const ms = typeof timestamp === "number" ? timestamp : timestamp.getTime();

    if (!Number.isFinite(ms)) {
        throw new FFSError(`Invalid timestamp: ${String(timestamp)}`);
    }

    const date = new Date(Math.trunc(ms / 1000) * 1000);
    const year = date.getFullYear();

    if (year < 1980) {
        return (1 << 21) | (1 << 16);
    }

    if (year > 2107) {
        return ((127 << 25) | (12 << 21) | (31 << 16) | (23 << 11) | (59 << 5) | 29) >>> 0;
    }

    return (((year - 1980) << 25) |
            ((date.getMonth() + 1) << 21) |
            (date.getDate() << 16) |
            (date.getHours() << 11) |
            (date.getMinutes() << 5) |
            (date.getSeconds() >> 1)) >>> 0;
}

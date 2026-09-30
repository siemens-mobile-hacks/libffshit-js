import { FFSError } from "../errors.js";

// FAT timestamps are in UTC on SGOLD2 and ELKA, which show them in the time zone the phone is set
// to, else in the phone's local time, taken for the local time here, daylight saving time included.
// Out of range fields carry over. Thanks, perk11.
export function fatTimeToDate(fatTime: number, utc: boolean): Date {
    const year  = 1980 + (fatTime >>> 25);
    const month = (fatTime >>> 21) & 0x0F;
    const day   = (fatTime >>> 16) & 0x1F;
    const hour  = (fatTime >>> 11) & 0x1F;
    const mins  = (fatTime >>> 5) & 0x3F;
    const secs  = (fatTime & 0x1F) * 2;

    return utc ? new Date(Date.UTC(year, month - 1, day, hour, mins, secs)) : new Date(year, month - 1, day, hour, mins, secs);
}

// Rounds down to even seconds, and into the years 1980 to 2107
export function dateToFatTime(timestamp: Date | number, utc: boolean): number {
    const ms = typeof timestamp === "number" ? timestamp : timestamp.getTime();

    if (!Number.isFinite(ms)) {
        throw new FFSError(`Invalid timestamp: ${String(timestamp)}`);
    }

    const date = new Date(Math.trunc(ms / 1000) * 1000);
    const year = utc ? date.getUTCFullYear() : date.getFullYear();

    if (year < 1980) {
        return (1 << 21) | (1 << 16);
    }

    if (year > 2107) {
        return ((127 << 25) | (12 << 21) | (31 << 16) | (23 << 11) | (59 << 5) | 29) >>> 0;
    }

    const [month, day, hours, minutes, seconds] = utc ?
        [date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()] :
        [date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];

    return (((year - 1980) << 25) |
            ((month + 1) << 21) |
            (day << 16) |
            (hours << 11) |
            (minutes << 5) |
            (seconds >> 1)) >>> 0;
}

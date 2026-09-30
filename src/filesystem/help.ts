// A point in time as the C++ library keeps it: whole seconds since the epoch, here in milliseconds
export type TimePoint = Date | number;

function timePointToMs(timePoint: TimePoint): number {
    const ms = typeof timePoint === "number" ? timePoint : timePoint.getTime();

    if (!Number.isFinite(ms)) {
        throw new TypeError(`Invalid timestamp: ${String(timePoint)}`);
    }

    return ms;
}

// A FAT timestamp in the phone's local time, which is the local time here, daylight saving time
// included. Out of range fields carry over as mktime() carries them. Thanks, perk11.
export function fatTimestampToUnix(fatTime: number): Date {
    const year   = 1980 + (fatTime >>> 25);
    const month  = (fatTime >>> 21) & 0x0F;
    const day    = (fatTime >>> 16) & 0x1F;
    const hour   = (fatTime >>> 11) & 0x1F;
    const mins   = (fatTime >>> 5) & 0x3F;
    const secs   = (fatTime & 0x1F) * 2;

    return new Date(year, month - 1, day, hour, mins, secs);
}

// Rounds down to even seconds, and into the years 1980 to 2107
export function unixToFatTimestamp(timePoint: TimePoint): number {
    // std::chrono::system_clock::to_time_t() truncates toward zero
    const date = new Date(Math.trunc(timePointToMs(timePoint) / 1000) * 1000);
    const year = date.getFullYear();

    // What the format holds
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

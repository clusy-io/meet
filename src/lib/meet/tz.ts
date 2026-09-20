/**
 * clusy/meet — dependency-free IANA timezone math.
 *
 * Built on Intl.DateTimeFormat (available in Node and every evergreen
 * browser) instead of a date library: the module needs exactly two
 * operations — wall time in a zone -> UTC instant, and the reverse —
 * and keeping it dependency-free keeps the package trivially portable.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  /** ISO weekday, 1=Mon .. 7=Sun. */
  weekday: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDtf(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    // hourCycle h23 so midnight is "00", never "24".
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

const WEEKDAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Wall-clock time in `timeZone` at the UTC instant `utcMs`. */
export function utcToWall(timeZone: string, utcMs: number): WallTime {
  const parts = getDtf(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** Zone offset at `utcMs`, in ms, such that wall = utc + offset. */
export function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const w = utcToWall(timeZone, utcMs);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  // Truncate utcMs to the minute to match the formatted precision.
  const truncated = Math.floor(utcMs / 60000) * 60000;
  return asUtc - truncated;
}

/**
 * UTC instant for a wall-clock time in `timeZone`.
 *
 * Two-pass offset resolution: correct everywhere except inside DST
 * transitions, where it picks a deterministic side. (US transitions happen
 * at 01:00-03:00 local; the booking window is 08:30-22:00, so no bookable
 * slot ever falls inside one.)
 */
export function wallToUtcMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset1 = zoneOffsetMs(timeZone, guess);
  const candidate = guess - offset1;
  const offset2 = zoneOffsetMs(timeZone, candidate);
  return guess - offset2;
}

/** Days since an arbitrary epoch for a (year, month, day) civil date. */
export function civilDayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** Civil date `days` after (year, month, day). */
export function addCivilDays(
  year: number,
  month: number,
  day: number,
  days: number
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** "YYYY-MM-DD" for a civil date. */
export function formatCivilDate(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** Parse "YYYY-MM-DD"; returns null on malformed input. */
export function parseCivilDate(
  value: string
): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** Minutes in one civil day. */
export const MINUTES_PER_DAY = 1440;

/**
 * Minutes from midnight to a clock string: 510 -> "8:30", 1320 -> "22:00".
 * Shared by the admin routes that render the booking window.
 *
 * Minutes past 24:00 keep counting up (1560 -> "26:00"), which is what the
 * timeline labels want. Use `windowMinutesToClock` for anything a person
 * reads as a wall clock.
 */
export function minutesToClock(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * A booking-window bound as a zero-padded wall clock, wrapping past midnight:
 * 510 -> "08:30", 1320 -> "22:00", 1560 (02:00 the next day) -> "02:00",
 * 1440 -> "00:00".
 *
 * Zero-padded because this is the value an `<input type="time">` is given,
 * and that element silently rejects "8:30".
 */
export function windowMinutesToClock(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

/** "8:30" / "08:30" -> 510. Null for anything malformed or out of range. */
export function parseClockToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}

/**
 * Put a booking window into the canonical form the rest of meet works in:
 * minutes from midnight on the day the window OPENS, with the close allowed
 * to run past 1440 into the next civil day.
 *
 * A closing time at or before the opening time is read as "the next day", so
 * 08:00 to 02:00 becomes 480..1560 and a bare 08:00 to 08:00 is a full 24
 * hours. Keeping `start < end` in a single number line is what lets every
 * span calculation downstream (`end - start`, the candidate loop, the
 * meeting-length fit) stay the plain subtraction it already was.
 *
 * Returns null when the pair cannot be a window: a close more than 24 hours
 * after the open, or bounds outside a day. Callers decide whether that is a
 * 400 or a fall back to the inherited window.
 */
export function normalizeBookingWindow(
  startMin: number,
  endMin: number
): { startMin: number; endMin: number } | null {
  if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) return null;
  if (startMin < 0 || startMin >= MINUTES_PER_DAY) return null;
  if (endMin < 0 || endMin > MINUTES_PER_DAY * 2) return null;
  const end = endMin <= startMin ? endMin + MINUTES_PER_DAY : endMin;
  if (end - startMin > MINUTES_PER_DAY) return null;
  return { startMin, endMin: end };
}

/** True when a normalized window runs past midnight into the next civil day. */
export function windowCrossesMidnight(endMin: number): boolean {
  return endMin > MINUTES_PER_DAY;
}

/** True when `value` names an IANA timezone supported by this runtime. */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

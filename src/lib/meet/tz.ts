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
  return { year, month, day };
}

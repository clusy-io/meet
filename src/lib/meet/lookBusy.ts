import "server-only";

import { createHmac } from "crypto";
import { LOOK_BUSY_LEVEL_INFO, type LookBusyLevel } from "./lookBusyLevels";
import { formatCivilDate, utcToWall } from "./tz";

/** A page's private draw for an actual start. The team page and its chat
 * share one page key. Refreshing or loading a different week never rerolls it.
 */
export function lookBusyKey(pageKey: string, secret: string | null) {
  const key = createHmac("sha256", "meet-look-busy-v1").update(secret ?? "").digest();
  return (startMs: number) => {
    const digest = createHmac("sha256", key).update(`${pageKey}\nslot\n${startMs}`).digest();
    return (digest.readUIntBE(0, 6) + 1) / 2 ** 48;
  };
}

export interface LookBusyInput {
  /** Page's scheduled starts, independent of bookings and minimum notice. */
  grid: Iterable<number>;
  /** Scheduled starts that real calendars, bookings and quorum leave open. */
  open: ReadonlySet<number>;
  zone: string;
  key: ReturnType<typeof lookBusyKey>;
  level: LookBusyLevel;
  bookableFromMs: number;
}

/** Choose a weighted random sample of actual openings in each host-local day.
 * Only the public display is filtered. Booking and rescheduling check the
 * host's real availability.
 */
export function lookBusyHiddenStarts({ grid, open, zone, key, level, bookableFromMs }: LookBusyInput): Set<number> {
  const days = new Map<string, Array<{ startMs: number; minute: number }>>();
  for (const startMs of [...new Set(grid)].sort((a, b) => a - b)) {
    const { year, month, day, hour, minute } = utcToWall(zone, startMs);
    const date = formatCivilDate(year, month, day);
    let slots = days.get(date);
    if (!slots) {
      slots = [];
      days.set(date, slots);
    }
    slots.push({ startMs, minute: hour * 60 + minute });
  }

  const hidden = new Set<number>();
  const limit = LOOK_BUSY_LEVEL_INFO[level].dailyLimit;
  for (const day of days.values()) {
    const bookable = day.filter(({ startMs }) => open.has(startMs) && startMs >= bookableFromMs);
    if (bookable.length <= limit) continue;

    const first = day[0].startMs;
    const last = day[day.length - 1].startMs;
    const ranked = bookable.map(({ startMs, minute }) => {
      const morning = minute >= 9 * 60 + 30 && minute <= 10 * 60 + 30;
      const afternoon = minute >= 14 * 60 && minute <= 15 * 60;
      const edge = startMs === first || startMs === last;
      const weight = morning || afternoon ? 1.5 : edge ? 1.25 : 1;
      // An exponential race picks without replacement. Each start's rank
      // stays fixed as other slots expire or get booked, so only the missing
      // choices are replaced. The draw lies in (0, 1].
      return { startMs, rank: -Math.log(key(startMs)) / weight };
    });
    ranked.sort((a, b) => a.rank - b.rank || a.startMs - b.startMs);
    for (const { startMs } of ranked.slice(limit)) hidden.add(startMs);
  }
  return hidden;
}

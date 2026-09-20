import type { MeetConfig } from "./config";
import type { BusyInterval } from "./types";
import { overlapsBusy } from "./types";
import {
  addCivilDays,
  civilDayNumber,
  MINUTES_PER_DAY,
  parseCivilDate,
  utcToWall,
  wallToUtcMs,
} from "./tz";

/**
 * clusy/meet — pure slot arithmetic.
 *
 * No I/O here: callers fetch busy intervals, this module turns them into
 * bookable slots. Pure functions keep the DST behavior unit-testable.
 */

export interface SlotCandidate {
  /** UTC epoch ms of the slot start. */
  startMs: number;
  endMs: number;
}

/** All zones that can evaluate a civil day for this config. */
export function transitionZones(config: MeetConfig): string[] {
  const zones = [config.hostTimezone];
  if (config.timezoneUntil?.timezone && !zones.includes(config.timezoneUntil.timezone)) {
    zones.push(config.timezoneUntil.timezone);
  }
  return zones;
}

/**
 * Minutes this config's window runs past midnight, 0 when it closes on the
 * day it opened. An 08:00-02:00 window overhangs by 120.
 *
 * Slots belong to the civil day their window OPENED on, so the overhang is
 * how far past a civil-day boundary a day's slots can still reach. Every
 * boundary downstream (the horizon edge, the busy-data fetch window, the
 * range a set of candidates has to cover) has to be widened by it.
 */
export function overnightOverhangMin(config: MeetConfig): number {
  return Math.max(0, config.windowEndMin - MINUTES_PER_DAY);
}

/** Zone whose working hours govern this civil date. */
export function zoneForCivilDay(
  config: MeetConfig,
  day: { year: number; month: number; day: number }
): string {
  const handover = config.timezoneUntil;
  if (!handover) return config.hostTimezone;
  const before = parseCivilDate(handover.beforeDate);
  if (!before) return config.hostTimezone;
  return civilDayNumber(day.year, day.month, day.day) <
    civilDayNumber(before.year, before.month, before.day)
    ? handover.timezone
    : config.hostTimezone;
}

/**
 * All candidate slot starts between two host-tz civil dates (inclusive),
 * honoring the weekday filter and the bookable window. Weekday and window
 * are evaluated in the HOST zone: a Friday 9pm SF slot is Saturday in
 * Europe and still bookable, which is the intended semantics.
 *
 * A window that closes past midnight (windowEndMin > 1440) keeps producing
 * slots into the following civil day, and they belong to the day the window
 * opened: a Friday 08:00-02:00 window is bookable at Saturday 01:00 even
 * when Saturday itself is not a bookable weekday. The hour handed to
 * `wallToUtcMs` is allowed to exceed 23 for exactly that reason — Date.UTC
 * rolls it into the next day, and the zone offset is then resolved at the
 * real instant.
 */
export function candidateSlots(
  config: MeetConfig,
  from: { year: number; month: number; day: number },
  days: number
): SlotCandidate[] {
  const out: SlotCandidate[] = [];
  const durMs = config.durationMinutes * 60_000;
  for (let i = 0; i < days; i++) {
    const d = addCivilDays(from.year, from.month, from.day, i);
    const zone = zoneForCivilDay(config, d);
    // Weekday of this civil date, derived in the host zone via noon UTC of
    // the date (noon avoids any midnight-offset ambiguity).
    const noonUtc = wallToUtcMs(zone, d.year, d.month, d.day, 12, 0);
    const weekday = utcToWall(zone, noonUtc).weekday;
    if (!config.bookableWeekdays.includes(weekday)) continue;
    for (
      let min = config.windowStartMin;
      min + config.durationMinutes <= config.windowEndMin;
      min += config.slotStepMinutes
    ) {
      const startMs = wallToUtcMs(
        zone,
        d.year,
        d.month,
        d.day,
        Math.floor(min / 60),
        min % 60
      );
      out.push({ startMs, endMs: startMs + durMs });
    }
  }
  return out;
}

/**
 * True when an instant is one of this config's candidate slot starts.
 *
 * Generates the day BEFORE the instant's civil date as well, because an
 * overnight window puts a 01:00 slot on the grid of the previous day. Only
 * checking the instant's own date rejected every post-midnight slot the
 * booking page had just offered.
 */
export function slotOnGrid(config: MeetConfig, startMs: number): boolean {
  for (const zone of transitionZones(config)) {
    const wall = utcToWall(zone, startMs);
    const from = addCivilDays(wall.year, wall.month, wall.day, -1);
    if (
      candidateSlots(config, from, 2).some((candidate) => candidate.startMs === startMs)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Candidates that can start at or after midnight on `from`, covering `days`
 * civil days of opening dates.
 *
 * With an overnight window the previous day's window is still open after
 * midnight, so its tail has to be generated too and then trimmed back to the
 * requested range. Without the trim a request for next month would answer
 * with slots on the last day of this one.
 */
export function candidateSlotsInRange(
  config: MeetConfig,
  from: { year: number; month: number; day: number },
  days: number
): SlotCandidate[] {
  if (overnightOverhangMin(config) === 0) return candidateSlots(config, from, days);
  const previous = addCivilDays(from.year, from.month, from.day, -1);
  const floorMs = wallToUtcMs(
    zoneForCivilDay(config, from),
    from.year,
    from.month,
    from.day,
    0,
    0
  );
  return candidateSlots(config, previous, days + 1).filter(
    (candidate) => candidate.startMs >= floorMs
  );
}

/**
 * Filter candidates down to bookable slots.
 *
 * @param memberBusy merged busy intervals per member key (every member that
 *   has at least one connected account must appear; members with no
 *   connected accounts are treated as always free only when
 *   `treatUnconnectedAsFree` — the availability service decides).
 * @param nowMs injectable clock for tests.
 * @param quorum how many members must be free; defaults to the config value.
 *   Personal pages pass 1 rather than handing in a mutated config, because
 *   getMeetConfig() returns one memoized object shared by every request on the
 *   lambda and writing to it would change the team page's quorum process-wide.
 */
export function availableSlots(
  config: MeetConfig,
  candidates: SlotCandidate[],
  memberBusy: Map<string, BusyInterval[]>,
  nowMs: number,
  quorum: number = config.quorum,
  /** Optional per-member starts allowed by their own zone/hours/weekdays. */
  memberSlotSets?: Map<string, ReadonlySet<number>>,
  /**
   * How far past the horizon's last civil day a slot may still start, in
   * minutes. Defaults to this config's own overnight overhang; the team page
   * passes the widest overhang across its members, so one member's late
   * window does not get its last night truncated by the team default.
   */
  overhangMin: number = overnightOverhangMin(config)
): Array<{ startMs: number; freeMemberKeys: string[] }> {
  const minStartMs = nowMs + config.minNoticeMinutes * 60_000;
  // Horizon: last bookable civil day in host tz is today + horizonDays.
  let nowWall = utcToWall(config.hostTimezone, nowMs);
  const todayZone = zoneForCivilDay(config, nowWall);
  if (todayZone !== config.hostTimezone) nowWall = utcToWall(todayZone, nowMs);
  const horizonEdge = addCivilDays(
    nowWall.year,
    nowWall.month,
    nowWall.day,
    config.horizonDays + 1
  );
  // The last bookable day's window is still open past its own midnight when
  // the window is overnight, so the edge moves with it.
  const horizonMs =
    wallToUtcMs(
      zoneForCivilDay(config, horizonEdge),
      horizonEdge.year,
      horizonEdge.month,
      horizonEdge.day,
      0,
      0
    ) +
    Math.max(0, overhangMin) * 60_000;

  const out: Array<{ startMs: number; freeMemberKeys: string[] }> = [];
  for (const slot of candidates) {
    if (slot.startMs < minStartMs) continue;
    if (slot.startMs >= horizonMs) continue;
    const free: string[] = [];
    for (const [memberKey, busy] of memberBusy) {
      const allowed = memberSlotSets?.get(memberKey);
      if (
        (allowed === undefined || allowed.has(slot.startMs)) &&
        !overlapsBusy(busy, slot.startMs, slot.endMs)
      ) {
        free.push(memberKey);
      }
    }
    if (free.length >= quorum) {
      out.push({ startMs: slot.startMs, freeMemberKeys: free });
    }
  }
  return out;
}

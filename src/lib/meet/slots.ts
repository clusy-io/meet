import type { MeetConfig } from "./config";
import type { BusyInterval } from "./types";
import { overlapsBusy } from "./types";
import { addCivilDays, utcToWall, wallToUtcMs } from "./tz";

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

/**
 * All candidate slot starts between two host-tz civil dates (inclusive),
 * honoring the weekday filter and the bookable window. Weekday and window
 * are evaluated in the HOST zone: a Friday 9pm SF slot is Saturday in
 * Europe and still bookable, which is the intended semantics.
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
    // Weekday of this civil date, derived in the host zone via noon UTC of
    // the date (noon avoids any midnight-offset ambiguity).
    const noonUtc = wallToUtcMs(config.hostTimezone, d.year, d.month, d.day, 12, 0);
    const weekday = utcToWall(config.hostTimezone, noonUtc).weekday;
    if (!config.bookableWeekdays.includes(weekday)) continue;
    for (
      let min = config.windowStartMin;
      min + config.durationMinutes <= config.windowEndMin;
      min += config.slotStepMinutes
    ) {
      const startMs = wallToUtcMs(
        config.hostTimezone,
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
 * Filter candidates down to bookable slots.
 *
 * @param memberBusy merged busy intervals per member key (every member that
 *   has at least one connected account must appear; members with no
 *   connected accounts are treated as always free only when
 *   `treatUnconnectedAsFree` — the availability service decides).
 * @param nowMs injectable clock for tests.
 */
export function availableSlots(
  config: MeetConfig,
  candidates: SlotCandidate[],
  memberBusy: Map<string, BusyInterval[]>,
  nowMs: number
): Array<{ startMs: number; freeMemberKeys: string[] }> {
  const minStartMs = nowMs + config.minNoticeMinutes * 60_000;
  // Horizon: last bookable civil day in host tz is today + horizonDays.
  const nowWall = utcToWall(config.hostTimezone, nowMs);
  const horizonEdge = addCivilDays(
    nowWall.year,
    nowWall.month,
    nowWall.day,
    config.horizonDays + 1
  );
  const horizonMs = wallToUtcMs(
    config.hostTimezone,
    horizonEdge.year,
    horizonEdge.month,
    horizonEdge.day,
    0,
    0
  );

  const out: Array<{ startMs: number; freeMemberKeys: string[] }> = [];
  for (const slot of candidates) {
    if (slot.startMs < minStartMs) continue;
    if (slot.startMs >= horizonMs) continue;
    const free: string[] = [];
    for (const [memberKey, busy] of memberBusy) {
      if (!overlapsBusy(busy, slot.startMs, slot.endMs)) free.push(memberKey);
    }
    if (free.length >= config.quorum) {
      out.push({ startMs: slot.startMs, freeMemberKeys: free });
    }
  }
  return out;
}

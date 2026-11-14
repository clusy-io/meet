import "server-only";

import { createHmac } from "crypto";
import {
  LOOK_BUSY_MIN_VISIBLE,
  lookBusyShare,
  type LookBusyLevel,
} from "./lookBusyLevels";
import { civilDayNumber, formatCivilDate, utcToWall } from "./tz";

/**
 * meet — "Make my calendar look busy".
 *
 * A page that offers every hour of every day reads as a calendar nobody
 * books. With the switch on, each day is made to look as booked as a busy
 * person's would (lookBusyLevels.ts): real calendar events and bookings count
 * first, and only the shortfall is made up by hiding open times. So every
 * real booking brings a hidden time back, and a day that is already that busy
 * hides nothing.
 *
 * What makes the hidden times pass for a real calendar:
 *
 * - The month has a shape. A day looks busier the closer it is (tomorrow
 *   fuller than three weeks out, the way real calendars fill), and each day
 *   wobbles off the curve by a keyed amount, so no two days look stamped
 *   from one template.
 * - Hidden times are meetings. Each is a phantom call of one, two or three
 *   slots (a 30-minute call, an hour, an hour and a half), and every open
 *   slot it overlaps goes with it.
 * - They land where meetings land. Mid-morning and mid-afternoon fill first;
 *   the first and last times of a day are the least likely to go.
 * - Stable. Every draw is a keyed hash of the page and the slot or day, never
 *   random, so a refresh shows the same page. Within a day nothing moves with
 *   the clock: the day's whole grid decides, the hours already past
 *   included. A booking only ever reveals; a day only ever fills further as
 *   it approaches, like a real one.
 * - Unguessable. The hash is keyed with MEET_TOKEN_SECRET, so reading this
 *   open-source file does not tell a visitor which taken times are real.
 * - Never costly. A day keeps at least LOOK_BUSY_MIN_VISIBLE of the times
 *   it can still be booked at, so the switch thins a day but never closes it.
 *
 * Display only. Booking and rescheduling still accept a hidden time, because
 * the host IS free then; that also keeps a booking from failing when a
 * cancellation hides again the time a visitor had already picked.
 *
 * Server-only (node crypto). The hiding itself is pure: callers hand in the
 * grid and what real calendars leave open.
 */

/** One slot's keyed draws. */
export interface SlotDraw {
  /** Uniform in (0, 1]: where the slot falls in the day's hiding order. */
  u: number;
  /** Uniform in [0, 1): how long a phantom call starting here runs. */
  lengthRoll: number;
}

/** A page's keyed source of every draw the hiding makes. */
export interface LookBusyKey {
  slot(startMs: number): SlotDraw;
  /** Uniform in [0, 1): how far this day wobbles off its level's curve. */
  day(dateKey: string): number;
}

/**
 * The keyed draws for one page. `pageKey` is "" for the team page and the
 * member key for a personal page, so two pages never hide the same pattern,
 * while a page's call and its chat (same key, same grid) agree on which
 * times look taken, as a real calendar would.
 */
export function lookBusyKey(pageKey: string, secret: string | null): LookBusyKey {
  // A key of its own, derived from the token secret rather than shared with
  // encryption and signing. Mock and local runs may have no secret; they get
  // a fixed key, which is fine where nothing is real.
  const key = createHmac("sha256", "meet-look-busy-v1")
    .update(secret ?? "")
    .digest();
  const draw = (label: string) => createHmac("sha256", key).update(`${pageKey}\n${label}`).digest();
  return {
    slot(startMs) {
      const digest = draw(`slot\n${startMs}`);
      return {
        u: (digest.readUIntBE(0, 6) + 1) / 2 ** 48,
        lengthRoll: digest.readUInt16BE(6) / 2 ** 16,
      };
    },
    day(dateKey) {
      return draw(`day\n${dateKey}`).readUIntBE(0, 6) / 2 ** 48;
    },
  };
}

/**
 * How much likelier a start is to be taken, by its local time. Weights the
 * hiding order (an exponential race), so prime hours fill first without ever
 * being certain to.
 */
export function primeHourWeight(minuteOfDay: number, edgeOfDay: boolean): number {
  if (edgeOfDay) return 0.6;
  const morning = minuteOfDay >= 10 * 60 && minuteOfDay < 12 * 60;
  const afternoon = minuteOfDay >= 13 * 60 + 30 && minuteOfDay < 16 * 60 + 30;
  return morning || afternoon ? 1.6 : 1;
}

/** Slots a phantom call runs: half are one, a third two, the rest three. */
export function phantomSlots(lengthRoll: number): number {
  if (lengthRoll < 0.5) return 1;
  if (lengthRoll < 0.85) return 2;
  return 3;
}

export interface LookBusyInput {
  /**
   * Every start on the page's grid inside the horizon, from midnight today:
   * times already past count, so the day's size does not change by the hour.
   */
  grid: Iterable<number>;
  /** The grid starts real calendars and bookings leave open, notice aside. */
  open: ReadonlySet<number>;
  durationMinutes: number;
  slotStepMinutes: number;
  /** The zone whose civil dates make the days. */
  zone: string;
  key: LookBusyKey;
  level: LookBusyLevel;
  /** Dates the days: today is 0 days ahead. */
  nowMs: number;
  /** The earliest start a visitor can book right now (now plus notice). */
  bookableFromMs: number;
  /** Tests: one fixed share for every day instead of the level's curve. */
  share?: number;
}

/** The open starts to leave off the page. */
export function lookBusyHiddenStarts(input: LookBusyInput): Set<number> {
  const hidden = new Set<number>();
  const durationMs = input.durationMinutes * 60_000;
  const stepMs = input.slotStepMinutes * 60_000;
  const nowWall = utcToWall(input.zone, input.nowMs);
  const today = civilDayNumber(nowWall.year, nowWall.month, nowWall.day);

  const days = new Map<string, { number: number; starts: Array<{ startMs: number; minute: number }> }>();
  for (const startMs of new Set(input.grid)) {
    const wall = utcToWall(input.zone, startMs);
    const dateKey = formatCivilDate(wall.year, wall.month, wall.day);
    let day = days.get(dateKey);
    if (!day) {
      day = { number: civilDayNumber(wall.year, wall.month, wall.day), starts: [] };
      days.set(dateKey, day);
    }
    day.starts.push({ startMs, minute: wall.hour * 60 + wall.minute });
  }

  for (const [dateKey, day] of days) {
    const starts = day.starts.sort((a, b) => a.startMs - b.startMs);
    const open = starts.filter((slot) => input.open.has(slot.startMs));
    if (open.length === 0) continue;
    const share =
      input.share ?? lookBusyShare(input.level, day.number - today, input.key.day(dateKey));
    // Real events and bookings already make the day look this busy; only the
    // shortfall is hidden.
    let shortfall = Math.floor(share * starts.length) - (starts.length - open.length);
    if (shortfall <= 0) continue;

    // Weighted hiding order without replacement (an exponential race): each
    // open start draws -ln(u) / weight, and the smallest goes first.
    const first = starts[0].startMs;
    const last = starts[starts.length - 1].startMs;
    const draws = new Map<number, SlotDraw>();
    const race = new Map<number, number>();
    for (const slot of open) {
      const draw = input.key.slot(slot.startMs);
      draws.set(slot.startMs, draw);
      const weight = primeHourWeight(
        slot.minute,
        slot.startMs === first || slot.startMs === last,
      );
      race.set(slot.startMs, -Math.log(draw.u) / weight);
    }
    const place = (startMs: number) => race.get(startMs) ?? Number.POSITIVE_INFINITY;
    const byRace = open.map((slot) => slot.startMs).sort((a, b) => place(a) - place(b) || a - b);

    const dayHidden = new Set<number>();
    for (const start of byRace) {
      if (shortfall <= 0) break;
      if (dayHidden.has(start)) continue;
      // Never longer than the day still needs, so the look is met without
      // hiding a time more than it has to.
      const slots = Math.min(phantomSlots(draws.get(start)?.lengthRoll ?? 0), shortfall);
      const phantomEndMs = start + (slots - 1) * stepMs + durationMs;
      for (const other of open) {
        if (other.startMs >= phantomEndMs) break;
        if (other.startMs + durationMs > start && !dayHidden.has(other.startMs)) {
          dayHidden.add(other.startMs);
          shortfall -= 1;
        }
      }
    }

    // Keep the day bookable. Times given back are the latest in the hiding
    // order: the ones the next bookings would have revealed anyway.
    const bookable = open.filter((slot) => slot.startMs >= input.bookableFromMs);
    const floor = Math.min(LOOK_BUSY_MIN_VISIBLE, bookable.length);
    let visible = bookable.filter((slot) => !dayHidden.has(slot.startMs)).length;
    if (visible < floor) {
      const giveBack = bookable
        .map((slot) => slot.startMs)
        .filter((startMs) => dayHidden.has(startMs))
        .sort((a, b) => place(b) - place(a) || b - a);
      for (const startMs of giveBack) {
        if (visible >= floor) break;
        dayHidden.delete(startMs);
        visible += 1;
      }
    }

    for (const startMs of dayHidden) hidden.add(startMs);
  }
  return hidden;
}

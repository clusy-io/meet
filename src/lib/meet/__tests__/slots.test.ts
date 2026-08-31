import { describe, expect, it } from "vitest";
import type { MeetConfig } from "@/lib/meet/config";
import {
  availableSlots,
  candidateSlots,
  slotOnGrid,
  type SlotCandidate,
} from "@/lib/meet/slots";
import type { BusyInterval } from "@/lib/meet/types";
import { formatCivilDate, utcToWall, wallToUtcMs } from "@/lib/meet/tz";

const LA = "America/Los_Angeles";
const MIN = 60_000;

// Built directly so the tests never touch process.env or the config cache.
const config: MeetConfig = {
  hostTimezone: LA,
  windowStartMin: 510, // 8:30
  windowEndMin: 1320, // 22:00
  bookableWeekdays: [1, 2, 3, 4, 5],
  durationMinutes: 30,
  slotStepMinutes: 30,
  minNoticeMinutes: 240,
  horizonDays: 21,
  members: [
    { key: "ava", name: "Ava", email: "ava@example.com" },
    { key: "ben", name: "Ben", email: "ben@example.com" },
    { key: "cam", name: "Cam", email: "cam@example.com" },
  ],
  quorum: 2,
  eventTitle: "Test <> {name}",
  eventDescription: "Test event",
  brandName: "Test",
  siteOrigin: "https://example.com",
  emailFrom: "Test <meet@example.com>",
  cronSecret: null,
  adminSecret: null,
  tokenSecret: null,
  mockMode: true,
};

/** All three members free everywhere. */
function allFree(): Map<string, BusyInterval[]> {
  return new Map([
    ["ava", []],
    ["ben", []],
    ["cam", []],
  ]);
}

describe("candidateSlots", () => {
  // 2026-08-17 is a Monday; the 7-day span covers Mon..Sun.
  const week = candidateSlots(config, { year: 2026, month: 8, day: 17 }, 7);

  it("yields 5 weekdays x 27 slots for a full Mon-Sun week", () => {
    expect(week).toHaveLength(5 * 27);
    const perDay = new Map<string, number>();
    for (const slot of week) {
      const w = utcToWall(LA, slot.startMs);
      const day = formatCivilDate(w.year, w.month, w.day);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    expect([...perDay.keys()].sort()).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
    ]);
    for (const count of perDay.values()) expect(count).toBe(27);
  });

  it("produces no Saturday or Sunday slots", () => {
    for (const slot of week) {
      const weekday = utcToWall(LA, slot.startMs).weekday;
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(5);
    }
  });

  it("starts each day at 8:30 LA and ends at 21:30 LA", () => {
    const first = utcToWall(LA, week[0].startMs);
    expect([first.hour, first.minute]).toEqual([8, 30]);
    const lastOfDay1 = utcToWall(LA, week[26].startMs);
    expect([lastOfDay1.hour, lastOfDay1.minute]).toEqual([21, 30]);
    const veryLast = utcToWall(LA, week[week.length - 1].startMs);
    expect([veryLast.hour, veryLast.minute]).toEqual([21, 30]);
  });
});

describe("availableSlots", () => {
  // A single Wednesday-morning slot: 2026-08-19 8:30 LA.
  const S = wallToUtcMs(LA, 2026, 8, 19, 8, 30);
  const slot: SlotCandidate = { startMs: S, endMs: S + 30 * MIN };
  // A day out: min notice passes, horizon is nowhere near.
  const dayBefore = S - 24 * 60 * MIN;

  it("keeps a slot when exactly 2 of 3 members are free", () => {
    const busy = allFree();
    busy.set("ava", [{ startMs: S - 10 * MIN, endMs: S + 40 * MIN }]);
    const out = availableSlots(config, [slot], busy, dayBefore);
    expect(out).toHaveLength(1);
    expect(out[0].startMs).toBe(S);
    expect(out[0].freeMemberKeys.sort()).toEqual(["ben", "cam"]);
  });

  it("drops a slot when only 1 of 3 members is free", () => {
    const busy = allFree();
    busy.set("ava", [{ startMs: S - 10 * MIN, endMs: S + 40 * MIN }]);
    busy.set("ben", [{ startMs: S, endMs: S + 30 * MIN }]);
    expect(availableSlots(config, [slot], busy, dayBefore)).toHaveLength(0);
  });

  it("does not count a busy interval ending exactly at slot start", () => {
    const busy = allFree();
    busy.set("ava", [{ startMs: S - 60 * MIN, endMs: S }]);
    const out = availableSlots(config, [slot], busy, dayBefore);
    expect(out).toHaveLength(1);
    expect(out[0].freeMemberKeys).toContain("ava");
  });

  it("does not count a busy interval starting exactly at slot end", () => {
    const busy = allFree();
    busy.set("ava", [{ startMs: S + 30 * MIN, endMs: S + 60 * MIN }]);
    const out = availableSlots(config, [slot], busy, dayBefore);
    expect(out).toHaveLength(1);
    expect(out[0].freeMemberKeys).toContain("ava");
  });

  it("blocks on a 1-minute overlap", () => {
    const busy = allFree();
    busy.set("ava", [{ startMs: S + 29 * MIN, endMs: S + 30 * MIN }]);
    const out = availableSlots(config, [slot], busy, dayBefore);
    expect(out).toHaveLength(1);
    expect(out[0].freeMemberKeys.sort()).toEqual(["ben", "cam"]);
  });

  it("excludes a slot 3h59m away and includes one 4h01m away (min notice 4h)", () => {
    expect(availableSlots(config, [slot], allFree(), S - 239 * MIN)).toHaveLength(0);
    expect(availableSlots(config, [slot], allFree(), S - 241 * MIN)).toHaveLength(1);
  });

  it("excludes a slot on day horizon+1 and includes one on day horizon", () => {
    // now = Monday 2026-08-17 noon LA; horizon 21 -> last bookable day 2026-09-07.
    const nowMs = wallToUtcMs(LA, 2026, 8, 17, 12, 0);
    const onHorizon = wallToUtcMs(LA, 2026, 9, 7, 8, 30); // Monday
    const pastHorizon = wallToUtcMs(LA, 2026, 9, 8, 8, 30); // Tuesday, day 22
    const candidates: SlotCandidate[] = [
      { startMs: onHorizon, endMs: onHorizon + 30 * MIN },
      { startMs: pastHorizon, endMs: pastHorizon + 30 * MIN },
    ];
    const out = availableSlots(config, candidates, allFree(), nowMs);
    expect(out.map((s) => s.startMs)).toEqual([onHorizon]);
  });

  it("never counts a member absent from the busy map as free", () => {
    // Only Ava is connected; the two absent members do not help reach quorum.
    const busy = new Map<string, BusyInterval[]>([["ava", []]]);
    expect(availableSlots(config, [slot], busy, dayBefore)).toHaveLength(0);
  });
});

describe("timezone handover", () => {
  const handover: MeetConfig = {
    ...config,
    hostTimezone: "Europe/London",
    timezoneUntil: { beforeDate: "2026-08-31", timezone: LA },
  };

  it("uses the old zone before the date and the new zone from that date", () => {
    const [before] = candidateSlots(handover, { year: 2026, month: 8, day: 27 }, 1);
    const [after] = candidateSlots(handover, { year: 2026, month: 8, day: 31 }, 1);
    expect(new Date(before.startMs).toISOString()).toBe("2026-08-27T15:30:00.000Z");
    expect(new Date(after.startMs).toISOString()).toBe("2026-08-31T07:30:00.000Z");
  });

  it("validates grids on both sides without accepting the old grid afterwards", () => {
    expect(slotOnGrid(handover, Date.parse("2026-08-28T04:30:00.000Z"))).toBe(true);
    expect(slotOnGrid(handover, Date.parse("2026-08-31T07:30:00.000Z"))).toBe(true);
    expect(slotOnGrid(handover, Date.parse("2026-09-01T04:30:00.000Z"))).toBe(false);
  });
});

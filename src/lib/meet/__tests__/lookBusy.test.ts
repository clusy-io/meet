import { describe, expect, it } from "vitest";
import {
  lookBusyHiddenStarts,
  lookBusyKey,
  phantomSlots,
  primeHourWeight,
  type LookBusyInput,
  type LookBusyKey,
} from "@/lib/meet/lookBusy";
import {
  LOOK_BUSY_DAY_WOBBLE,
  LOOK_BUSY_LEVEL_INFO,
  LOOK_BUSY_LEVELS,
  lookBusyShare,
  parseLookBusyLevel,
} from "@/lib/meet/lookBusyLevels";

/**
 * "Make my calendar look busy": which open times a page leaves off.
 *
 * The setting promises "hide some open times to keep your calendar looking
 * busy; as meetings are booked, hidden times become available". These tests
 * hold the hiding to that, and to what a visitor would notice if it got it
 * wrong: times that flicker between refreshes, a day closed although the
 * host is free, a month where every day looks stamped from one template.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Monday 2026-08-17, 08:00 UTC; the tests' days are UTC days. */
const NOW = Date.parse("2026-08-17T08:00:00.000Z");
const MONDAY_9 = Date.parse("2026-08-17T09:00:00.000Z");

/** 9:00 to 17:00 every `step` minutes, `day` days from Monday. */
function dayGrid(day = 0, step = 30, count = 16): number[] {
  return Array.from({ length: count }, (_, i) => MONDAY_9 + day * DAY + i * step * MIN);
}

const secretKey = lookBusyKey("ju", "test-secret");

function input(over: Partial<LookBusyInput> & { grid: number[] }): LookBusyInput {
  return {
    open: new Set(over.grid),
    durationMinutes: 30,
    slotStepMinutes: 30,
    zone: "UTC",
    key: secretKey,
    level: "balanced",
    nowMs: NOW,
    bookableFromMs: NOW,
    ...over,
  };
}

/**
 * A key that hides in exactly the order given, whatever the time-of-day
 * weights say (each place outranks the next by more than the weights can
 * reorder), with chosen phantom lengths. Unlisted starts never go first.
 */
function orderedKey(order: number[], slots: Record<number, 1 | 2 | 3> = {}): LookBusyKey {
  const roll = { 1: 0.1, 2: 0.6, 3: 0.9 } as const;
  return {
    slot(startMs) {
      const at = order.indexOf(startMs);
      return {
        u: at === -1 ? 0 : Math.exp(-(3 ** at)),
        lengthRoll: roll[slots[startMs] ?? 1],
      };
    },
    day: () => 0.5,
  };
}

const visible = (grid: number[], open: Set<number>, hidden: Set<number>) =>
  grid.filter((start) => open.has(start) && !hidden.has(start));

describe("how much a day hides", () => {
  it("hides the share less what real meetings already take", () => {
    const grid = dayGrid();
    expect(lookBusyHiddenStarts(input({ grid, share: 0.4 })).size).toBe(6); // floor(6.4)
    const open = new Set(grid.filter((_, i) => ![2, 3, 9, 12].includes(i)));
    const hidden = lookBusyHiddenStarts(input({ grid, open, share: 0.4 }));
    expect(hidden.size).toBe(2);
    for (const start of hidden) expect(open.has(start)).toBe(true);
  });

  it("hides nothing on a day that is already that busy", () => {
    const grid = dayGrid();
    expect(lookBusyHiddenStarts(input({ grid, open: new Set(grid.slice(7)), share: 0.4 })).size).toBe(0);
  });

  it("keeps at least two bookable times on any day", () => {
    const grid = dayGrid();
    // A share of every time would close the day; two stay.
    const hidden = lookBusyHiddenStarts(input({ grid, share: 1 }));
    expect(visible(grid, new Set(grid), hidden)).toHaveLength(2);
  });

  it("keeps a day's only bookable time", () => {
    const grid = dayGrid();
    const open = new Set([grid[5]]);
    expect(lookBusyHiddenStarts(input({ grid, open, share: 1 })).size).toBe(0);
  });

  it("does not count past times toward those two", () => {
    const grid = dayGrid();
    // 15:30: only 15:30, 16:00 and 16:30 can still be booked.
    const hidden = lookBusyHiddenStarts(
      input({ grid, share: 1, bookableFromMs: grid[13], key: orderedKey([grid[13], grid[14], grid[15]]) }),
    );
    expect(visible(grid.slice(13), new Set(grid), hidden)).toHaveLength(2);
  });

  it("groups days in the page's zone, not UTC", () => {
    // 22:00-01:00 UTC is one New York evening but two UTC days: 4 + 2 slots
    // hide floor(1.6) + floor(0.8) = 1 in UTC, floor(2.4) = 2 in New York.
    const start = Date.parse("2026-08-17T22:00:00.000Z");
    const grid = Array.from({ length: 6 }, (_, i) => start + i * 30 * MIN);
    expect(lookBusyHiddenStarts(input({ grid, share: 0.4, bookableFromMs: 0 })).size).toBe(1);
    expect(
      lookBusyHiddenStarts(input({ grid, share: 0.4, bookableFromMs: 0, zone: "America/New_York" })).size,
    ).toBe(2);
  });
});

describe("as meetings are booked, hidden times become available", () => {
  for (const level of LOOK_BUSY_LEVELS) {
    it(`gives back one hidden time per booking (${level})`, () => {
      const grid = dayGrid(2);
      const open = new Set(grid);
      let hidden = lookBusyHiddenStarts(input({ grid, open, level }));
      const shown = visible(grid, open, hidden).length;
      expect(hidden.size).toBeGreaterThan(0);

      while (hidden.size > 0) {
        // A visitor books the earliest time they can see.
        const pick = visible(grid, open, hidden)[0];
        open.delete(pick);
        const next = lookBusyHiddenStarts(input({ grid, open, level }));
        // Only ever reveals: nothing that was showing is hidden now...
        for (const start of next) expect(hidden.has(start)).toBe(true);
        // ...and exactly one comes back, so the choice stays as wide.
        expect(next.size).toBe(hidden.size - 1);
        expect(visible(grid, open, next)).toHaveLength(shown);
        hidden = next;
      }
    });
  }

  it("fills a day further as it approaches, the way real calendars do", () => {
    const grid = dayGrid(21);
    const farOut = lookBusyHiddenStarts(input({ grid, nowMs: NOW }));
    const tomorrow = lookBusyHiddenStarts(input({ grid, nowMs: NOW + 20 * DAY }));
    expect(tomorrow.size).toBeGreaterThan(farOut.size);
    // Growing, not reshuffling: what was hidden stays hidden.
    for (const start of farOut) expect(tomorrow.has(start)).toBe(true);
  });
});

describe("a month that looks real", () => {
  const month = Array.from({ length: 28 }, (_, day) => dayGrid(day));
  const hiddenByDay = (key: LookBusyKey) => {
    const hidden = lookBusyHiddenStarts(input({ grid: month.flat(), key }));
    return month.map((grid) => grid.filter((start) => hidden.has(start)).length);
  };

  it("is busier this week than in four weeks", () => {
    const perDay = hiddenByDay(secretKey);
    const sum = (days: number[]) => days.reduce((a, b) => a + b, 0);
    expect(sum(perDay.slice(0, 7))).toBeGreaterThan(sum(perDay.slice(21, 28)) + 7);
  });

  it("does not stamp every day from one template", () => {
    const perDay = hiddenByDay(secretKey);
    // Days at the same distance trend alike but differ day to day.
    expect(new Set(perDay.slice(14)).size).toBeGreaterThan(1);
    // And the hidden times themselves differ between days.
    const hidden = lookBusyHiddenStarts(input({ grid: month.flat() }));
    const pattern = (day: number) =>
      month[day].map((start) => (hidden.has(start) ? "x" : ".")).join("");
    expect(new Set(month.map((_, day) => pattern(day))).size).toBeGreaterThan(20);
  });

  it("fills prime hours first and the day's edges last", () => {
    // Many days at one share, so the time-of-day weights are the only bias.
    const days = Array.from({ length: 120 }, (_, day) => dayGrid(day));
    const hidden = lookBusyHiddenStarts(input({ grid: days.flat(), share: 0.25, bookableFromMs: 0 }));
    const rate = (pick: (i: number) => boolean) => {
      const chosen = days.flatMap((grid) => grid.filter((_, i) => pick(i)));
      return chosen.filter((start) => hidden.has(start)).length / chosen.length;
    };
    const prime = rate((i) => (i >= 2 && i < 6) || (i >= 9 && i < 15)); // 10-12, 13:30-16:30
    const edges = rate((i) => i === 0 || i === 15);
    expect(prime).toBeGreaterThan(edges * 1.5);
  });

  it("hides meeting-shaped blocks: half-hours, hours and hour-and-a-halfs", () => {
    const hidden = lookBusyHiddenStarts(input({ grid: month.flat(), share: 0.4 }));
    const runs = new Map<number, number>();
    for (const grid of month) {
      let run = 0;
      for (const start of [...grid, Number.NaN]) {
        if (hidden.has(start)) run += 1;
        else if (run > 0) {
          runs.set(run, (runs.get(run) ?? 0) + 1);
          run = 0;
        }
      }
    }
    expect(runs.get(1)).toBeGreaterThan(0);
    expect(runs.get(2)).toBeGreaterThan(0);
    expect(runs.get(3)).toBeGreaterThan(0);
  });
});

describe("phantom calls", () => {
  it("run one, two or three slots", () => {
    expect([0, 0.49, 0.5, 0.84, 0.85, 0.99].map(phantomSlots)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("never run longer than the day still needs", () => {
    const grid = dayGrid();
    // Five real meetings at 0.4: 6 - 5 = one time left to hide.
    const open = new Set(grid.filter((_, i) => ![0, 1, 2, 3, 15].includes(i)));
    const hidden = lookBusyHiddenStarts(
      input({ grid, open, share: 0.4, key: orderedKey([grid[7]], { [grid[7]]: 3 }) }),
    );
    expect([...hidden]).toEqual([grid[7]]);
  });

  it("take adjacent times, never across a real meeting", () => {
    const grid = dayGrid();
    const open = new Set(grid.filter((_, i) => i !== 9));
    const hidden = lookBusyHiddenStarts(
      input({ grid, open, share: 0.25, key: orderedKey([grid[7], grid[3]], { [grid[7]]: 3 }) }),
    );
    // Three to hide. A 90-minute phantom at 12:30 would need 13:30, which a
    // real meeting holds: it takes 12:30 and 13:00, and the next phantom
    // takes 10:30.
    expect([...hidden].sort()).toEqual([grid[3], grid[7], grid[8]].sort());
  });

  it("on a chat grid (15 minutes every 30) take three grid times, no more", () => {
    const grid = dayGrid();
    const hidden = lookBusyHiddenStarts(
      input({
        grid,
        durationMinutes: 15,
        share: 3 / 16,
        key: orderedKey([grid[4]], { [grid[4]]: 3 }),
      }),
    );
    expect([...hidden].sort()).toEqual([grid[4], grid[5], grid[6]]);
  });

  it("weight prime hours up and the day's edges down", () => {
    expect(primeHourWeight(10 * 60 + 30, false)).toBeGreaterThan(primeHourWeight(9 * 60, false));
    expect(primeHourWeight(15 * 60, false)).toBeGreaterThan(primeHourWeight(12 * 60 + 30, false));
    expect(primeHourWeight(10 * 60 + 30, true)).toBeLessThan(primeHourWeight(9 * 60, false));
  });
});

describe("keyed draws", () => {
  it("are the same on every request", () => {
    const grid = [...dayGrid(0), ...dayGrid(1), ...dayGrid(2)];
    const first = lookBusyHiddenStarts(input({ grid }));
    const again = lookBusyHiddenStarts(input({ grid, key: lookBusyKey("ju", "test-secret") }));
    expect([...again].sort()).toEqual([...first].sort());
  });

  it("differ between pages and between secrets", () => {
    const grid = Array.from({ length: 6 }, (_, day) => dayGrid(day)).flat();
    const pattern = (key: LookBusyKey) => [...lookBusyHiddenStarts(input({ grid, key }))].sort().join(",");
    const patterns = [
      pattern(secretKey),
      pattern(lookBusyKey("eldar", "test-secret")),
      pattern(lookBusyKey("", "test-secret")),
      pattern(lookBusyKey("ju", "another-secret")),
    ];
    expect(new Set(patterns).size).toBe(4);
  });

  it("stay in range, and work without a secret (mock mode)", () => {
    for (let i = 0; i < 500; i += 1) {
      const draw = secretKey.slot(MONDAY_9 + i * 30 * MIN);
      expect(draw.u).toBeGreaterThan(0);
      expect(draw.u).toBeLessThanOrEqual(1);
      expect(draw.lengthRoll).toBeGreaterThanOrEqual(0);
      expect(draw.lengthRoll).toBeLessThan(1);
    }
    const day = secretKey.day("2026-08-17");
    expect(day).toBeGreaterThanOrEqual(0);
    expect(day).toBeLessThan(1);
    expect(lookBusyKey("", null).slot(MONDAY_9)).toEqual(lookBusyKey("", null).slot(MONDAY_9));
  });
});

describe("levels", () => {
  it("look busiest today and thin out further ahead", () => {
    for (const level of LOOK_BUSY_LEVELS) {
      let previous = Number.POSITIVE_INFINITY;
      for (const days of [0, 1, 3, 7, 14, 30]) {
        const share = lookBusyShare(level, days, 0.5);
        expect(share).toBeLessThan(previous);
        previous = share;
      }
      expect(lookBusyShare(level, 0, 0.5)).toBeCloseTo(LOOK_BUSY_LEVEL_INFO[level].near);
      expect(lookBusyShare(level, 365, 0.5)).toBeCloseTo(LOOK_BUSY_LEVEL_INFO[level].far);
    }
  });

  it("rank Light below Balanced below Packed on every day", () => {
    for (const days of [0, 5, 20]) {
      expect(lookBusyShare("light", days, 0.5)).toBeLessThan(lookBusyShare("balanced", days, 0.5));
      expect(lookBusyShare("balanced", days, 0.5)).toBeLessThan(lookBusyShare("packed", days, 0.5));
    }
  });

  it("wobble each day by a bounded amount", () => {
    const middle = lookBusyShare("balanced", 3, 0.5);
    expect(lookBusyShare("balanced", 3, 0)).toBeCloseTo(middle - LOOK_BUSY_DAY_WOBBLE);
    expect(lookBusyShare("balanced", 3, 0.999999)).toBeCloseTo(middle + LOOK_BUSY_DAY_WOBBLE, 4);
  });

  it("read anything unknown as off", () => {
    expect(parseLookBusyLevel("packed")).toBe("packed");
    for (const value of [null, undefined, "", "on", true, 1, "Packed"]) {
      expect(parseLookBusyLevel(value)).toBeNull();
    }
  });
});

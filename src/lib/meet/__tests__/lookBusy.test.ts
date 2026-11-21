import { describe, expect, it } from "vitest";
import { lookBusyHiddenStarts, lookBusyKey, type LookBusyInput } from "@/lib/meet/lookBusy";
import { LOOK_BUSY_LEVELS, parseLookBusyLevel } from "@/lib/meet/lookBusyLevels";
import { wallToUtcMs } from "@/lib/meet/tz";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MONDAY = Date.parse("2026-08-17T09:00:00Z");
const key = lookBusyKey("ju", "test-secret");

function dayGrid(daysAhead = 0, count = 16) {
  return Array.from({ length: count }, (_, i) => MONDAY + daysAhead * DAY + i * 30 * MINUTE);
}

function shown(grid: number[], options: Partial<Omit<LookBusyInput, "grid">> = {}): number[] {
  const open = options.open ?? new Set(grid);
  const bookableFromMs = options.bookableFromMs ?? MONDAY;
  const hidden = lookBusyHiddenStarts({ level: "balanced", zone: "UTC", key, ...options, grid, open, bookableFromMs });
  return [...new Set(grid)].filter(s => open.has(s) && s >= bookableFromMs && !hidden.has(s)).sort((a, b) => a - b);
}

describe("daily look-busy choices", () => {
  it.each([["light", 5], ["balanced", 4], ["packed", 3]] as const)(
    "shows up to the daily limit at %s regardless of how far away the date is",
    (level, limit) => {
      for (const daysAhead of [0, 2, 28]) {
        const grid = dayGrid(daysAhead);
        for (const count of [0, 1, 2, 3, 4, 5, grid.length]) {
          const open = new Set(grid.slice(0, count));
          const slots = shown(grid, { level, open });
          expect(slots).toHaveLength(Math.min(limit, count));
          if (count <= limit) expect(slots).toEqual([...open]);
        }
      }
    },
  );

  it("is repeatable across refreshes, input ordering, duplicate starts and overlapping requests", () => {
    const grid = dayGrid(2);
    const initial = shown(grid);
    expect(shown([...grid, ...grid].reverse(), { key: lookBusyKey("ju", "test-secret") })).toEqual(initial);
    expect(shown([...dayGrid(1), ...grid, ...dayGrid(3)]).filter(s => grid.includes(s))).toEqual(initial);
    const light = shown(grid, { level: "light" });
    const packed = shown(grid, { level: "packed" });
    expect(packed.every(s => initial.includes(s))).toBe(true);
    expect(initial.every(s => light.includes(s))).toBe(true);
  });

  it("replaces only booked or expired choices, down to the final opening", () => {
    const grid = dayGrid();
    for (const level of LOOK_BUSY_LEVELS) {
      const initial = shown(grid, { level });
      for (const removed of grid) {
        const open = new Set(grid.filter(s => s !== removed));
        const after = shown(grid, { level, open });
        expect(after).toHaveLength(initial.length);
        expect(after).not.toContain(removed);
        expect(initial.filter(s => s !== removed).every(s => after.includes(s))).toBe(true);
      }
      let prior = initial;
      for (const [index, cutoff] of grid.entries()) {
        const after = shown(grid, { level, bookableFromMs: cutoff });
        expect(after).toHaveLength(Math.min(initial.length, grid.length - index));
        expect(prior.filter(s => s >= cutoff).every(s => after.includes(s))).toBe(true);
        prior = after;
      }
    }
  });

  it("counts by the host's local day across midnight UTC and a DST change", () => {
    const zone = "America/Los_Angeles";
    // Afternoons on both sides of the fall clock change span UTC midnight.
    const localDay = (month: number, date: number) =>
      Array.from({ length: 12 }, (_, i) => wallToUtcMs(zone, 2026, month, date, 15 + Math.floor(i / 2), i % 2 * 30));
    const saturday = localDay(10, 31);
    const sunday = localDay(11, 1);
    const selected = shown([...saturday, ...sunday], { zone });
    expect(selected.filter(s => saturday.includes(s))).toHaveLength(4);
    expect(selected.filter(s => sunday.includes(s))).toHaveLength(4);
  });

  it("samples the whole day, with modest preferences and no required window", () => {
    const trials = 240;
    const selectionCounts = Array<number>(16).fill(0);
    const patterns = new Set<string>();
    let daysWithoutMorning = 0;
    for (let day = 0; day < trials; day++) {
      const grid = dayGrid(day);
      const selected = shown(grid).map(s => grid.indexOf(s));
      for (const i of selected) selectionCounts[i]++;
      patterns.add(selected.join(","));
      if (!selected.some(i => i >= 1 && i <= 3)) daysWithoutMorning++;
    }
    expect(patterns.size).toBeGreaterThan(trials / 2);
    expect(daysWithoutMorning).toBeGreaterThan(0);
    expect(selectionCounts.every(n => n > 0 && n < trials)).toBe(true);
    const average = (indices: number[]) => indices.reduce((sum, i) => sum + selectionCounts[i], 0) / indices.length;
    // Local 9:30–10:30 and 14:00–15:00, then the opening and closing times.
    const ordinary = average([4, 5, 6, 7, 8, 9, 13, 14]);
    expect(average([1, 2, 3, 10, 11, 12])).toBeGreaterThan(ordinary);
    expect(average([0, 15])).toBeGreaterThan(ordinary);
  });

  it("keeps overnight and off-hour shifts bookable, including the last real slot", () => {
    const grid = dayGrid().map(s => s - 8 * 60 * MINUTE);
    const slots = shown(grid, { bookableFromMs: 0, key: start => start === grid.at(-1) ? 1 : 0.5 });
    expect(slots).toHaveLength(4);
    expect(slots).toContain(grid.at(-1));
    const open = new Set([grid[1], grid[3], grid[5], grid[7]]);
    expect(shown(grid, { bookableFromMs: 0, open })).toEqual([...open]);
  });

  it("uses keyed page-specific draws, including in local mock mode", () => {
    const grid = Array.from({ length: 7 }, (_, day) => dayGrid(day)).flat();
    const patterns = [key, lookBusyKey("eldar", "test-secret"), lookBusyKey("ju", "different-secret")];
    expect(new Set(patterns.map(k => shown(grid, { key: k }).join(","))).size).toBe(3);
    expect(lookBusyKey("", null)(MONDAY)).toBe(lookBusyKey("", null)(MONDAY));
    for (const slot of grid) {
      expect(key(slot)).toBeGreaterThan(0);
      expect(key(slot)).toBeLessThanOrEqual(1);
    }
  });

  it("leaves an unknown or missing level off", () => {
    for (const level of LOOK_BUSY_LEVELS) expect(parseLookBusyLevel(level)).toBe(level);
    for (const value of [null, undefined, "", true, 1, "Packed"]) {
      expect(parseLookBusyLevel(value)).toBeNull();
    }
  });
});

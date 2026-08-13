import { describe, expect, it } from "vitest";
import { mergeBusy, overlapsBusy, type BusyInterval } from "@/lib/meet/types";

describe("mergeBusy", () => {
  it("merges overlapping intervals", () => {
    expect(
      mergeBusy([
        { startMs: 0, endMs: 10 },
        { startMs: 5, endMs: 15 },
      ])
    ).toEqual([{ startMs: 0, endMs: 15 }]);
  });

  it("merges adjacent intervals", () => {
    expect(
      mergeBusy([
        { startMs: 0, endMs: 10 },
        { startMs: 10, endMs: 20 },
      ])
    ).toEqual([{ startMs: 0, endMs: 20 }]);
  });

  it("drops zero-length and negative-length intervals", () => {
    expect(mergeBusy([{ startMs: 5, endMs: 5 }])).toEqual([]);
    expect(mergeBusy([{ startMs: 8, endMs: 3 }])).toEqual([]);
  });

  it("sorts unsorted input", () => {
    expect(
      mergeBusy([
        { startMs: 20, endMs: 30 },
        { startMs: 0, endMs: 5 },
      ])
    ).toEqual([
      { startMs: 0, endMs: 5 },
      { startMs: 20, endMs: 30 },
    ]);
  });

  it("handles a mixed unsorted set with chains and degenerates", () => {
    expect(
      mergeBusy([
        { startMs: 30, endMs: 40 },
        { startMs: 0, endMs: 10 },
        { startMs: 10, endMs: 15 },
        { startMs: 14, endMs: 20 },
        { startMs: 25, endMs: 25 },
      ])
    ).toEqual([
      { startMs: 0, endMs: 20 },
      { startMs: 30, endMs: 40 },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(mergeBusy([])).toEqual([]);
  });
});

describe("overlapsBusy", () => {
  const one: BusyInterval[] = [{ startMs: 10, endMs: 20 }];

  it("is false for an empty busy set", () => {
    expect(overlapsBusy([], 0, 100)).toBe(false);
  });

  it("does not treat touching edges as overlap (half-open)", () => {
    expect(overlapsBusy(one, 0, 10)).toBe(false); // query ends at busy start
    expect(overlapsBusy(one, 20, 30)).toBe(false); // query starts at busy end
  });

  it("detects partial, contained, containing, and exact overlaps", () => {
    expect(overlapsBusy(one, 19, 21)).toBe(true);
    expect(overlapsBusy(one, 5, 11)).toBe(true);
    expect(overlapsBusy(one, 12, 15)).toBe(true);
    expect(overlapsBusy(one, 5, 25)).toBe(true);
    expect(overlapsBusy(one, 10, 20)).toBe(true);
  });

  it("respects gaps between intervals in a sorted set", () => {
    const two: BusyInterval[] = [
      { startMs: 10, endMs: 20 },
      { startMs: 40, endMs: 50 },
    ];
    expect(overlapsBusy(two, 20, 40)).toBe(false);
    expect(overlapsBusy(two, 35, 45)).toBe(true);
    expect(overlapsBusy(two, 50, 60)).toBe(false);
  });
});

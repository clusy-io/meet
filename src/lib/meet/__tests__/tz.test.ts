import { describe, expect, it } from "vitest";
import {
  formatCivilDate,
  parseCivilDate,
  utcToWall,
  wallToUtcMs,
  zoneOffsetMs,
} from "@/lib/meet/tz";

const LA = "America/Los_Angeles";
const HOUR = 3_600_000;

describe("zoneOffsetMs", () => {
  it("is -8h in LA winter (PST)", () => {
    expect(zoneOffsetMs(LA, Date.parse("2026-01-15T20:00:00Z"))).toBe(-8 * HOUR);
  });

  it("is -7h in LA summer (PDT)", () => {
    expect(zoneOffsetMs(LA, Date.parse("2026-07-15T20:00:00Z"))).toBe(-7 * HOUR);
  });
});

describe("wallToUtcMs", () => {
  it("maps 8:30 LA summer wall time to 15:30Z", () => {
    expect(wallToUtcMs(LA, 2026, 8, 20, 8, 30)).toBe(Date.parse("2026-08-20T15:30:00Z"));
  });

  it("maps 8:30 LA winter wall time to 16:30Z", () => {
    expect(wallToUtcMs(LA, 2026, 1, 15, 8, 30)).toBe(Date.parse("2026-01-15T16:30:00Z"));
  });

  it("roundtrips through utcToWall to the same wall fields", () => {
    const utcMs = wallToUtcMs(LA, 2026, 8, 20, 8, 30);
    const wall = utcToWall(LA, utcMs);
    expect(wall.year).toBe(2026);
    expect(wall.month).toBe(8);
    expect(wall.day).toBe(20);
    expect(wall.hour).toBe(8);
    expect(wall.minute).toBe(30);
  });

  it("resolves 8:30 on the spring-forward day (2026-03-08) to 15:30Z", () => {
    // DST starts 02:00 local; 08:30 is already PDT.
    expect(wallToUtcMs(LA, 2026, 3, 8, 8, 30)).toBe(Date.parse("2026-03-08T15:30:00Z"));
  });

  it("resolves 8:30 on the fall-back day (2026-11-01) to 16:30Z", () => {
    // DST ends 02:00 local; 08:30 is already PST.
    expect(wallToUtcMs(LA, 2026, 11, 1, 8, 30)).toBe(Date.parse("2026-11-01T16:30:00Z"));
  });
});

describe("utcToWall weekday", () => {
  it("reports ISO weekday 1 for a known Monday", () => {
    // 2026-08-17 is a Monday.
    const noon = wallToUtcMs(LA, 2026, 8, 17, 12, 0);
    expect(utcToWall(LA, noon).weekday).toBe(1);
  });

  it("reports ISO weekday 7 for a known Sunday", () => {
    // 2026-08-16 is a Sunday.
    const noon = wallToUtcMs(LA, 2026, 8, 16, 12, 0);
    expect(utcToWall(LA, noon).weekday).toBe(7);
  });
});

describe("civil date parse/format", () => {
  it("roundtrips parse -> format", () => {
    const parsed = parseCivilDate("2026-08-05");
    expect(parsed).toEqual({ year: 2026, month: 8, day: 5 });
    expect(formatCivilDate(2026, 8, 5)).toBe("2026-08-05");
  });

  it("rejects malformed input", () => {
    expect(parseCivilDate("garbage")).toBeNull();
    expect(parseCivilDate("")).toBeNull();
    expect(parseCivilDate("2026-1-5")).toBeNull();
    expect(parseCivilDate("2026-13-01")).toBeNull();
    expect(parseCivilDate("2026-00-10")).toBeNull();
    expect(parseCivilDate("2026-01-32")).toBeNull();
    expect(parseCivilDate("2026-08-05T00:00:00Z")).toBeNull();
  });
});

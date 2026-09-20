import { describe, expect, it } from "vitest";
import {
  formatCivilDate,
  minutesToClock,
  normalizeBookingWindow,
  parseCivilDate,
  parseClockToMinutes,
  utcToWall,
  wallToUtcMs,
  windowCrossesMidnight,
  windowMinutesToClock,
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
    expect(parseCivilDate("2026-02-30")).toBeNull();
    expect(parseCivilDate("2026-08-05T00:00:00Z")).toBeNull();
  });
});

describe("normalizeBookingWindow", () => {
  it("keeps a same-day window as written", () => {
    expect(normalizeBookingWindow(510, 1320)).toEqual({
      startMin: 510,
      endMin: 1320,
    });
  });

  it("reads a close before the open as the next day", () => {
    // 08:00 to 02:00 is an 18-hour overnight window.
    expect(normalizeBookingWindow(8 * 60, 2 * 60)).toEqual({
      startMin: 480,
      endMin: 1560,
    });
  });

  it("reads an equal open and close as a full day", () => {
    expect(normalizeBookingWindow(480, 480)).toEqual({
      startMin: 480,
      endMin: 1920,
    });
  });

  it("leaves an already-normalized overnight close alone", () => {
    expect(normalizeBookingWindow(480, 1560)).toEqual({
      startMin: 480,
      endMin: 1560,
    });
  });

  it("rejects a window longer than a day or bounds outside one", () => {
    // A stored 02:00-next-day close read against a 01:00 open is 25 hours.
    expect(normalizeBookingWindow(60, 1560)).toBeNull();
    expect(normalizeBookingWindow(1440, 1500)).toBeNull();
    expect(normalizeBookingWindow(-1, 600)).toBeNull();
    expect(normalizeBookingWindow(480, 3000)).toBeNull();
    expect(normalizeBookingWindow(480.5, 1200)).toBeNull();
  });

  it("says which windows cross midnight", () => {
    expect(windowCrossesMidnight(1320)).toBe(false);
    expect(windowCrossesMidnight(1440)).toBe(false);
    expect(windowCrossesMidnight(1560)).toBe(true);
  });
});

describe("clock formatting", () => {
  it("renders window bounds zero-padded and wrapped past midnight", () => {
    // Zero-padded because this is what an <input type="time"> is handed, and
    // that element silently rejects "8:30".
    expect(windowMinutesToClock(510)).toBe("08:30");
    expect(windowMinutesToClock(1320)).toBe("22:00");
    expect(windowMinutesToClock(1440)).toBe("00:00");
    expect(windowMinutesToClock(1560)).toBe("02:00");
  });

  it("keeps the timeline formatter counting past 24:00", () => {
    expect(minutesToClock(510)).toBe("8:30");
    expect(minutesToClock(1440)).toBe("24:00");
  });

  it("roundtrips a window through its clock strings", () => {
    const start = parseClockToMinutes(windowMinutesToClock(480));
    const end = parseClockToMinutes(windowMinutesToClock(1560));
    expect(normalizeBookingWindow(start!, end!)).toEqual({
      startMin: 480,
      endMin: 1560,
    });
  });
});

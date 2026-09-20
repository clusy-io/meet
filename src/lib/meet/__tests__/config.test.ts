import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetMeetConfigCache, getMeetConfig } from "@/lib/meet/config";

const ENV_NAMES = [
  "NEXT_PUBLIC_SITE_URL",
  "MEET_EMAIL_FROM",
  "MEET_HOST_TIMEZONE",
  "MEET_WINDOW_START",
  "MEET_WINDOW_END",
  "MEET_DURATION_MINUTES",
  "MEET_SLOT_STEP_MINUTES",
  "MEET_MIN_NOTICE_MINUTES",
  "MEET_HORIZON_DAYS",
  "MEET_MEMBERS",
  "MEET_QUORUM",
  "MEET_MOCK_MODE",
] as const;

let original: Partial<Record<(typeof ENV_NAMES)[number], string>>;

beforeEach(() => {
  original = {};
  for (const name of ENV_NAMES) {
    if (process.env[name] !== undefined) original[name] = process.env[name];
    delete process.env[name];
  }
  process.env.MEET_MOCK_MODE = "1";
  __resetMeetConfigCache();
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetMeetConfigCache();
});

function configured(env: Record<string, string>) {
  Object.assign(process.env, env);
  __resetMeetConfigCache();
  return () => getMeetConfig();
}

describe("Meet config validation", () => {
  it("accepts and normalizes a valid single-member configuration", () => {
    const read = configured({
      NEXT_PUBLIC_SITE_URL: "https://example.com/",
      MEET_MEMBERS: JSON.stringify([
        { key: "owner", name: " Owner ", email: " OWNER@Example.com " },
      ]),
    });

    const config = read();
    expect(config.siteOrigin).toBe("https://example.com");
    expect(config.members).toEqual([
      { key: "owner", name: "Owner", email: "owner@example.com" },
    ]);
    expect(config.quorum).toBe(1);
  });

  it.each([
    [{ MEET_DURATION_MINUTES: "0" }, "MEET_DURATION_MINUTES"],
    [
      { MEET_DURATION_MINUTES: "30", MEET_SLOT_STEP_MINUTES: "15" },
      "MEET_SLOT_STEP_MINUTES",
    ],
    [{ MEET_QUORUM: "0" }, "MEET_QUORUM"],
    [{ MEET_WINDOW_END: "24:30" }, "MEET_WINDOW_END"],
    // 24:00 is a closing time, never an opening one.
    [{ MEET_WINDOW_START: "24:00" }, "at most 24 hours"],
    [{ MEET_HOST_TIMEZONE: "Mars/Olympus" }, "MEET_HOST_TIMEZONE"],
    [{ NEXT_PUBLIC_SITE_URL: "https://example.com/meet" }, "NEXT_PUBLIC_SITE_URL"],
    [{ MEET_EMAIL_FROM: "Clusy <not-an-email>" }, "MEET_EMAIL_FROM"],
    [{ MEET_EMAIL_FROM: "meet@clusy.io\nBcc: leak@example.com" }, "MEET_EMAIL_FROM"],
    [{ MEET_HORIZON_DAYS: "forever" }, "MEET_HORIZON_DAYS"],
  ])("rejects dangerous bounds %#", (env, message) => {
    expect(configured(env)).toThrow(message);
  });

  it("reads a close at or before the open as the next day", () => {
    const config = configured({
      MEET_WINDOW_START: "08:00",
      MEET_WINDOW_END: "02:00",
      MEET_DURATION_MINUTES: "60",
      MEET_SLOT_STEP_MINUTES: "60",
    })();
    expect(config.windowStartMin).toBe(480);
    // 02:00 the next day, counted from the opening day's midnight.
    expect(config.windowEndMin).toBe(1560);
  });

  it("treats an equal open and close as a full 24 hours", () => {
    const config = configured({
      MEET_WINDOW_START: "08:00",
      MEET_WINDOW_END: "08:00",
    })();
    expect(config.windowEndMin - config.windowStartMin).toBe(1440);
  });

  it("keeps a same-day window on the day it opened", () => {
    const config = configured({
      MEET_WINDOW_START: "08:30",
      MEET_WINDOW_END: "22:00",
    })();
    expect(config.windowStartMin).toBe(510);
    expect(config.windowEndMin).toBe(1320);
  });

  it("measures the meeting length against the overnight span", () => {
    // 22:00 to 02:00 is four hours, so a three-hour meeting fits and a
    // five-hour one does not.
    expect(
      configured({
        MEET_WINDOW_START: "22:00",
        MEET_WINDOW_END: "02:00",
        MEET_DURATION_MINUTES: "180",
        MEET_SLOT_STEP_MINUTES: "180",
      })().durationMinutes
    ).toBe(180);
    expect(
      configured({
        MEET_WINDOW_START: "22:00",
        MEET_WINDOW_END: "02:00",
        MEET_DURATION_MINUTES: "300",
        MEET_SLOT_STEP_MINUTES: "300",
      })
    ).toThrow("MEET_DURATION_MINUTES");
  });

  it("allows bootstrap quorum above the env roster for later runtime additions", () => {
    expect(configured({ MEET_QUORUM: "4" })().quorum).toBe(4);
  });

  it("rejects duplicate member keys", () => {
    expect(
      configured({
        MEET_MEMBERS: JSON.stringify([
          { key: "same", name: "One", email: "one@example.com" },
          { key: "same", name: "Two", email: "two@example.com" },
        ]),
      })
    ).toThrow("duplicate member key");
  });

  it("rejects duplicate or invalid member emails", () => {
    expect(
      configured({
        MEET_MEMBERS: JSON.stringify([
          { key: "one", name: "One", email: "TEAM@example.com" },
          { key: "two", name: "Two", email: "team@example.com" },
        ]),
      })
    ).toThrow("duplicate member email");

    expect(
      configured({
        MEET_MEMBERS: JSON.stringify([{ key: "one", name: "One", email: "not-an-email" }]),
      })
    ).toThrow("valid email");
  });
});

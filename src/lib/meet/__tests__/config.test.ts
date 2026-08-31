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
    [{ MEET_WINDOW_START: "22:00", MEET_WINDOW_END: "08:30" }, "MEET_WINDOW_START"],
    [{ MEET_WINDOW_END: "24:30" }, "MEET_WINDOW_END"],
    [{ MEET_HOST_TIMEZONE: "Mars/Olympus" }, "MEET_HOST_TIMEZONE"],
    [{ NEXT_PUBLIC_SITE_URL: "https://example.com/meet" }, "NEXT_PUBLIC_SITE_URL"],
    [{ MEET_EMAIL_FROM: "Clusy <not-an-email>" }, "MEET_EMAIL_FROM"],
    [{ MEET_EMAIL_FROM: "meet@clusy.io\nBcc: leak@example.com" }, "MEET_EMAIL_FROM"],
    [{ MEET_HORIZON_DAYS: "forever" }, "MEET_HORIZON_DAYS"],
  ])("rejects dangerous bounds %#", (env, message) => {
    expect(configured(env)).toThrow(message);
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookBusyLevel } from "@/lib/meet/lookBusyLevels";
import type { Booking, BusyInterval, PageSettings } from "@/lib/meet/types";

/**
 * "Make my calendar look busy", end to end through computeAvailability: the
 * real slot grid, quorum, bookings overlay, horizon and settings rows, with
 * only the calendars and the database faked.
 */

const mocks = vi.hoisted(() => ({
  config: {
    hostTimezone: "UTC",
    windowStartMin: 9 * 60,
    windowEndMin: 17 * 60,
    bookableWeekdays: [1, 2, 3, 4, 5],
    durationMinutes: 30,
    slotStepMinutes: 30,
    minNoticeMinutes: 0,
    horizonDays: 4,
    members: [
      { key: "one", name: "One", email: "one@example.com" },
      { key: "two", name: "Two", email: "two@example.com" },
    ],
    quorum: 2,
    eventTitle: "Call with {name}",
    eventDescription: "A test call",
    brandName: "Test",
    siteOrigin: "https://example.com",
    emailFrom: "Test <meet@example.com>",
    organizerEmail: null as string | null,
    adminSecret: null,
    tokenSecret: "test-secret",
    cronSecret: null,
    mockMode: false,
  },
  busy: new Map<string, BusyInterval[]>(),
  bookings: [] as Booking[],
  settings: [] as PageSettings[],
}));

vi.mock("@/lib/meet/config", () => ({ getMeetConfig: () => mocks.config }));
vi.mock("@/lib/meet/members", () => ({
  getRuntimeMeetConfig: async () => mocks.config,
  getEffectiveMeetConfig: async () => mocks.config,
}));
vi.mock("@/lib/meet/crypto", () => ({ decryptSecret: (v: string) => v }));
vi.mock("@/lib/meet/providers", () => ({
  getProvider: () => ({
    getBusy: async (token: string) => mocks.busy.get(token) ?? [],
  }),
}));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
    listMemberOverrides: async () => [],
    listAccounts: async () =>
      mocks.config.members.map((member) => ({
        id: `acct-${member.key}`,
        memberKey: member.key,
        provider: "google",
        status: "ok",
        // The fake provider looks busy time up by token.
        refreshTokenEnc: member.key,
        selectedCalendars: [{ id: "primary", name: "Primary" }],
      })),
    updateAccount: async () => undefined,
    listPageSettings: async () => mocks.settings,
    listConfirmedBookingsInRange: async () => mocks.bookings,
  }),
}));

import {
  computeAvailability,
  computeAvailabilityPlan,
  computeMemberBusyTimeline,
  invalidateAvailabilityCache,
  type AvailabilityOptions,
} from "@/lib/meet/availability";

const MIN = 60_000;
/** Monday 2026-08-17, 08:00 UTC: before the first 09:00 slot. */
const NOW = Date.parse("2026-08-17T08:00:00.000Z");
const at = (iso: string) => Date.parse(iso);
const WEEK = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"];

function row(memberKey: string, lookBusy: LookBusyLevel | null): PageSettings {
  return {
    memberKey,
    enabled: true,
    headline: null,
    blurb: null,
    timezone: null,
    timezoneUntil: null,
    windowStartMin: null,
    windowEndMin: null,
    bookableWeekdays: null,
    durationMinutes: null,
    slotStepMinutes: null,
    minNoticeMinutes: null,
    horizonDays: null,
    eventTitle: null,
    eventDescription: null,
    lookBusy,
    slackWebhookEnc: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

/** The team page's switch, on its own settings row. */
function teamLooksBusy(level: LookBusyLevel | null) {
  mocks.settings = [row("", level)];
}

function booking(startIso: string, attendeeMemberKeys: string[], pageKey = ""): Booking {
  const startMs = at(startIso);
  return {
    id: `bk-${startIso}`,
    pageKey,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(startMs + 30 * MIN).toISOString(),
    durationMinutes: 30,
    name: "Visitor",
    email: "visitor@example.com",
    notes: "Hello",
    timezone: "UTC",
    attendeeMemberKeys,
    guests: [],
    eventRefs: [],
    meetingUrl: null,
    status: "confirmed",
    manageToken: `tok-${startIso}`,
    history: [],
    remindersSent: [],
    syncStatus: "synced",
    createdAt: new Date(NOW).toISOString(),
    cancelledAt: null,
  };
}

async function slots(options: AvailabilityOptions = {}): Promise<string[]> {
  invalidateAvailabilityCache();
  return (await computeAvailability("2026-08-17", 7, options)).slots;
}

function onDay(list: string[], date: string): string[] {
  return list.filter((slot) => slot.startsWith(date));
}

const personal = (lookBusy: LookBusyLevel | null): AvailabilityOptions => ({
  hostKey: "one",
  config: { ...mocks.config, quorum: 1, lookBusy },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.config.minNoticeMinutes = 0;
  mocks.busy = new Map();
  mocks.bookings = [];
  mocks.settings = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the team page looking busy", () => {
  it("hides nothing while its switch is off", async () => {
    expect(await slots()).toHaveLength(5 * 16);
    teamLooksBusy(null);
    expect(await slots()).toHaveLength(5 * 16);
  });

  it.each([
    ["light", 5], ["balanced", 4], ["packed", 3],
  ] as const)("shows %s days with at most %i real choices, repeatably", async (level, limit) => {
    const all = await slots();
    teamLooksBusy(level);
    const shown = await slots();
    for (const date of WEEK) {
      const daily = onDay(shown, date);
      expect(daily).toHaveLength(limit);
      expect(new Set(daily).size).toBe(limit);
    }
    expect(shown.every((slot) => all.includes(slot))).toBe(true);
    expect(await slots()).toEqual(shown);
  });

  it("varies the mix of openings across the week and offers morning and afternoon times", async () => {
    teamLooksBusy("balanced");
    const shown = await slots();
    const clocks = shown.map((iso) => iso.slice(11, 16));
    expect(clocks.some((clock) => clock >= "09:30" && clock <= "10:30")).toBe(true);
    expect(clocks.some((clock) => clock >= "14:00" && clock <= "15:00")).toBe(true);
    const dailyPatterns = WEEK.map((date) => onDay(shown, date).map((iso) => iso.slice(11, 16)).join(","));
    expect(new Set(dailyPatterns).size).toBeGreaterThan(1);
    // A shorter query should show the same day as the full booking window.
    const single = await computeAvailability(WEEK[2], 1);
    expect(single.slots).toEqual(onDay(shown, WEEK[2]));
  });

  it.each([
    { schedule: "sparse", tokyoEnd: 19 * 60, laStart: 16 * 60 + 30, laEnd: 17 * 60 + 30 },
    { schedule: "wide", tokyoEnd: 23 * 60, laStart: 16 * 60, laEnd: 22 * 60 },
  ])("keeps the same host day across $schedule overseas windows", async ({ tokyoEnd, laStart, laEnd }) => {
    // An LA opening from the previous local evening falls after midnight UTC.
    mocks.settings = [
      row("", "balanced"),
      { ...row("one", null), timezone: "Asia/Tokyo", windowStartMin: 18 * 60, windowEndMin: tokyoEnd },
      { ...row("two", null), timezone: "America/Los_Angeles", windowStartMin: laStart, windowEndMin: laEnd },
    ];
    const date = WEEK[2];
    const team = { config: { ...mocks.config, quorum: 1 } };
    const week = onDay(await slots(team), date);
    expect(week).toHaveLength(4);
    const single = await computeAvailability(date, 1, team);
    expect(onDay(single.slots, date)).toEqual(week);
  });

  it("shows the same starts for a team chat and meeting when their actual grids match", async () => {
    teamLooksBusy("balanced");
    expect(await slots({ meetingType: "chat" })).toEqual(await slots());
  });

  it("hides nothing on a day real meetings already make busy", async () => {
    teamLooksBusy("packed");
    // Both members have 13 of Friday's 16 slots taken by real meetings.
    const event = { startMs: at("2026-08-21T09:00:00Z"), endMs: at("2026-08-21T15:30:00Z") };
    mocks.busy.set("one", [event]);
    mocks.busy.set("two", [event]);
    expect(onDay(await slots(), WEEK[4])).toHaveLength(3);
  });

  it("gives a hidden time back for every booking", async () => {
    teamLooksBusy("balanced");
    const before = onDay(await slots(), WEEK[2]);
    expect(before.length).toBeLessThan(16);

    mocks.bookings = [booking(before[3], ["one", "two"])];
    const after = onDay(await slots(), WEEK[2]);
    // Still as many to choose from: the booked one went, a hidden one came back.
    expect(after).toHaveLength(before.length);
    expect(after).not.toContain(before[3]);
    expect(before.filter((slot) => slot !== before[3]).every((slot) => after.includes(slot))).toBe(true);
  });

  it("keeps future choices and replaces expired ones as the minimum notice advances", async () => {
    teamLooksBusy("balanced");
    mocks.config.minNoticeMinutes = 60;
    let previous = onDay(await slots(), WEEK[0]);
    for (const hour of [10, 12, 14, 15, 16]) {
      const now = at(`2026-08-17T${hour}:00:00Z`);
      vi.setSystemTime(now);
      const earliest = now + 60 * MIN;
      const stillBookable = previous.filter((iso) => at(iso) >= earliest);
      const actualCount = Math.max(0, (17 - hour - 1) * 2);
      const shown = onDay(await slots(), WEEK[0]);
      expect(shown).toHaveLength(Math.min(4, actualCount));
      expect(shown).toEqual(expect.arrayContaining(stillBookable));
      expect(shown.every((iso) => at(iso) >= earliest)).toBe(true);
      previous = shown;
    }
  });

  it("hides the same times from a booker moving their call", async () => {
    teamLooksBusy("balanced");
    // Quorum 1, so one free member is enough for the page, and member two
    // is out on Wednesday afternoon.
    const chatLike = { config: { ...mocks.config, quorum: 1 } };
    mocks.busy.set("two", [{ startMs: at("2026-08-19T13:00:00Z"), endMs: at("2026-08-19T17:00:00Z") }]);
    const page = await slots(chatLike);
    // Moving a call with member two narrows the page to their free times,
    // after the hiding: exactly the page minus their afternoon.
    const narrowed = await slots({ ...chatLike, requiredMemberKeys: ["two"] });
    expect(narrowed).toEqual(
      page.filter(
        (slot) => !(at(slot) >= at("2026-08-19T13:00:00Z") && at(slot) < at("2026-08-19T17:00:00Z")),
      ),
    );
  });

  it("leaves personal pages alone", async () => {
    teamLooksBusy("packed");
    expect(await slots(personal(null))).toHaveLength(5 * 16);
  });

  it("is reported to the admin timeline, which still shows every real opening", async () => {
    teamLooksBusy("light");
    const timeline = await computeMemberBusyTimeline("2026-08-18", 1);
    expect(timeline.lookBusy).toBe("light");
    expect(timeline.slots).toHaveLength(16);
  });
});

describe("a personal page looking busy", () => {
  it("counts distinct real starts on a personal page when the clock skips an hour", async () => {
    vi.setSystemTime("2027-03-13T20:00:00Z");
    const date = "2027-03-14";
    const options = {
      hostKey: "one",
      config: {
        ...mocks.config,
        quorum: 1,
        hostTimezone: "America/Los_Angeles",
        bookableWeekdays: [7],
        windowStartMin: 0,
        windowEndMin: 4 * 60,
        lookBusy: "balanced" as const,
      },
    };
    // Midnight–4am spans three elapsed hours when LA jumps from 1:59 to 3am.
    const real = ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30"]
      .map((utc) => `${date}T${utc}:00.000Z`);
    const { response, lookBusy } = await computeAvailabilityPlan(date, 1, options);
    expect(lookBusy?.grid).toEqual(real.map(at));
    expect(response.slots).toHaveLength(4);
    expect(response.slots).toEqual([...new Set(response.slots)].sort());
    expect(response.slots.every((iso) => real.includes(iso))).toBe(true);

    // With just four actual openings, the duplicate local-hour candidates
    // must neither consume one of the choices nor appear twice in the result.
    mocks.busy.set("one", [{ startMs: at(real[0]), endMs: at(real[2]) }]);
    invalidateAvailabilityCache();
    expect((await computeAvailability(date, 1, options)).slots).toEqual(real.slice(2));
  });

  it("chooses times in the personal page's local zone, independently of the team's zone", async () => {
    const options = personal("balanced");
    const shown = await slots({
      ...options,
      config: { ...options.config!, hostTimezone: "America/Los_Angeles" },
    });
    // The test window is 9am–5pm Pacific and stays within the same UTC date.
    for (const date of WEEK) expect(onDay(shown, date)).toHaveLength(4);
    const clocks = shown.map((iso) => iso.slice(11, 16));
    expect(clocks.every((utc) => utc >= "16:00" && utc <= "23:30")).toBe(true);
    expect(clocks.some((utc) => utc >= "16:30" && utc <= "17:30")).toBe(true);
    expect(clocks.some((utc) => utc >= "21:00" && utc <= "22:00")).toBe(true);
  });

  it("shows every real opening when a personal meeting only offers two starts", async () => {
    const page = personal("packed");
    const window = { ...page.config!, windowStartMin: 9 * 60, windowEndMin: 10 * 60 };
    const shown = await slots({ ...page, config: window });
    const unfiltered = await slots({ ...page, config: { ...window, lookBusy: null } });
    expect(onDay(shown, WEEK[2])).toHaveLength(2);
    expect(shown).toEqual(unfiltered);
  });

  it("is not switched on by the team page, nor switches it on", async () => {
    teamLooksBusy(null);
    expect((await slots(personal("packed"))).length).toBeLessThan(5 * 16);
    expect(await slots()).toHaveLength(5 * 16);
  });

  it("hides a different pattern from the team page", async () => {
    teamLooksBusy("balanced");
    const team = await slots();
    const own = await slots(personal("balanced"));
    expect(own).not.toEqual(team);
  });

  it("gives times back as the owner's calendar fills, from any page", async () => {
    const before = onDay(await slots(personal("balanced")), WEEK[3]);
    // Bookings on another page still hold the owner (the overlay follows
    // attendees), so they count toward how busy the day looks.
    mocks.bookings = before.slice(0, 2).map((slot) => booking(slot, ["one"], "two"));
    const after = onDay(await slots(personal("balanced")), WEEK[3]);
    expect(after).toHaveLength(before.length);
    for (const slot of before.slice(2)) expect(after).toContain(slot);
  });
});

describe("the admin preview", () => {
  it("can judge a page at any level without saving it", async () => {
    const plan = await computeAvailabilityPlan("2026-08-17", 7, {
      ...personal(null),
      lookBusy: "packed",
    });
    expect(plan.lookBusy?.level).toBe("packed");
    expect(plan.lookBusy?.hidden.size).toBeGreaterThan(0);
    // The plan explains the public answer exactly.
    expect(plan.response.slots).toEqual(await slots(personal("packed")));
    const shown = new Set(plan.response.slots.map((slot) => at(slot)));
    for (const start of plan.lookBusy?.hidden ?? []) expect(shown.has(start)).toBe(false);
    for (const start of plan.lookBusy?.open ?? []) {
      if (!plan.lookBusy?.hidden.has(start)) expect(shown.has(start)).toBe(true);
    }
  });

  it("is never part of the public answer", async () => {
    teamLooksBusy("packed");
    const response = await computeAvailability("2026-08-17", 7);
    expect(Object.keys(response).sort()).toEqual(
      ["durationMinutes", "hostTimezone", "minNoticeMinutes", "slots"].sort(),
    );
  });
});

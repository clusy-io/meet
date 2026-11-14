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
import { lookBusyKey } from "@/lib/meet/lookBusy";
import { lookBusyShare } from "@/lib/meet/lookBusyLevels";

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

/** How many of a 16-slot empty day the level hides for this page. */
function expectedHidden(pageKey: string, level: LookBusyLevel, date: string): number {
  const daysAhead = (at(`${date}T00:00:00Z`) - at("2026-08-17T00:00:00Z")) / (24 * 60 * MIN);
  const wobble = lookBusyKey(pageKey, "test-secret").day(date);
  return Math.min(14, Math.floor(lookBusyShare(level, daysAhead, wobble) * 16));
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

  it("hides each empty day down to its level's look, busiest first", async () => {
    const all = await slots();
    teamLooksBusy("balanced");
    const shown = await slots();
    for (const date of WEEK) {
      expect(onDay(shown, date)).toHaveLength(16 - expectedHidden("", "balanced", date));
    }
    // Monday looks busier than Friday, the way a real week fills.
    expect(onDay(shown, WEEK[0]).length).toBeLessThan(onDay(shown, WEEK[4]).length);
    // Only ever a subset, and the same on the next request.
    expect(shown.every((slot) => all.includes(slot))).toBe(true);
    expect(await slots()).toEqual(shown);
  });

  it("hides more at Packed than at Light", async () => {
    teamLooksBusy("light");
    const light = await slots();
    teamLooksBusy("packed");
    const packed = await slots();
    expect(packed.length).toBeLessThan(light.length);
  });

  it("hides nothing on a day real meetings already make busy", async () => {
    teamLooksBusy("packed");
    // Both members are in meetings 09:00-14:00 on Friday: 10 of 16 taken.
    const morning = { startMs: at("2026-08-21T09:00:00Z"), endMs: at("2026-08-21T14:00:00Z") };
    mocks.busy.set("one", [morning]);
    mocks.busy.set("two", [morning]);
    expect(onDay(await slots(), WEEK[4])).toHaveLength(6);
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

  it("does not move hidden times as the day goes on", async () => {
    teamLooksBusy("balanced");
    mocks.config.minNoticeMinutes = 60;
    const morning = onDay(await slots(), WEEK[0]);

    // Two hours later the early morning has gone; the rest looks the same.
    vi.setSystemTime(at("2026-08-17T10:00:00Z"));
    const later = onDay(await slots(), WEEK[0]);
    const stillAhead = morning.filter((slot) => at(slot) >= at("2026-08-17T11:00:00Z"));
    expect(stillAhead.length).toBeGreaterThanOrEqual(2);
    expect(later).toEqual(stillAhead);
  });

  it("keeps two times open as today runs out, though it hid them earlier", async () => {
    teamLooksBusy("packed");
    mocks.config.minNoticeMinutes = 60;
    for (const hour of ["12", "13", "14", "15"]) {
      vi.setSystemTime(at(`2026-08-17T${hour}:00:00Z`));
      const left = onDay(await slots(), WEEK[0]);
      const bookable = 16 - (Number(hour) + 1 - 9) * 2;
      expect(left.length).toBeGreaterThanOrEqual(Math.min(2, bookable));
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
  it("follows the page's own level", async () => {
    const shown = await slots(personal("balanced"));
    for (const date of WEEK) {
      expect(onDay(shown, date)).toHaveLength(16 - expectedHidden("one", "balanced", date));
    }
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

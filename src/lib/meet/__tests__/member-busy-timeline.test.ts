import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusyInterval } from "@/lib/meet/types";

const mocks = vi.hoisted(() => ({
  config: {
    hostTimezone: "UTC", windowStartMin: 9 * 60, windowEndMin: 17 * 60,
    bookableWeekdays: [1, 2, 3, 4, 5], durationMinutes: 30, slotStepMinutes: 30,
    minNoticeMinutes: 0, horizonDays: 21,
    members: [
      { key: "baku", name: "Baku", email: "baku@example.com" },
      { key: "london", name: "London", email: "london@example.com" },
    ],
    quorum: 3, eventTitle: "Private", eventDescription: "Private", brandName: "Test",
    siteOrigin: "https://example.com", emailFrom: "Test <meet@example.com>",
    organizerEmail: null, adminSecret: null, tokenSecret: null, mockMode: false,
  },
  effective: vi.fn(), busy: vi.fn(), accounts: vi.fn(), pages: vi.fn(), bookings: vi.fn(), update: vi.fn(),
}));
vi.mock("@/lib/meet/config", () => ({ getMeetConfig: () => mocks.config }));
vi.mock("@/lib/meet/members", () => ({
  getEffectiveMeetConfig: mocks.effective,
  getRuntimeMeetConfig: vi.fn(() => Promise.reject(new Error("below quorum"))),
}));
vi.mock("@/lib/meet/crypto", () => ({ decryptSecret: (value: string) => value }));
vi.mock("@/lib/meet/providers", () => ({ getProvider: () => ({ getBusy: mocks.busy }) }));
vi.mock("@/lib/meet/store", () => ({ getMeetStore: () => ({
  listAccounts: mocks.accounts, listPageSettings: mocks.pages,
  listConfirmedBookingsInRange: mocks.bookings, updateAccount: mocks.update,
}) }));
import { computeMemberBusyTimeline } from "@/lib/meet/availability";

const page = (memberKey: string, timezone: string) => ({
  memberKey, enabled: true, headline: null, blurb: null, timezone, timezoneUntil: null,
  windowStartMin: 9 * 60, windowEndMin: 11 * 60, bookableWeekdays: [1, 2, 3, 4, 5],
  durationMinutes: null, slotStepMinutes: null, minNoticeMinutes: null, horizonDays: null,
  eventTitle: null, eventDescription: null, slackWebhookEnc: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-09-01T12:00:00Z")); vi.clearAllMocks();
  mocks.config.quorum = 3;
  mocks.config.minNoticeMinutes = 0;
  mocks.effective.mockResolvedValue(mocks.config);
  mocks.pages.mockResolvedValue([page("baku", "Asia/Baku"), page("london", "Europe/London")]);
  mocks.accounts.mockResolvedValue(mocks.config.members.map((member) => ({
    id: member.key, memberKey: member.key, provider: "google", email: `${member.key}@calendar.test`,
    refreshTokenEnc: member.key, selectedCalendars: [{ id: "private", name: "Private" }], status: "ok",
  })));
  mocks.bookings.mockResolvedValue([]);
  mocks.busy.mockResolvedValue([] as BusyInterval[]);
});
afterEach(() => vi.useRealTimers());

describe("member busy timeline", () => {
  it("uses below-quorum effective config and projects member grids", async () => {
    const result = await computeMemberBusyTimeline("2026-09-01", 1);
    expect(result.window).toEqual({ start: "5:00", end: "17:00" });
    expect(result.bookableDates).toEqual(["2026-09-01"]);
    expect(result.minNoticeMinutes).toBe(0);
    expect(result.members[0].eligibleStarts[0]).toBe("2026-09-01T05:00:00.000Z");
    expect(result.members[1].eligibleStarts[0]).toBe("2026-09-01T08:00:00.000Z");
    expect(result.members[0].working).toEqual([{
      startAt: "2026-09-01T05:00:00.000Z",
      endAt: "2026-09-01T07:00:00.000Z",
    }]);
    expect(result.slots).toEqual([]);
    expect(mocks.effective).toHaveBeenCalledOnce();
  });

  it("returns authoritative shared slots after notice and reservation rules", async () => {
    vi.setSystemTime(Date.parse("2026-09-01T08:00:00Z"));
    mocks.config.quorum = 2;
    mocks.config.minNoticeMinutes = 60;
    mocks.pages.mockResolvedValue([
      page("baku", "Europe/London"),
      page("london", "Europe/London"),
    ]);
    mocks.bookings.mockResolvedValue([{
      startAt: "2026-09-01T08:30:00.000Z",
      endAt: "2026-09-01T09:00:00.000Z",
      attendeeMemberKeys: ["baku", "london"],
      pageKey: "",
    }]);

    const result = await computeMemberBusyTimeline("2026-09-01", 1);
    expect(result.slots).toEqual([
      {
        startAt: "2026-09-01T09:00:00.000Z",
        endAt: "2026-09-01T09:30:00.000Z",
        freeMemberKeys: ["baku", "london"],
      },
      {
        startAt: "2026-09-01T09:30:00.000Z",
        endAt: "2026-09-01T10:00:00.000Z",
        freeMemberKeys: ["baku", "london"],
      },
    ]);
  });

  it("fails closed when calendars are unreadable", async () => {
    mocks.accounts.mockResolvedValue([]);
    const result = await computeMemberBusyTimeline("2026-09-01", 7);
    expect(result.bookableDates).toEqual([]);
    expect(result.slots).toEqual([]);
    expect(result.members.every((member) => member.status === "unavailable" && member.eligibleStarts.length === 0)).toBe(true);
  });
});

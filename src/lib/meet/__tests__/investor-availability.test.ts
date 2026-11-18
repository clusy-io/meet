import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeAvailability, invalidateAvailabilityCache } from "@/lib/meet/availability";
import { configForMeetingType } from "@/lib/meet/meetingTypes";

const mocks = vi.hoisted(() => ({
  config: {
    hostTimezone: "UTC",
    windowStartMin: 9 * 60, windowEndMin: 11 * 60 + 30,
    bookableWeekdays: [1, 2, 3, 4, 5, 6, 7],
    durationMinutes: 30, slotStepMinutes: 30, minNoticeMinutes: 0, horizonDays: 14,
    members: ["lead", "partner-a", "partner-b", "other"].map((key) => ({
      key, name: key, email: `${key}@example.com`,
    })),
    investor: {
      startDate: "2027-03-08", endDate: "2027-03-14",
      requiredMember: "lead", partners: ["partner-a", "partner-b"],
    },
    quorum: 2, eventTitle: "Call with {name}", eventDescription: "Test", brandName: "Test",
    siteOrigin: "https://example.com", emailFrom: "meet@example.com", organizerEmail: null,
    adminSecret: null, tokenSecret: null, cronSecret: null, mockMode: false,
  },
  accounts: vi.fn(), busy: vi.fn(), pages: vi.fn(), bookings: vi.fn(),
}));
vi.mock("@/lib/meet/config", () => ({ getMeetConfig: () => mocks.config }));
vi.mock("@/lib/meet/members", () => ({
  getEffectiveMeetConfig: async () => mocks.config,
  getRuntimeMeetConfig: async () => mocks.config,
}));
vi.mock("@/lib/meet/crypto", () => ({ decryptSecret: (value: string) => value }));
vi.mock("@/lib/meet/providers", () => ({ getProvider: () => ({ getBusy: mocks.busy }) }));
vi.mock("@/lib/meet/store", () => ({ getMeetStore: () => ({
  listAccounts: mocks.accounts, listPageSettings: mocks.pages, listConfirmedBookingsInRange: mocks.bookings,
}) }));

function connect(keys: string[]) {
  mocks.accounts.mockResolvedValue(keys.map((key) => ({
    id: key, memberKey: key, provider: "google", status: "ok",
    refreshTokenEnc: key, selectedCalendars: [{ id: "primary", name: "Primary" }],
  })));
}

function investor(from: string, days = 1, hostTimezone = "UTC") {
  const config = configForMeetingType({ ...mocks.config, hostTimezone }, "investor")!;
  return computeAvailability(from, days, { config, meetingType: "investor" });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-11-18T12:00:00Z");
  vi.resetAllMocks();
  invalidateAvailabilityCache();
  mocks.busy.mockResolvedValue([]);
  mocks.pages.mockResolvedValue([]);
  mocks.bookings.mockResolvedValue([]);
  connect(mocks.config.members.map(({ key }) => key));
});
afterEach(() => vi.useRealTimers());

describe("scheduled Investor meetings", () => {
  it("requires the designated lead with either eligible partner for the full 30 minutes", async () => {
    mocks.pages.mockResolvedValue([{ memberKey: "lead", windowEndMin: 11 * 60 }]);
    const busyStarts: Record<string, string[]> = {
      lead: ["09:45"], "partner-a": ["09:00", "10:30"], "partner-b": ["09:00", "10:00"],
    };
    mocks.busy.mockImplementation(async (key: string) => (busyStarts[key] ?? []).map((time) => {
      const startMs = Date.parse(`2027-03-08T${time}:00Z`);
      return { startMs, endMs: startMs + 15 * 60_000 };
    }));
    const day = await investor("2027-03-08");
    expect(day.durationMinutes).toBe(30);
    expect(day.slots).toEqual(["2027-03-08T10:00:00.000Z", "2027-03-08T10:30:00.000Z"]);
  });

  it("offers no Investor slot when the lead calendar is unavailable", async () => {
    connect(["partner-a", "partner-b", "other"]);
    expect((await investor("2027-03-08")).slots).toEqual([]);
  });

  it("honors configured civil dates across DST and overseas working hours", async () => {
    const zone = "America/Los_Angeles";
    mocks.pages.mockResolvedValue(mocks.config.members.map(({ key }) => ({
      memberKey: key, timezone: "Asia/Tokyo", windowStartMin: 15 * 60 + 15, windowEndMin: 17 * 60 + 45,
    })));
    expect((await investor("2027-03-08", 1, zone)).slots[0]).toBe("2027-03-08T08:15:00.000Z");
    // March 15 afternoon in Tokyo offers the last March 14 evening in Los Angeles.
    // 23:45 in LA cannot fit a whole meeting before the window closes.
    expect((await investor("2027-03-14", 1, zone)).slots.at(-1)).toBe("2027-03-15T06:15:00.000Z");
    expect((await investor("2027-03-07", 1, zone)).slots).toEqual([]);
    expect((await investor("2027-03-15", 1, zone)).slots).toEqual([]);
    const bounds = [Date.parse("2027-03-08T08:00:00.000Z"), Date.parse("2027-03-15T07:00:00.000Z")];
    expect(mocks.busy).toHaveBeenCalled();
    for (const call of mocks.busy.mock.calls) expect(call.slice(2)).toEqual(bounds);
    vi.setSystemTime("2028-03-08T00:00:00Z");
    expect((await investor("2028-03-08", 1, zone)).slots).toEqual([]);
  });
});

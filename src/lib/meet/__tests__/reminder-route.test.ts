import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking } from "@/lib/meet/types";

const mocks = vi.hoisted(() => {
  const members = [
    { key: "one", name: "One", email: "one@example.com" },
    { key: "two", name: "Two", email: "two@example.com" },
  ];
  return {
    config: {
      hostTimezone: "UTC",
      windowStartMin: 8 * 60,
      windowEndMin: 18 * 60,
      bookableWeekdays: [1, 2, 3, 4, 5],
      durationMinutes: 30,
      slotStepMinutes: 30,
      minNoticeMinutes: 0,
      horizonDays: 21,
      members,
      quorum: 2,
      eventTitle: "Call with {name}",
      eventDescription: "A test call",
      brandName: "Test",
      siteOrigin: "https://example.com",
      emailFrom: "Test <meet@example.com>",
      cronSecret: null,
      adminSecret: null,
      tokenSecret: null,
      mockMode: true,
    },
    sendReminder: vi.fn(),
    listUpcoming: vi.fn(),
    markSent: vi.fn(),
    listMemberRecords: vi.fn(),
    getPageSettings: vi.fn(),
  };
});

vi.mock("@/lib/meet/config", () => ({
  getMeetConfig: () => mocks.config,
}));
vi.mock("@/lib/meet/emails", () => ({
  sendBookingReminder: mocks.sendReminder,
}));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
    listMemberRecords: mocks.listMemberRecords,
    getPageSettings: mocks.getPageSettings,
    listConfirmedBookingsInRange: mocks.listUpcoming,
    markReminderSent: mocks.markSent,
  }),
}));

import { GET } from "@/app/api/meet/cron/reminders/route";

const START = Date.parse("2026-08-20T17:00:00.000Z");
const NOW = START - 23 * 3_600_000;

function booking(): Booking {
  return {
    id: "booking-1",
    pageKey: "",
    startAt: new Date(START).toISOString(),
    endAt: new Date(START + 30 * 60_000).toISOString(),
    durationMinutes: 30,
    name: "Booker",
    email: "booker@example.com",
    notes: null,
    timezone: "UTC",
    attendeeMemberKeys: ["one", "two"],
    guests: [],
    eventRefs: [],
    meetingUrl: null,
    status: "confirmed",
    manageToken: "secret-token",
    history: [],
    remindersSent: [],
    syncStatus: "synced",
    createdAt: new Date(START - 72 * 3_600_000).toISOString(),
    cancelledAt: null,
  };
}

describe("reminder route delivery ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.listUpcoming.mockResolvedValue([booking()]);
    mocks.markSent.mockResolvedValue(true);
    mocks.sendReminder.mockResolvedValue(undefined);
    mocks.listMemberRecords.mockResolvedValue([]);
    mocks.getPageSettings.mockResolvedValue(null);
  });

  afterEach(() => vi.restoreAllMocks());

  it("does not suppress a reminder when delivery fails", async () => {
    mocks.sendReminder.mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await GET(
      new Request("https://example.com/api/meet/cron/reminders"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ checked: 1, sent: 0, failures: ["booking-1:24h"] });
    expect(mocks.markSent).not.toHaveBeenCalled();
  });

  it("records a reminder only after successful delivery", async () => {
    const response = await GET(
      new Request("https://example.com/api/meet/cron/reminders"),
    );
    const body = await response.json();

    expect(body).toEqual({ checked: 1, sent: 1, failures: [] });
    expect(mocks.sendReminder).toHaveBeenCalledOnce();
    expect(mocks.markSent).toHaveBeenCalledWith("booking-1", "24h");
    expect(mocks.sendReminder.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markSent.mock.invocationCallOrder[0],
    );
  });

  it("excludes an archived member from a later team reminder", async () => {
    const laterBooking = booking();
    laterBooking.attendeeMemberKeys = ["one"];
    mocks.listUpcoming.mockResolvedValue([laterBooking]);
    mocks.listMemberRecords.mockResolvedValue([
      {
        key: "two",
        name: "Two",
        email: "two@example.com",
        archivedAt: "2026-08-10T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ]);

    const response = await GET(
      new Request("https://example.com/api/meet/cron/reminders"),
    );

    expect(response.status).toBe(200);
    expect(mocks.sendReminder.mock.calls[0]?.[1]).toEqual([
      { key: "one", name: "One", email: "one@example.com" },
    ]);
    expect(mocks.sendReminder.mock.calls[0]?.[4].members).toEqual([
      { key: "one", name: "One", email: "one@example.com" },
    ]);
  });

  it("keeps an archived personal-page owner for reminder delivery", async () => {
    const personalBooking = booking();
    personalBooking.pageKey = "two";
    personalBooking.attendeeMemberKeys = ["two"];
    mocks.listUpcoming.mockResolvedValue([personalBooking]);
    mocks.listMemberRecords.mockResolvedValue([
      {
        key: "two",
        name: "Two Historical",
        email: "two-old@example.com",
        archivedAt: "2026-08-10T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ]);

    const response = await GET(
      new Request("https://example.com/api/meet/cron/reminders"),
    );

    expect(response.status).toBe(200);
    expect(mocks.sendReminder.mock.calls[0]?.[1]).toEqual([
      { key: "two", name: "Two Historical", email: "two-old@example.com" },
    ]);
    expect(mocks.sendReminder.mock.calls[0]?.[4].members).toContainEqual({
      key: "two",
      name: "Two Historical",
      email: "two-old@example.com",
    });
  });
});

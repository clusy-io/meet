import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking, Member } from "@/lib/meet/types";

const mocks = vi.hoisted(() => ({
  sendReminder: vi.fn(),
  listUpcoming: vi.fn(),
  markSent: vi.fn(),
}));

vi.mock("@/lib/meet/config", () => ({
  getMeetConfig: () => ({
    mockMode: true,
    cronSecret: null,
    members: [
      { key: "one", name: "One", email: "one@example.com" },
      { key: "two", name: "Two", email: "two@example.com" },
    ] satisfies Member[],
  }),
}));
vi.mock("@/lib/meet/emails", () => ({ sendBookingReminder: mocks.sendReminder }));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
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
  });

  afterEach(() => vi.restoreAllMocks());

  it("does not suppress a reminder when delivery fails", async () => {
    mocks.sendReminder.mockRejectedValueOnce(new Error("provider unavailable"));

    const response = await GET(new Request("https://example.com/api/meet/cron/reminders"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ checked: 1, sent: 0, failures: ["booking-1:24h"] });
    expect(mocks.markSent).not.toHaveBeenCalled();
  });

  it("records a reminder only after successful delivery", async () => {
    const response = await GET(new Request("https://example.com/api/meet/cron/reminders"));
    const body = await response.json();

    expect(body).toEqual({ checked: 1, sent: 1, failures: [] });
    expect(mocks.sendReminder).toHaveBeenCalledOnce();
    expect(mocks.markSent).toHaveBeenCalledWith("booking-1", "24h");
    expect(mocks.sendReminder.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markSent.mock.invocationCallOrder[0]
    );
  });
});

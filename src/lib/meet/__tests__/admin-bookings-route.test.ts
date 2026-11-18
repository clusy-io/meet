import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking } from "@/lib/meet/types";

const mocks = vi.hoisted(() => ({
  listBookingsStartingInRange: vi.fn(),
  investor: undefined as { startDate: string; endDate: string } | undefined,
}));

vi.mock("@/lib/meet/admin", () => ({ requireAdmin: () => true }));
vi.mock("@/lib/meet/config", () => ({
  getMeetConfig: () => ({
    hostTimezone: "Europe/London",
    siteOrigin: "https://meet.example.com",
    investor: mocks.investor,
    members: [{ key: "ava", name: "Ava", email: "ava@example.com" }],
  }),
}));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
    listMemberRecords: async () => [],
    listBookingsStartingInRange: mocks.listBookingsStartingInRange,
  }),
}));

import { GET } from "@/app/api/meet/admin/bookings/route";

function booking(): Booking {
  return {
    id: "booking-1",
    pageKey: "ava",
    startAt: "2026-09-03T09:00:00.000Z",
    endAt: "2026-09-03T09:30:00.000Z",
    durationMinutes: 30,
    name: "Booker",
    email: "booker@example.com",
    guests: [],
    notes: null,
    timezone: "Europe/London",
    attendeeMemberKeys: ["ava"],
    eventRefs: [],
    meetingUrl: "https://meet.example.com/call",
    status: "confirmed",
    manageToken: "private-token",
    history: [
      {
        startAt: "2026-09-02T09:00:00.000Z",
        endAt: "2026-09-02T09:30:00.000Z",
        changedAt: "2026-08-30T12:00:00.000Z",
      },
    ],
    remindersSent: [],
    syncStatus: "synced",
    createdAt: "2026-08-28T12:00:00.000Z",
    cancelledAt: null,
  };
}

describe("admin bookings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.investor = undefined;
    mocks.listBookingsStartingInRange.mockResolvedValue([booking()]);
  });

  it("includes the investor window when it is beyond the 120-day agenda", async () => {
    mocks.investor = { startDate: "2099-03-01", endDate: "2099-03-21" };
    const investor = {
      ...booking(),
      id: "investor-booking",
      pageKey: "",
      meetingType: "investor",
      startAt: "2099-03-02T09:00:00Z",
      endAt: "2099-03-02T09:30:00Z",
    };
    mocks.listBookingsStartingInRange.mockResolvedValueOnce([booking()]).mockResolvedValueOnce([investor]);
    const response = await GET(new Request("https://meet.example.com/api/meet/admin/bookings"));

    expect(mocks.listBookingsStartingInRange.mock.calls[1]).toEqual([
      Date.parse("2099-03-01T00:00:00Z"),
      Date.parse("2099-03-22T00:00:00Z"),
    ]);
    const { bookings } = await response.json();
    expect(bookings).toHaveLength(2);
    expect(bookings[1]).toMatchObject({ id: "investor-booking", meetingType: "investor" });
  });

  it("projects the complete reschedule history for the schedule audit trail", async () => {
    const response = await GET(
      new Request("https://meet.example.com/api/meet/admin/bookings"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bookings[0]).toMatchObject({
      rescheduleCount: 1,
      history: booking().history,
      manageUrl: "https://meet.example.com/manage/private-token",
    });
  });
});

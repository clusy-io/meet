import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking } from "@/lib/meet/types";

const mocks = vi.hoisted(() => ({
  listBookingsStartingInRange: vi.fn(),
}));

vi.mock("@/lib/meet/admin", () => ({ requireAdmin: () => true }));
vi.mock("@/lib/meet/config", () => ({
  getMeetConfig: () => ({
    hostTimezone: "Europe/London",
    siteOrigin: "https://meet.example.com",
    members: [{ key: "ava", name: "Ava", email: "ava@example.com" }],
  }),
}));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
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
    mocks.listBookingsStartingInRange.mockResolvedValue([booking()]);
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

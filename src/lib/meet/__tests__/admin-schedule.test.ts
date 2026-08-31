import { describe, expect, it } from "vitest";
import type { AdminBooking } from "@/components/meet/admin/types";
import {
  bookingNeedsAttention,
  civilDateKey,
  filterScheduleBookings,
  groupScheduleBookings,
  hostLabel,
  nextBooking,
  scheduleCounts,
  type ScheduleFilters,
} from "@/components/meet/admin/schedule";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const MEMBERS = [
  { key: "ava", name: "Ava", email: "ava@example.com" },
  { key: "sam", name: "Sam", email: "sam@example.com" },
];

function booking(
  id: string,
  startAt: string,
  overrides: Partial<AdminBooking> = {},
): AdminBooking {
  const startMs = Date.parse(startAt);
  return {
    id,
    startAt,
    endAt: new Date(startMs + 30 * 60_000).toISOString(),
    durationMinutes: 30,
    name: `Booker ${id}`,
    email: `${id}@example.com`,
    guests: [],
    notes: null,
    timezone: "America/New_York",
    attendeeMemberKeys: ["ava"],
    meetingUrl: `https://meet.example.com/${id}`,
    status: "confirmed",
    syncStatus: "synced",
    history: [],
    remindersSent: [],
    manageUrl: `https://example.com/manage/${id}`,
    createdAt: "2026-08-01T12:00:00.000Z",
    cancelledAt: null,
    ...overrides,
  };
}

const DEFAULT_FILTERS: ScheduleFilters = {
  search: "",
  timeframe: "upcoming",
  host: "all",
  status: "confirmed",
};

describe("admin schedule helpers", () => {
  it("groups instants by the host's civil date", () => {
    expect(civilDateKey("2026-09-01T00:30:00.000Z", "America/Los_Angeles"))
      .toBe("2026-08-31");
    expect(civilDateKey("2026-09-01T00:30:00.000Z", "Asia/Tokyo"))
      .toBe("2026-09-01");
  });

  it("keeps cancelled calls out of the default operational agenda", () => {
    const confirmed = booking("confirmed", "2026-09-01T15:00:00.000Z");
    const cancelled = booking("cancelled", "2026-09-01T16:00:00.000Z", {
      status: "cancelled",
      cancelledAt: "2026-08-31T09:00:00.000Z",
    });

    expect(
      filterScheduleBookings(
        [cancelled, confirmed],
        MEMBERS,
        "UTC",
        DEFAULT_FILTERS,
        NOW,
      ).map((item) => item.id),
    ).toEqual(["confirmed"]);
  });

  it("treats only future confirmed sync failures as attention items", () => {
    const upcoming = booking("upcoming", "2026-09-01T15:00:00.000Z", {
      syncStatus: "partial",
    });
    const past = booking("past", "2026-08-31T15:00:00.000Z", {
      syncStatus: "failed",
    });
    const cancelled = booking("cancelled", "2026-09-01T16:00:00.000Z", {
      status: "cancelled",
      syncStatus: "failed",
    });

    expect(bookingNeedsAttention(upcoming, NOW)).toBe(true);
    expect(bookingNeedsAttention(past, NOW)).toBe(false);
    expect(bookingNeedsAttention(cancelled, NOW)).toBe(false);
  });

  it("searches booker, guests, notes, and resolved host names", () => {
    const detailed = booking("detail", "2026-09-01T15:00:00.000Z", {
      name: "Riley North",
      guests: ["guest@elsewhere.test"],
      notes: "Discuss the launch plan",
      attendeeMemberKeys: ["sam"],
    });

    for (const search of ["riley", "elsewhere", "launch plan", "sam"]) {
      expect(
        filterScheduleBookings(
          [detailed],
          MEMBERS,
          "UTC",
          { ...DEFAULT_FILTERS, search },
          NOW,
        ),
      ).toHaveLength(1);
    }
    expect(hostLabel(detailed, MEMBERS)).toBe("Sam");
  });

  it("sorts future calls forward and past calls newest first", () => {
    const earlier = booking("earlier", "2026-08-30T15:00:00.000Z");
    const later = booking("later", "2026-08-31T15:00:00.000Z");
    expect(
      filterScheduleBookings(
        [earlier, later],
        MEMBERS,
        "UTC",
        { ...DEFAULT_FILTERS, timeframe: "past" },
        NOW,
      ).map((item) => item.id),
    ).toEqual(["later", "earlier"]);
  });

  it("keeps every previous time available for the expanded audit trail", () => {
    const history = [
      {
        startAt: "2026-09-01T13:00:00.000Z",
        endAt: "2026-09-01T13:30:00.000Z",
        changedAt: "2026-08-29T10:00:00.000Z",
      },
      {
        startAt: "2026-09-01T14:00:00.000Z",
        endAt: "2026-09-01T14:30:00.000Z",
        changedAt: "2026-08-30T10:00:00.000Z",
      },
    ];
    const moved = booking("moved", "2026-09-01T15:00:00.000Z", {
      history,
    });

    const [visible] = filterScheduleBookings(
      [moved],
      MEMBERS,
      "UTC",
      DEFAULT_FILTERS,
      NOW,
    );
    expect(visible.history).toEqual(history);
  });

  it("calculates host-local headline counts and excludes cancellations", () => {
    const rows = [
      booking("today", "2026-09-01T23:30:00.000Z"),
      booking("day-six", "2026-09-07T15:00:00.000Z", {
        syncStatus: "failed",
      }),
      booking("day-seven", "2026-09-08T15:00:00.000Z"),
      booking("cancelled", "2026-09-01T18:00:00.000Z", {
        status: "cancelled",
      }),
    ];
    expect(scheduleCounts(rows, "UTC", NOW)).toEqual({
      today: 1,
      nextSevenDays: 2,
      needsAttention: 1,
    });
  });

  it("does not count or filter meetings that already ended today as next 7 days", () => {
    const ended = booking("ended", "2026-09-01T09:00:00.000Z");
    const inProgress = booking("in-progress", "2026-09-01T11:45:00.000Z", {
      endAt: "2026-09-01T12:15:00.000Z",
    });

    expect(scheduleCounts([ended, inProgress], "UTC", NOW).nextSevenDays).toBe(1);
    expect(
      filterScheduleBookings(
        [ended, inProgress],
        MEMBERS,
        "UTC",
        { ...DEFAULT_FILTERS, timeframe: "7d" },
        NOW,
      ).map((item) => item.id),
    ).toEqual(["in-progress"]);
  });

  it("finds the next confirmed call and groups a sorted agenda", () => {
    const first = booking("first", "2026-09-01T13:00:00.000Z");
    const second = booking("second", "2026-09-01T15:00:00.000Z");
    const tomorrow = booking("tomorrow", "2026-09-02T13:00:00.000Z");
    const cancelled = booking("cancelled", "2026-09-01T12:30:00.000Z", {
      status: "cancelled",
    });

    expect(nextBooking([second, cancelled, first], NOW)?.id).toBe("first");
    expect(groupScheduleBookings([first, second, tomorrow], "UTC")).toEqual([
      { dateKey: "2026-09-01", bookings: [first, second] },
      { dateKey: "2026-09-02", bookings: [tomorrow] },
    ]);
  });
});

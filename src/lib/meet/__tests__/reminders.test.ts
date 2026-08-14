import { describe, expect, it } from "vitest";
import { dueReminderKinds, reminderPhrase } from "@/lib/meet/reminders";
import type { Booking } from "@/lib/meet/types";

const START = Date.parse("2026-08-20T17:00:00.000Z");
const H = 3_600_000;

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "b1",
    pageKey: "",
    startAt: new Date(START).toISOString(),
    endAt: new Date(START + 30 * 60_000).toISOString(),
    durationMinutes: 30,
    name: "Test",
    email: "t@example.com",
    notes: null,
    timezone: "UTC",
    attendeeMemberKeys: ["ava", "ben"],
    guests: [],
    eventRefs: [],
    meetingUrl: null,
    status: "confirmed",
    manageToken: "tok",
    history: [],
    remindersSent: [],
    syncStatus: "synced",
    createdAt: new Date(START - 72 * H).toISOString(),
    cancelledAt: null,
    ...overrides,
  };
}

describe("dueReminderKinds", () => {
  it("sends nothing outside every window", () => {
    expect(dueReminderKinds(booking(), START - 30 * H)).toEqual([]);
  });

  it("24h reminder due inside its window, 1h not yet", () => {
    expect(dueReminderKinds(booking(), START - 23 * H)).toEqual(["24h"]);
  });

  it("both due close to start when neither was sent", () => {
    expect(dueReminderKinds(booking(), START - 30 * 60_000)).toEqual(["24h", "1h"]);
  });

  it("already-sent kinds are excluded", () => {
    expect(dueReminderKinds(booking({ remindersSent: ["24h"] }), START - 30 * 60_000)).toEqual([
      "1h",
    ]);
  });

  it("nothing after the meeting started", () => {
    expect(dueReminderKinds(booking(), START)).toEqual([]);
    expect(dueReminderKinds(booking(), START + H)).toEqual([]);
  });

  it("nothing for cancelled bookings", () => {
    expect(dueReminderKinds(booking({ status: "cancelled" }), START - 23 * H)).toEqual([]);
  });

  it("24h reminder skipped when booked inside the window (confirmation just went out)", () => {
    const justBooked = booking({ createdAt: new Date(START - 24 * H + 60_000).toISOString() });
    expect(dueReminderKinds(justBooked, START - 23 * H)).toEqual([]);
    // But the 1h reminder still fires later.
    expect(dueReminderKinds(justBooked, START - 30 * 60_000)).toEqual(["1h"]);
  });

  it("24h reminder fires when booked with more than a day plus grace to spare", () => {
    const early = booking({ createdAt: new Date(START - 26 * H).toISOString() });
    expect(dueReminderKinds(early, START - 23 * H)).toEqual(["24h"]);
  });
});

describe("reminderPhrase", () => {
  it("maps kinds to copy", () => {
    expect(reminderPhrase("24h")).toBe("tomorrow");
    expect(reminderPhrase("1h")).toBe("in one hour");
    expect(reminderPhrase("weird")).toBe("soon");
  });
});

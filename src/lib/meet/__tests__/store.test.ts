import { describe, expect, it } from "vitest";
import { MemoryMeetStore } from "@/lib/meet/store";
import type { Booking, CalendarAccount } from "@/lib/meet/types";

let seq = 0;

/** Minimal valid Booking; overrides pick the fields a test cares about. */
function makeBooking(overrides: Partial<Booking> = {}): Booking {
  seq += 1;
  return {
    id: `bk-${seq}`,
    pageKey: "",
    startAt: "2026-08-20T15:30:00.000Z",
    endAt: "2026-08-20T16:00:00.000Z",
    durationMinutes: 30,
    name: "Test Booker",
    email: "booker@example.com",
    notes: null,
    timezone: "America/Los_Angeles",
    attendeeMemberKeys: ["ava", "ben"],
    guests: [],
    eventRefs: [],
    meetingUrl: null,
    status: "confirmed",
    manageToken: `tok-${seq}`,
    history: [],
    remindersSent: [],
    syncStatus: "synced",
    createdAt: "2026-08-12T00:00:00.000Z",
    cancelledAt: null,
    ...overrides,
  };
}

function makeAccountInput(
  overrides: Partial<Omit<CalendarAccount, "id" | "createdAt" | "updatedAt">> = {}
): Omit<CalendarAccount, "id" | "createdAt" | "updatedAt"> {
  return {
    memberKey: "ava",
    provider: "google",
    email: "ava@example.com",
    refreshTokenEnc: "enc-1",
    selectedCalendars: [{ id: "primary", name: "Primary" }],
    status: "ok",
    ...overrides,
  };
}

describe("MemoryMeetStore bookings", () => {
  it("rejects a second confirmed booking at the same startAt", async () => {
    const store = new MemoryMeetStore();
    expect(await store.insertBooking(makeBooking())).toEqual({ ok: true });
    expect(await store.insertBooking(makeBooking())).toEqual({
      ok: false,
      reason: "slot_taken",
    });
  });

  it("frees the slot when the holding booking is cancelled", async () => {
    const store = new MemoryMeetStore();
    const first = makeBooking();
    await store.insertBooking(first);
    await store.updateBooking(first.id, {
      status: "cancelled",
      cancelledAt: "2026-08-13T00:00:00.000Z",
    });
    expect(await store.insertBooking(makeBooking())).toEqual({ ok: true });
  });

  it("updateBookingTime fails with slot_taken on an occupied start and leaves the booking untouched", async () => {
    const store = new MemoryMeetStore();
    const a = makeBooking({ startAt: "2026-08-20T15:30:00.000Z", endAt: "2026-08-20T16:00:00.000Z" });
    const b = makeBooking({ startAt: "2026-08-20T16:00:00.000Z", endAt: "2026-08-20T16:30:00.000Z" });
    await store.insertBooking(a);
    await store.insertBooking(b);
    const result = await store.updateBookingTime(
      a.id,
      a.startAt,
      b.startAt,
      "2026-08-20T16:30:00.000Z",
      [{ startAt: a.startAt, endAt: a.endAt, changedAt: "2026-08-13T00:00:00.000Z" }]
    );
    expect(result).toEqual({ ok: false, reason: "slot_taken" });
    const unchanged = await store.getBookingByToken(a.manageToken);
    expect(unchanged?.startAt).toBe("2026-08-20T15:30:00.000Z");
    expect(unchanged?.history).toEqual([]);
  });

  it("updateBookingTime succeeds on a free start and rewrites history", async () => {
    const store = new MemoryMeetStore();
    const a = makeBooking();
    await store.insertBooking(a);
    const history: Booking["history"] = [
      { startAt: a.startAt, endAt: a.endAt, changedAt: "2026-08-13T00:00:00.000Z" },
    ];
    const result = await store.updateBookingTime(
      a.id,
      a.startAt,
      "2026-08-21T15:30:00.000Z",
      "2026-08-21T16:00:00.000Z",
      history
    );
    expect(result).toEqual({ ok: true });
    const moved = await store.getBookingByToken(a.manageToken);
    expect(moved?.startAt).toBe("2026-08-21T15:30:00.000Z");
    expect(moved?.endAt).toBe("2026-08-21T16:00:00.000Z");
    expect(moved?.history).toEqual(history);
  });

  it("allows only one reschedule from the same expected start", async () => {
    const store = new MemoryMeetStore();
    const booking = makeBooking();
    await store.insertBooking(booking);

    const firstStart = "2026-08-21T15:30:00.000Z";
    const secondStart = "2026-08-22T15:30:00.000Z";
    expect(
      await store.updateBookingTime(
        booking.id,
        booking.startAt,
        firstStart,
        "2026-08-21T16:00:00.000Z",
        []
      )
    ).toEqual({ ok: true });
    expect(
      await store.updateBookingTime(
        booking.id,
        booking.startAt,
        secondStart,
        "2026-08-22T16:00:00.000Z",
        []
      )
    ).toEqual({ ok: false, reason: "stale" });

    expect((await store.getBookingByToken(booking.manageToken))?.startAt).toBe(firstStart);
  });

  it("updateBookingTime on a cancelled booking fails with not_confirmed", async () => {
    const store = new MemoryMeetStore();
    const a = makeBooking({ status: "cancelled", cancelledAt: "2026-08-13T00:00:00.000Z" });
    await store.insertBooking(a);
    const result = await store.updateBookingTime(
      a.id,
      a.startAt,
      "2026-08-21T15:30:00.000Z",
      "2026-08-21T16:00:00.000Z",
      [{ startAt: a.startAt, endAt: a.endAt, changedAt: "2026-08-13T00:00:00.000Z" }]
    );
    expect(result).toEqual({ ok: false, reason: "not_confirmed" });
  });

  it("transitionToCancelled succeeds once and is false on a repeat call", async () => {
    const store = new MemoryMeetStore();
    const a = makeBooking();
    await store.insertBooking(a);
    expect(await store.transitionToCancelled(a.id, "2026-08-13T00:00:00.000Z")).toBe(true);
    expect(await store.transitionToCancelled(a.id, "2026-08-13T00:00:00.000Z")).toBe(false);
  });

  it("updateBookingTime fails with not_confirmed after transitionToCancelled", async () => {
    const store = new MemoryMeetStore();
    const a = makeBooking();
    await store.insertBooking(a);
    await store.transitionToCancelled(a.id, "2026-08-13T00:00:00.000Z");
    const result = await store.updateBookingTime(
      a.id,
      a.startAt,
      "2026-08-21T15:30:00.000Z",
      "2026-08-21T16:00:00.000Z",
      [{ startAt: a.startAt, endAt: a.endAt, changedAt: "2026-08-13T00:00:00.000Z" }]
    );
    expect(result).toEqual({ ok: false, reason: "not_confirmed" });
  });
});

describe("MemoryMeetStore accounts", () => {
  it("upsertAccount dedupes on (memberKey, provider, email)", async () => {
    const store = new MemoryMeetStore();
    const first = await store.upsertAccount(makeAccountInput({ refreshTokenEnc: "enc-1" }));
    const second = await store.upsertAccount(makeAccountInput({ refreshTokenEnc: "enc-2" }));
    expect(second.id).toBe(first.id);
    expect(second.refreshTokenEnc).toBe("enc-2");
    expect(await store.listAccounts()).toHaveLength(1);
  });

  it("upsertAccount creates a new row when any key field differs", async () => {
    const store = new MemoryMeetStore();
    const first = await store.upsertAccount(makeAccountInput());
    const other = await store.upsertAccount(makeAccountInput({ email: "ava.work@example.com" }));
    expect(other.id).not.toBe(first.id);
    const third = await store.upsertAccount(makeAccountInput({ provider: "microsoft" }));
    expect(third.id).not.toBe(first.id);
    expect(await store.listAccounts()).toHaveLength(3);
  });
});

describe("MemoryMeetStore listConfirmedBookingsInRange", () => {
  const start = Date.parse("2026-08-20T15:30:00.000Z");
  const end = Date.parse("2026-08-20T16:00:00.000Z");

  async function seeded(): Promise<MemoryMeetStore> {
    const store = new MemoryMeetStore();
    await store.insertBooking(makeBooking());
    return store;
  }

  it("includes a booking exactly covering the range", async () => {
    const store = await seeded();
    expect(await store.listConfirmedBookingsInRange(start, end)).toHaveLength(1);
  });

  it("excludes a range ending exactly at the booking start (half-open)", async () => {
    const store = await seeded();
    expect(await store.listConfirmedBookingsInRange(start - 3_600_000, start)).toHaveLength(0);
  });

  it("excludes a range starting exactly at the booking end (half-open)", async () => {
    const store = await seeded();
    expect(await store.listConfirmedBookingsInRange(end, end + 3_600_000)).toHaveLength(0);
  });

  it("includes partial overlaps on both sides", async () => {
    const store = await seeded();
    expect(await store.listConfirmedBookingsInRange(start - 60_000, start + 60_000)).toHaveLength(1);
    expect(await store.listConfirmedBookingsInRange(end - 60_000, end + 60_000)).toHaveLength(1);
  });

  it("excludes cancelled bookings", async () => {
    const store = new MemoryMeetStore();
    await store.insertBooking(
      makeBooking({ status: "cancelled", cancelledAt: "2026-08-13T00:00:00.000Z" })
    );
    expect(await store.listConfirmedBookingsInRange(start, end)).toHaveLength(0);
  });
});

describe("MemoryMeetStore reminders", () => {
  it("markReminderSent wins once per kind and loses on cancelled bookings", async () => {
    const store = new MemoryMeetStore();
    const booking = makeBooking();
    await store.insertBooking(booking);

    expect(await store.markReminderSent(booking.id, "24h")).toBe(true);
    expect(await store.markReminderSent(booking.id, "24h")).toBe(false);
    expect(await store.markReminderSent(booking.id, "1h")).toBe(true);

    await store.transitionToCancelled(booking.id, "2026-08-13T00:00:00.000Z");
    expect(await store.markReminderSent(booking.id, "weird")).toBe(false);
  });

  it("rescheduling clears sent reminders so they re-arm for the new time", async () => {
    const store = new MemoryMeetStore();
    const booking = makeBooking();
    await store.insertBooking(booking);
    await store.markReminderSent(booking.id, "24h");

    const moved = await store.updateBookingTime(
      booking.id,
      booking.startAt,
      "2026-08-21T15:30:00.000Z",
      "2026-08-21T16:00:00.000Z",
      []
    );
    expect(moved.ok).toBe(true);
    expect(await store.markReminderSent(booking.id, "24h")).toBe(true);
  });
});

describe("MemoryMeetStore listBookingsStartingInRange", () => {
  const start = Date.parse("2026-08-20T15:30:00.000Z");

  it("keeps cancelled bookings, unlike the availability listing", async () => {
    const store = new MemoryMeetStore();
    await store.insertBooking(
      makeBooking({ status: "cancelled", cancelledAt: "2026-08-13T00:00:00.000Z" })
    );
    expect(await store.listBookingsStartingInRange(start - 1, start + 1)).toHaveLength(1);
  });

  it("filters on the start instant, half-open, and sorts ascending", async () => {
    const store = new MemoryMeetStore();
    const later = makeBooking({
      startAt: "2026-08-21T15:30:00.000Z",
      endAt: "2026-08-21T16:00:00.000Z",
    });
    await store.insertBooking(later);
    await store.insertBooking(makeBooking());

    const all = await store.listBookingsStartingInRange(start, start + 2 * 86_400_000);
    expect(all.map((b) => b.startAt)).toEqual([
      "2026-08-20T15:30:00.000Z",
      "2026-08-21T15:30:00.000Z",
    ]);
    // A booking underway at `from` is out: the range is on start, not overlap.
    expect(await store.listBookingsStartingInRange(start + 1, start + 60_000)).toHaveLength(0);
  });
});

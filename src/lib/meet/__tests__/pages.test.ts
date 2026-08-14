import { describe, expect, it } from "vitest";
import type { MeetConfig } from "@/lib/meet/config";
import { availableSlots, type SlotCandidate } from "@/lib/meet/slots";
import { MemoryMeetStore } from "@/lib/meet/store";
import type { Booking, BusyInterval } from "@/lib/meet/types";

/**
 * Invariants that make personal pages (/meet/ju) independent of the team page
 * and of each other. Everything here is either pure or runs against
 * MemoryMeetStore, so no env, no config cache, no network.
 */

const LA = "America/Los_Angeles";

const config: MeetConfig = {
  hostTimezone: LA,
  windowStartMin: 510,
  windowEndMin: 1320,
  bookableWeekdays: [1, 2, 3, 4, 5],
  durationMinutes: 30,
  slotStepMinutes: 30,
  minNoticeMinutes: 0,
  horizonDays: 21,
  members: [
    { key: "ju", name: "Ju", email: "ju@example.com" },
    { key: "eldar", name: "Eldar", email: "eldar@example.com" },
    { key: "fouzil", name: "Fouzil", email: "fouzil@example.com" },
  ],
  quorum: 2,
  eventTitle: "Test <> {name}",
  eventDescription: "Test event",
  brandName: "Test",
  siteOrigin: "https://example.com",
  emailFrom: "Test <meet@example.com>",
  cronSecret: null,
  adminSecret: null,
  tokenSecret: null,
  mockMode: true,
};

const START_MS = Date.parse("2026-08-20T17:00:00.000Z"); // a Thursday, 10:00 LA
const SLOT: SlotCandidate = { startMs: START_MS, endMs: START_MS + 30 * 60_000 };

let seq = 0;
function makeBooking(overrides: Partial<Booking> = {}): Booking {
  seq += 1;
  return {
    id: `bk-${seq}`,
    pageKey: "",
    startAt: new Date(START_MS).toISOString(),
    endAt: new Date(START_MS + 30 * 60_000).toISOString(),
    durationMinutes: 30,
    name: "Booker",
    email: "booker@example.com",
    notes: null,
    timezone: LA,
    attendeeMemberKeys: ["ju", "eldar", "fouzil"],
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

describe("availableSlots quorum override", () => {
  it("offers a slot to a personal page when only that one member is free", () => {
    const busy = new Map<string, BusyInterval[]>([["ju", []]]);
    const slots = availableSlots(config, [SLOT], busy, START_MS - 1, 1);
    expect(slots).toHaveLength(1);
    expect(slots[0].freeMemberKeys).toEqual(["ju"]);
  });

  it("withholds the slot when that member is busy", () => {
    const busy = new Map<string, BusyInterval[]>([
      ["ju", [{ startMs: SLOT.startMs, endMs: SLOT.endMs }]],
    ]);
    expect(availableSlots(config, [SLOT], busy, START_MS - 1, 1)).toHaveLength(0);
  });

  it("fails CLOSED when the host's calendar could not be read", () => {
    // An unreadable calendar means the member is absent from the map, never
    // that they are free. Personal pages have no quorum to absorb this, so an
    // empty map must produce zero slots rather than a wide-open day.
    const busy = new Map<string, BusyInterval[]>();
    expect(availableSlots(config, [SLOT], busy, START_MS - 1, 1)).toHaveLength(0);
  });

  it("still applies the config quorum when none is passed", () => {
    const busy = new Map<string, BusyInterval[]>([["ju", []]]);
    expect(availableSlots(config, [SLOT], busy, START_MS - 1)).toHaveLength(0);
  });
});

describe("per-page slot uniqueness", () => {
  it("lets two different pages hold the same start time", async () => {
    const store = new MemoryMeetStore();
    expect(await store.insertBooking(makeBooking({ pageKey: "ju" }))).toEqual({ ok: true });
    expect(await store.insertBooking(makeBooking({ pageKey: "eldar" }))).toEqual({ ok: true });
  });

  it("still rejects two bookings on the SAME page at one start time", async () => {
    const store = new MemoryMeetStore();
    expect(await store.insertBooking(makeBooking({ pageKey: "ju" }))).toEqual({ ok: true });
    expect(await store.insertBooking(makeBooking({ pageKey: "ju" }))).toEqual({
      ok: false,
      reason: "slot_taken",
    });
  });

  it("keeps the team page's one-booking-per-slot rule", async () => {
    const store = new MemoryMeetStore();
    expect(await store.insertBooking(makeBooking())).toEqual({ ok: true });
    expect(await store.insertBooking(makeBooking())).toEqual({
      ok: false,
      reason: "slot_taken",
    });
  });

  it("lets a reschedule move onto a start held by a different page", async () => {
    const store = new MemoryMeetStore();
    const mine = makeBooking({ pageKey: "ju", startAt: "2026-08-20T18:00:00.000Z" });
    await store.insertBooking(mine);
    await store.insertBooking(makeBooking({ pageKey: "eldar" }));
    const moved = await store.updateBookingTime(
      mine.id,
      mine.startAt,
      new Date(START_MS).toISOString(),
      new Date(START_MS + 30 * 60_000).toISOString(),
      []
    );
    expect(moved).toEqual({ ok: true });
  });
});

describe("page settings persistence", () => {
  it("defaults an unseen member to a live page with no overrides", async () => {
    const store = new MemoryMeetStore();
    expect(await store.getPageSettings("ju")).toBeNull();
    const saved = await store.upsertPageSettings("ju", { headline: "Ju" });
    expect(saved.enabled).toBe(true);
    expect(saved.durationMinutes).toBeNull();
  });

  it("leaves omitted fields alone and clears on an explicit null", async () => {
    const store = new MemoryMeetStore();
    await store.upsertPageSettings("ju", { headline: "Ju", durationMinutes: 45 });
    await store.upsertPageSettings("ju", { enabled: false });
    let row = await store.getPageSettings("ju");
    expect(row?.durationMinutes).toBe(45);
    expect(row?.headline).toBe("Ju");
    expect(row?.enabled).toBe(false);

    await store.upsertPageSettings("ju", { durationMinutes: null });
    row = await store.getPageSettings("ju");
    expect(row?.durationMinutes).toBeNull();
    expect(row?.headline).toBe("Ju");
  });
});

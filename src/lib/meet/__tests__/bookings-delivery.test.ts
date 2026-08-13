import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking, CalendarAccount } from "@/lib/meet/types";

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
      mockMode: false,
    },
    slotFreeMembers: vi.fn(),
    insertBooking: vi.fn(),
    getBookingByToken: vi.fn(),
    updateBooking: vi.fn(),
    updateBookingTime: vi.fn(),
    listAccounts: vi.fn(),
    getAccount: vi.fn(),
    transitionToCancelled: vi.fn(),
    sendConfirmed: vi.fn(),
    sendCancelled: vi.fn(),
    sendRescheduled: vi.fn(),
    getProvider: vi.fn(),
    microsoftCreate: vi.fn(),
    microsoftDelete: vi.fn(),
    googleCreate: vi.fn(),
    googleDelete: vi.fn(),
  };
});

vi.mock("@/lib/meet/config", () => ({ getMeetConfig: () => mocks.config }));
vi.mock("@/lib/meet/availability", () => ({
  invalidateAvailabilityCache: vi.fn(),
  slotFreeMembers: mocks.slotFreeMembers,
}));
vi.mock("@/lib/meet/emails", () => ({
  sendBookingConfirmed: mocks.sendConfirmed,
  sendBookingCancelled: mocks.sendCancelled,
  sendBookingRescheduled: mocks.sendRescheduled,
}));
vi.mock("@/lib/meet/providers", () => ({ getProvider: mocks.getProvider }));
vi.mock("@/lib/meet/crypto", () => ({
  decryptSecret: (value: string) => value,
  randomToken: () => "generated-manage-token",
}));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
    insertBooking: mocks.insertBooking,
    getBookingByToken: mocks.getBookingByToken,
    updateBooking: mocks.updateBooking,
    updateBookingTime: mocks.updateBookingTime,
    listAccounts: mocks.listAccounts,
    getAccount: mocks.getAccount,
    transitionToCancelled: mocks.transitionToCancelled,
  }),
}));

import { createBooking, rescheduleBooking } from "@/lib/meet/bookings";

const START_MS = Date.parse("2026-08-13T10:00:00.000Z");

function account(
  id: string,
  memberKey: string,
  provider: CalendarAccount["provider"],
  email: string
): CalendarAccount {
  return {
    id,
    memberKey,
    provider,
    email,
    refreshTokenEnc: `token-${id}`,
    selectedCalendars: [{ id: "busy", name: "Busy" }],
    status: "ok",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function existingBooking(): Booking {
  return {
    id: "booking-1",
    startAt: "2026-08-14T10:00:00.000Z",
    endAt: "2026-08-14T11:00:00.000Z",
    durationMinutes: 60,
    name: "Booker",
    email: "booker@example.com",
    notes: null,
    timezone: "UTC",
    attendeeMemberKeys: ["one", "two"],
    guests: [],
    eventRefs: [],
    meetingUrl: null,
    status: "confirmed",
    manageToken: "manage-token",
    history: [],
    remindersSent: [],
    syncStatus: "synced",
    createdAt: "2026-08-01T00:00:00.000Z",
    cancelledAt: null,
  };
}

describe("booking delivery and duration invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-12T00:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.slotFreeMembers.mockResolvedValue({ free: mocks.config.members, quorumMet: true });
    mocks.insertBooking.mockResolvedValue({ ok: true });
    mocks.updateBooking.mockResolvedValue(undefined);
    mocks.updateBookingTime.mockResolvedValue({ ok: true });
    mocks.listAccounts.mockResolvedValue([]);
    mocks.sendConfirmed.mockResolvedValue(undefined);
    mocks.sendRescheduled.mockResolvedValue(undefined);
    mocks.microsoftDelete.mockResolvedValue(undefined);
    mocks.googleDelete.mockResolvedValue(undefined);
    mocks.getProvider.mockImplementation((provider: string) =>
      provider === "microsoft"
        ? { createEvent: mocks.microsoftCreate, deleteEvent: mocks.microsoftDelete }
        : { createEvent: mocks.googleCreate, deleteEvent: mocks.googleDelete }
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("degrades booking sync status when confirmation delivery fails", async () => {
    mocks.sendConfirmed.mockRejectedValueOnce(new Error("email provider unavailable"));

    const result = await createBooking({
      start: new Date(START_MS).toISOString(),
      name: "Booker",
      email: "booker@example.com",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("booking unexpectedly failed");
    expect(result.booking.syncStatus).toBe("failed");
    expect(mocks.updateBooking).toHaveBeenCalledWith(result.booking.id, {
      syncStatus: "failed",
    });
  });

  it("checks reschedule availability for the stored booking duration", async () => {
    const booking = existingBooking();
    mocks.getBookingByToken.mockResolvedValue(booking);

    const result = await rescheduleBooking("manage-token", {
      start: new Date(START_MS).toISOString(),
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    expect(mocks.slotFreeMembers).toHaveBeenCalledWith(START_MS, 60);
    expect(mocks.updateBookingTime).toHaveBeenCalledWith(
      booking.id,
      "2026-08-14T10:00:00.000Z",
      new Date(START_MS).toISOString(),
      new Date(START_MS + 60 * 60_000).toISOString(),
      expect.any(Array)
    );
  });

  it("tries healthy organizer accounts in preference order", async () => {
    mocks.listAccounts.mockResolvedValue([
      account("company-ms", "one", "microsoft", "one@example.com"),
      account("google", "one", "google", "one@gmail.com"),
      account("personal-ms", "two", "microsoft", "two@outlook.com"),
    ]);
    mocks.microsoftCreate.mockRejectedValueOnce(new Error("Teams unavailable"));
    mocks.googleCreate.mockResolvedValueOnce({
      eventId: "google-event",
      meetingUrl: "https://meet.google.com/actual-join",
    });

    const result = await createBooking({
      start: new Date(START_MS).toISOString(),
      name: "Booker",
      email: "booker@example.com",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("booking unexpectedly failed");
    expect(mocks.microsoftCreate).toHaveBeenCalledOnce();
    expect(mocks.googleCreate).toHaveBeenCalledOnce();
    expect(result.booking.meetingUrl).toBe("https://meet.google.com/actual-join");
    expect(result.booking.eventRefs[0]?.accountId).toBe("google");
    expect(result.booking.syncStatus).toBe("synced");
  });

  it("removes a conference event with no join URL before falling through", async () => {
    mocks.listAccounts.mockResolvedValue([
      account("company-ms", "one", "microsoft", "one@example.com"),
      account("google", "two", "google", "two@gmail.com"),
    ]);
    mocks.microsoftCreate.mockResolvedValueOnce({ eventId: "no-video", meetingUrl: null });
    mocks.googleCreate.mockResolvedValueOnce({
      eventId: "with-video",
      meetingUrl: "https://meet.google.com/actual-join",
    });

    const result = await createBooking({
      start: new Date(START_MS).toISOString(),
      name: "Booker",
      email: "booker@example.com",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    expect(mocks.microsoftDelete).toHaveBeenCalledWith(
      "token-company-ms",
      "",
      "no-video"
    );
    expect(mocks.googleCreate).toHaveBeenCalledOnce();
  });

  it("keeps an accepted no-video event degraded", async () => {
    mocks.listAccounts.mockResolvedValue([
      account("personal-ms", "one", "microsoft", "one@outlook.com"),
    ]);
    mocks.microsoftCreate.mockResolvedValueOnce({ eventId: "plain-event", meetingUrl: null });

    const result = await createBooking({
      start: new Date(START_MS).toISOString(),
      name: "Booker",
      email: "booker@example.com",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("booking unexpectedly failed");
    expect(result.booking.eventRefs).toHaveLength(1);
    expect(result.booking.meetingUrl).toBeNull();
    expect(result.booking.syncStatus).toBe("partial");
  });

  it("requests direct token-free guest notification when every event attempt fails", async () => {
    mocks.listAccounts.mockResolvedValue([
      account("company-ms", "one", "microsoft", "one@example.com"),
    ]);
    mocks.microsoftCreate.mockRejectedValueOnce(new Error("provider unavailable"));

    const result = await createBooking({
      start: new Date(START_MS).toISOString(),
      name: "Booker",
      email: "booker@example.com",
      guests: ["guest@example.com"],
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    expect(mocks.sendConfirmed).toHaveBeenCalledWith(expect.any(Object), mocks.config.members, {
      notifyGuestsDirectly: true,
    });
  });

  it("returns a stale conflict when another reschedule already moved the booking", async () => {
    mocks.getBookingByToken.mockResolvedValue(existingBooking());
    mocks.updateBookingTime.mockResolvedValueOnce({ ok: false, reason: "stale" });

    const result = await rescheduleBooking("manage-token", {
      start: new Date(START_MS).toISOString(),
      timezone: "UTC",
    });

    expect(result).toMatchObject({ ok: false, code: "stale" });
    expect(mocks.sendRescheduled).not.toHaveBeenCalled();
  });
});

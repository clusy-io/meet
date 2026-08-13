import "server-only";
import { getMeetConfig, type MeetConfig } from "./config";
import { decryptSecret, randomToken } from "./crypto";
import { invalidateAvailabilityCache, slotFreeMembers } from "./availability";
import { sendBookingCancelled, sendBookingConfirmed, sendBookingRescheduled } from "./emails";
import { getProvider } from "./providers";
import { candidateSlots } from "./slots";
import { getMeetStore } from "./store";
import { addCivilDays, utcToWall, wallToUtcMs } from "./tz";
import type {
  Booking,
  BookingEventRef,
  BookingView,
  CalendarAccount,
  CreateBookingRequest,
  Member,
  RescheduleRequest,
} from "./types";

/**
 * clusy/meet: booking lifecycle.
 *
 * The DB row is the source of truth; calendar events and emails are
 * side effects that degrade syncStatus instead of failing the booking.
 * Slot contention is settled by the store (partial unique index on
 * confirmed startAt), not by re-checking availability here.
 */

export type BookingActionError = {
  ok: false;
  code: "invalid" | "slot_unavailable" | "slot_taken" | "stale" | "not_found";
  message: string;
};

function invalid(message: string): BookingActionError {
  return { ok: false, code: "invalid", message };
}

function unavailable(message: string): BookingActionError {
  return { ok: false, code: "slot_unavailable", message };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Steps 1-2 of booking validation: the instant parses, sits exactly on the
 * host-tz slot grid, respects min notice, and falls inside the horizon
 * (today in host tz + horizonDays, inclusive). Quorum is checked separately.
 */
function validateSlotStart(
  config: MeetConfig,
  start: string,
  timezone: string
): { ok: true; startMs: number } | BookingActionError {
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) return invalid("The start time is not a valid instant.");
  if (startMs % 60_000 !== 0) return invalid("The start time must fall on a whole minute.");
  if (!isValidTimezone(timezone)) return invalid("Unknown timezone.");

  const w = utcToWall(config.hostTimezone, startMs);
  const onGrid = candidateSlots(config, { year: w.year, month: w.month, day: w.day }, 1).some(
    (c) => c.startMs === startMs
  );
  if (!onGrid) return unavailable("That time is outside the bookable window.");

  const nowMs = Date.now();
  if (startMs < nowMs + config.minNoticeMinutes * 60_000) {
    return unavailable("That time is too soon to book.");
  }
  const nowWall = utcToWall(config.hostTimezone, nowMs);
  const edge = addCivilDays(nowWall.year, nowWall.month, nowWall.day, config.horizonDays + 1);
  const horizonMs = wallToUtcMs(config.hostTimezone, edge.year, edge.month, edge.day, 0, 0);
  if (startMs >= horizonMs) return unavailable("That time is beyond the booking horizon.");

  return { ok: true, startMs };
}

/** Members from config (config order) matching the given free set. */
function membersInConfigOrder(config: MeetConfig, keys: string[]): Member[] {
  return config.members.filter((m) => keys.includes(m.key));
}

function accountRefreshToken(config: MeetConfig, account: CalendarAccount): string {
  // Mock accounts store a raw "mock:<memberKey>" token, never ciphertext.
  return config.mockMode ? account.refreshTokenEnc : decryptSecret(account.refreshTokenEnc);
}

/** Company domain from the configured site origin; empty when unparsable. */
function companyDomain(config: MeetConfig): string {
  try {
    return new URL(config.siteOrigin).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Organizer preference, per attending member in config order:
 * 1. a company-domain Microsoft account (invites come from your own domain, with a
 *    Teams link),
 * 2. any Google account (Meet link),
 * 3. any other Microsoft account (no video link).
 * Events land on the account's primary calendar, so a usable account only
 * needs a live grant; its busy-source calendar selection is irrelevant here.
 */
interface OrganizerCandidate {
  account: CalendarAccount;
  withConference: boolean;
}

function organizerCandidates(
  config: MeetConfig,
  attending: Member[],
  accounts: CalendarAccount[]
): OrganizerCandidate[] {
  const domain = companyDomain(config);
  const isCompanyMs = (a: CalendarAccount): boolean =>
    a.provider === "microsoft" && domain !== "" && a.email.toLowerCase().endsWith(`@${domain}`);
  const passes: Array<(a: CalendarAccount) => boolean> = [
    isCompanyMs,
    (a) => a.provider === "google",
    (a) => a.provider === "microsoft",
  ];
  const out: OrganizerCandidate[] = [];
  const seen = new Set<string>();
  for (const pass of passes) {
    for (const member of attending) {
      for (const account of accounts) {
        if (
          seen.has(account.id) ||
          account.memberKey !== member.key ||
          account.status !== "ok" ||
          !pass(account)
        ) {
          continue;
        }
        seen.add(account.id);
        out.push({
          account,
          withConference: account.provider === "google" || isCompanyMs(account),
        });
      }
    }
  }
  return out;
}

/**
 * Invite list: booker, their guests, and EVERY team member at their CONFIG
 * address, lowercased and deduped.
 * Members who are busy at that time are invited anyway, as an FYI they can
 * decline; attendeeMemberKeys still records who actually committed.
 * Connected account emails are deliberately not used: members watch many
 * mailboxes, but invites should land in the company one. The organizer
 * account is excluded: the provider adds the organizer implicitly.
 */
function eventAttendees(
  config: MeetConfig,
  booking: Booking,
  organizerEmail: string
): Array<{ email: string; name?: string }> {
  const seen = new Set<string>([organizerEmail.trim().toLowerCase()]);
  const out: Array<{ email: string; name?: string }> = [];
  const push = (email: string, name?: string): void => {
    const lower = email.trim().toLowerCase();
    if (!lower || seen.has(lower)) return;
    seen.add(lower);
    out.push(name ? { email: lower, name } : { email: lower });
  };
  push(booking.email, booking.name);
  for (const guest of booking.guests) push(guest);
  for (const member of config.members) {
    push(member.email, member.name);
  }
  return out;
}

/** Sanitized guest list: trimmed, lowercased, valid, deduped, capped at 10. */
function sanitizeGuests(raw: string[] | undefined, bookerEmail: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>([bookerEmail.trim().toLowerCase()]);
  const out: string[] = [];
  for (const entry of raw) {
    const email = entry.trim().toLowerCase();
    if (!email || seen.has(email) || !EMAIL_RE.test(email)) continue;
    seen.add(email);
    out.push(email);
    if (out.length >= 10) break;
  }
  return out;
}

/** Provider-visible copy. Never include the bearer management token here. */
export function bookingEventDescription(config: MeetConfig, booking: Booking): string {
  const parts = [config.eventDescription];
  if (booking.notes) parts.push(`Notes from ${booking.name}: ${booking.notes}`);
  return parts.join("\n\n");
}

export async function createBooking(
  req: CreateBookingRequest
): Promise<{ ok: true; booking: Booking } | BookingActionError> {
  const config = getMeetConfig();
  const store = getMeetStore();

  // Defensive re-validation: the route validates too, but this module must
  // hold on its own (it is also the admin/test entry point).
  const name = req.name?.trim() ?? "";
  const email = req.email?.trim() ?? "";
  if (name.length < 1 || name.length > 120) return invalid("A name is required.");
  if (!EMAIL_RE.test(email)) return invalid("A valid email address is required.");

  const validated = validateSlotStart(config, req.start, req.timezone);
  if (!validated.ok) return validated;
  const { startMs } = validated;

  const { free, quorumMet } = await slotFreeMembers(startMs);
  if (!quorumMet) return unavailable("That time is no longer available.");
  const attending = membersInConfigOrder(
    config,
    free.map((m) => m.key)
  );

  const nowIso = new Date().toISOString();
  const booking: Booking = {
    id: crypto.randomUUID(),
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(startMs + config.durationMinutes * 60_000).toISOString(),
    durationMinutes: config.durationMinutes,
    name,
    email,
    notes: req.notes?.trim() || null,
    timezone: req.timezone,
    attendeeMemberKeys: attending.map((m) => m.key),
    guests: sanitizeGuests(req.guests, email),
    eventRefs: [],
    meetingUrl: null,
    status: "confirmed",
    manageToken: randomToken(),
    history: [],
    remindersSent: [],
    // Inserted degraded on purpose: the row only claims "synced" after the
    // calendar event and emails actually landed AND were persisted. A crash
    // between insert and the final update leaves an honest "partial" row.
    syncStatus: "partial",
    createdAt: nowIso,
    cancelledAt: null,
  };

  const inserted = await store.insertBooking(booking);
  if (!inserted.ok) {
    return { ok: false, code: "slot_taken", message: "That time was just booked. Pick another slot." };
  }
  invalidateAvailabilityCache();

  // Side effects. Each is best-effort: a failure degrades syncStatus but the
  // booking stands (the row is the truth; sync can be repaired from admin).
  let eventOk = false;
  let emailOk = true;
  const eventRefs: BookingEventRef[] = [];
  let meetingUrl: string | null = null;

  try {
    const accounts = await store.listAccounts();
    const candidates = organizerCandidates(config, attending, accounts);
    for (const organizer of candidates) {
      const provider = getProvider(organizer.account.provider);
      let refreshToken: string;
      try {
        refreshToken = accountRefreshToken(config, organizer.account);
        // Events go on the organizer's PRIMARY calendar, never on
        // selectedCalendars: those are busy SOURCES and may be read-only
        // subscriptions (a real production failure: "writer access required").
        const calendarId = organizer.account.provider === "google" ? "primary" : "";
        const created = await provider.createEvent(refreshToken, {
          calendarId,
          summary: config.eventTitle.split("{name}").join(booking.name),
          description: bookingEventDescription(config, booking),
          startAt: booking.startAt,
          endAt: booking.endAt,
          attendees: eventAttendees(config, booking, organizer.account.email),
          withConference: organizer.withConference,
        });
        const createdMeetingUrl =
          typeof created.meetingUrl === "string" && created.meetingUrl.trim()
            ? created.meetingUrl
            : null;
        const ref: BookingEventRef = {
          provider: organizer.account.provider,
          accountId: organizer.account.id,
          calendarId,
          eventId: created.eventId,
        };

        if (organizer.withConference && createdMeetingUrl === null) {
          // A conference-capable attempt without an actual join URL is not a
          // success. Remove its event before trying the next organizer so we
          // do not leave duplicate live invitations. If cleanup itself fails,
          // retain the ref as an accepted, degraded no-video event rather than
          // create an untracked orphan and a second invitation.
          try {
            await provider.deleteEvent(refreshToken, calendarId, created.eventId);
            console.error(
              `meet: ${organizer.account.provider} created no conference URL; trying next organizer`
            );
            continue;
          } catch (cleanupError) {
            console.error(
              `meet: could not remove no-video event ${created.eventId}; accepting degraded event`,
              cleanupError
            );
          }
        }

        eventRefs.push(ref);
        meetingUrl = createdMeetingUrl;
        eventOk = createdMeetingUrl !== null;
        break;
      } catch (err) {
        console.error(
          `meet: calendar event creation failed for account ${organizer.account.id}`,
          err
        );
      }
    }
  } catch (err) {
    console.error("meet: loading organizer accounts failed", err);
  }

  // Persist the event refs BEFORE sending emails: a live calendar event the
  // DB does not know about can never be cancelled or moved again. One retry,
  // then a loud log carrying the refs so the orphan is recoverable by hand.
  booking.eventRefs = eventRefs;
  booking.meetingUrl = meetingUrl;
  let refsPersisted = true;
  if (eventRefs.length > 0) {
    refsPersisted = false;
    for (let attempt = 0; attempt < 2 && !refsPersisted; attempt++) {
      try {
        await store.updateBooking(booking.id, { eventRefs, meetingUrl });
        refsPersisted = true;
      } catch (err) {
        console.error("meet: persisting event refs failed", err);
      }
    }
    if (!refsPersisted) {
      console.error(
        `meet: ORPHANED calendar event for booking ${booking.id}: ${JSON.stringify(eventRefs)}`
      );
    }
  }

  try {
    await sendBookingConfirmed(booking, attending, {
      // When every provider attempt failed there is no native calendar invite
      // to notify extra guests, so Resend must carry a token-free fallback.
      notifyGuestsDirectly: eventRefs.length === 0,
    });
  } catch (err) {
    console.error("meet: confirmation email failed", err);
    emailOk = false;
  }

  const allOk = eventOk && emailOk && refsPersisted;
  booking.syncStatus = allOk ? "synced" : eventOk || emailOk ? "partial" : "failed";
  if (booking.syncStatus !== "partial") {
    // "partial" is already what the row says since insert; only divergent
    // final states need a write. A failed write leaves an honest "partial".
    try {
      await store.updateBooking(booking.id, { syncStatus: booking.syncStatus });
    } catch (err) {
      console.error("meet: booking sync-state update failed", err);
      booking.syncStatus = "partial";
    }
  }

  return { ok: true, booking };
}

export async function cancelBooking(
  token: string
): Promise<{ ok: true; booking: Booking } | BookingActionError> {
  const config = getMeetConfig();
  const store = getMeetStore();

  const booking = await store.getBookingByToken(token);
  if (!booking) return { ok: false, code: "not_found", message: "Booking not found." };
  // Idempotent: cancelling twice is a success, not an error.
  if (booking.status === "cancelled") return { ok: true, booking };

  // Win the transition FIRST. The conditional write serializes concurrent
  // cancels (and cancel-vs-reschedule): only the winner runs side effects,
  // so exactly one cancellation email pair ever goes out.
  const cancelledAt = new Date().toISOString();
  const won = await store.transitionToCancelled(booking.id, cancelledAt);
  if (!won) {
    const fresh = await store.getBookingByToken(token);
    if (!fresh) return { ok: false, code: "not_found", message: "Booking not found." };
    return { ok: true, booking: fresh };
  }
  booking.status = "cancelled";
  booking.cancelledAt = cancelledAt;
  invalidateAvailabilityCache();

  let deleteFailed = false;
  for (const ref of booking.eventRefs) {
    try {
      const account = await store.getAccount(ref.accountId);
      if (!account) throw new Error(`account ${ref.accountId} no longer exists`);
      const refreshToken = accountRefreshToken(config, account);
      await getProvider(ref.provider).deleteEvent(refreshToken, ref.calendarId, ref.eventId);
    } catch (err) {
      console.error("meet: calendar event delete failed", err);
      deleteFailed = true;
    }
  }
  if (deleteFailed) {
    // The calendar still shows an event for a cancelled booking; flag the
    // row so admin can reconcile instead of silently forgetting it.
    booking.syncStatus = "partial";
    try {
      await store.updateBooking(booking.id, { syncStatus: "partial" });
    } catch (err) {
      console.error("meet: cancel sync-state update failed", err);
    }
  }

  const attending = membersInConfigOrder(config, booking.attendeeMemberKeys);
  try {
    await sendBookingCancelled(booking, attending);
  } catch (err) {
    console.error("meet: cancellation email failed", err);
    booking.syncStatus = "partial";
    try {
      await store.updateBooking(booking.id, { syncStatus: "partial" });
    } catch (syncErr) {
      console.error("meet: cancellation email sync-state update failed", syncErr);
    }
  }

  return { ok: true, booking };
}

export async function rescheduleBooking(
  token: string,
  req: RescheduleRequest
): Promise<{ ok: true; booking: Booking } | BookingActionError> {
  const config = getMeetConfig();
  const store = getMeetStore();

  const booking = await store.getBookingByToken(token);
  if (!booking) return { ok: false, code: "not_found", message: "Booking not found." };
  if (booking.status === "cancelled") {
    return invalid("This booking was cancelled and cannot be rescheduled.");
  }

  const validated = validateSlotStart(config, req.start, req.timezone);
  if (!validated.ok) return validated;
  const { startMs } = validated;

  // The attendee set stays as originally booked, so the bar is stricter
  // than at create time: every committed attendee must be free at the new
  // time, or someone gets silently double-booked. The reschedule UI fetches
  // availability constrained to these members, so slots it shows pass this.
  const { free } = await slotFreeMembers(startMs, booking.durationMinutes);
  const freeKeys = new Set(free.map((m) => m.key));
  const attendeesFree = booking.attendeeMemberKeys.every((key) => freeKeys.has(key));
  if (!attendeesFree) {
    return unavailable("That time does not work for this meeting's attendees.");
  }

  const previousStartAt = booking.startAt;
  const previousEndAt = booking.endAt;
  const newStartAt = new Date(startMs).toISOString();
  const newEndAt = new Date(startMs + booking.durationMinutes * 60_000).toISOString();
  const newHistory: Booking["history"] = [
    ...booking.history,
    { startAt: previousStartAt, endAt: previousEndAt, changedAt: new Date().toISOString() },
  ];

  const moved = await store.updateBookingTime(
    booking.id,
    previousStartAt,
    newStartAt,
    newEndAt,
    newHistory
  );
  if (!moved.ok) {
    if (moved.reason === "not_confirmed") {
      // A concurrent cancel won between our status read and this write.
      return invalid("This booking was cancelled and cannot be rescheduled.");
    }
    if (moved.reason === "stale") {
      return {
        ok: false,
        code: "stale",
        message: "This booking changed in another request. Refresh and choose a time again.",
      };
    }
    return { ok: false, code: "slot_taken", message: "That time was just booked. Pick another slot." };
  }
  booking.startAt = newStartAt;
  booking.endAt = newEndAt;
  booking.history = newHistory;
  invalidateAvailabilityCache();

  let patchFailed = false;
  for (const ref of booking.eventRefs) {
    try {
      const account = await store.getAccount(ref.accountId);
      if (!account) throw new Error(`account ${ref.accountId} no longer exists`);
      const refreshToken = accountRefreshToken(config, account);
      await getProvider(ref.provider).updateEventTime(
        refreshToken,
        ref.calendarId,
        ref.eventId,
        newStartAt,
        newEndAt
      );
    } catch (err) {
      console.error("meet: calendar event reschedule failed", err);
      patchFailed = true;
    }
  }

  booking.timezone = req.timezone;
  const patch: Partial<Booking> = { timezone: req.timezone };
  if (patchFailed) {
    booking.syncStatus = "partial";
    patch.syncStatus = "partial";
  }
  try {
    await store.updateBooking(booking.id, patch);
  } catch (err) {
    // The time move already committed; the timezone label is cosmetic.
    console.error("meet: booking reschedule update failed", err);
  }

  const attending = membersInConfigOrder(config, booking.attendeeMemberKeys);
  try {
    await sendBookingRescheduled(booking, attending, previousStartAt);
  } catch (err) {
    console.error("meet: reschedule email failed", err);
    booking.syncStatus = "partial";
    try {
      await store.updateBooking(booking.id, { syncStatus: "partial" });
    } catch (syncErr) {
      console.error("meet: reschedule email sync-state update failed", syncErr);
    }
  }

  return { ok: true, booking };
}

/** Public projection of a booking (what /api/meet returns to the browser). */
export function toBookingView(b: Booking): BookingView {
  return {
    id: b.id,
    startAt: b.startAt,
    endAt: b.endAt,
    durationMinutes: b.durationMinutes,
    name: b.name,
    email: b.email,
    notes: b.notes,
    timezone: b.timezone,
    guests: b.guests,
    meetingUrl: b.meetingUrl,
    status: b.status,
    manageToken: b.manageToken,
  };
}

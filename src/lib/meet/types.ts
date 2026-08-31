/**
 * clusy/meet — core domain types.
 *
 * This module is the contract every other meet file compiles against.
 * Keep it dependency-free (types only, plus tiny pure helpers) so the
 * whole feature stays extractable as a standalone open-source package.
 */

/** A person whose calendars gate availability (e.g. the three founders). */
export interface Member {
  /** Stable key used in DB rows and config, e.g. "ava". */
  key: string;
  /** Display name shown in admin and internal emails. */
  name: string;
  /**
   * Where this member receives booking notifications. Calendar invites go
   * to the connected account emails instead; this is the fallback contact.
   */
  email: string;
}

/** A persisted roster override layered over the MEET_MEMBERS baseline. */
export interface MemberRecord extends Member {
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CalendarProviderId = "google" | "microsoft";

/** One calendar inside a connected account (a person may watch several). */
export interface SelectedCalendar {
  /** Provider-side calendar id ("primary", an address, or an opaque id). */
  id: string;
  /** Human-readable name, captured at selection time for the admin UI. */
  name: string;
}

/** A connected Google or Microsoft account owned by one member. */
export interface CalendarAccount {
  id: string;
  memberKey: string;
  provider: CalendarProviderId;
  /** Account email, as reported by the provider at connect time. */
  email: string;
  /** AES-256-GCM ciphertext of the OAuth refresh token (see crypto.ts). */
  refreshTokenEnc: string;
  /** Calendars that count toward this member's busy time. */
  selectedCalendars: SelectedCalendar[];
  /** "ok" | "reauth_required" — set when a refresh grant is revoked. */
  status: "ok" | "reauth_required";
  createdAt: string;
  updatedAt: string;
}

/**
 * Stored overrides for one person's page (/<memberKey>).
 *
 * Every field except `memberKey` and `enabled` is nullable and means "inherit
 * the global value": a page persists only what its owner actually changed, so
 * raising the team-wide window raises theirs too. A member with no row at all
 * is a live page on fully inherited settings.
 */
export interface PageSettings {
  memberKey: string;
  enabled: boolean;
  /** Page heading; defaults to the member's name. */
  headline: string | null;
  /** One-line subheading under the heading. */
  blurb: string | null;
  /** IANA zone this host's working hours are evaluated in; null inherits. */
  timezone: string | null;
  /**
   * Optional scheduled move. Civil days before `beforeDate` use this zone;
   * days on/after it use `timezone` (or the inherited team zone).
   */
  timezoneUntil: { beforeDate: string; timezone: string } | null;
  windowStartMin: number | null;
  windowEndMin: number | null;
  bookableWeekdays: number[] | null;
  durationMinutes: number | null;
  slotStepMinutes: number | null;
  minNoticeMinutes: number | null;
  horizonDays: number | null;
  eventTitle: string | null;
  eventDescription: string | null;
  /**
   * Slack Incoming Webhook for this page, AES-256-GCM encrypted at rest.
   * Null falls back to the team-wide webhook.
   */
  slackWebhookEnc: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Admin-facing view: the webhook is reported as present/absent, never echoed. */
export type PageSettingsView = Omit<PageSettings, "slackWebhookEnc"> & {
  slackWebhookSet: boolean;
};

/** Half-open UTC interval [start, end) in epoch milliseconds. */
export interface BusyInterval {
  startMs: number;
  endMs: number;
}

export type BookingStatus = "confirmed" | "cancelled";

/** A calendar event we created for a booking, so we can patch/delete it. */
export interface BookingEventRef {
  provider: CalendarProviderId;
  accountId: string;
  calendarId: string;
  eventId: string;
}

export interface Booking {
  id: string;
  /**
   * Which page took this booking: "" for the team page, or a member key for
   * that person's page (/<key>). Decides who is invited, who is emailed, and
   * which members the slot consumes. Required, not optional, so every
   * construction site has to state its intent.
   */
  pageKey: string;
  /** UTC ISO instants. */
  startAt: string;
  endAt: string;
  durationMinutes: number;
  /** Booker details. */
  name: string;
  email: string;
  notes: string | null;
  /** IANA zone the booker picked, used to render times in their emails. */
  timezone: string;
  /** Member keys who were free and are attending. */
  attendeeMemberKeys: string[];
  /** Extra guest emails the booker asked to invite. */
  guests: string[];
  /** Calendar events created for this booking (usually one, on the organizer). */
  eventRefs: BookingEventRef[];
  /** Video-call URL if the provider issued one (Google Meet). */
  meetingUrl: string | null;
  status: BookingStatus;
  /** Unguessable token that authorizes cancel/reschedule via /manage. */
  manageToken: string;
  /** Prior [startAt, endAt] pairs, newest last, when rescheduled. */
  history: Array<{ startAt: string; endAt: string; changedAt: string }>;
  /** Reminder kinds already sent ("24h", "1h"); cleared on reschedule. */
  remindersSent: string[];
  /** "synced" | "partial" | "failed" — calendar/email side effects outcome. */
  syncStatus: "synced" | "partial" | "failed";
  createdAt: string;
  cancelledAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Provider contract                                                   */
/* ------------------------------------------------------------------ */

export interface ProviderTokens {
  accessToken: string;
  /** Present on first grant; providers may omit it on re-consent. */
  refreshToken?: string;
  /** Epoch ms when accessToken expires. */
  expiresAtMs: number;
  /** Account email, resolved from the token/userinfo. */
  email: string;
}

export interface ProviderCalendarListEntry {
  id: string;
  name: string;
  /** True for the account's default calendar. */
  primary: boolean;
}

export interface CreateEventInput {
  calendarId: string;
  summary: string;
  description: string;
  /** UTC ISO instants. */
  startAt: string;
  endAt: string;
  /** Attendee emails (booker + attending members). */
  attendees: Array<{ email: string; name?: string }>;
  /** Ask the provider for a video-conference link (Google Meet). */
  withConference: boolean;
}

export interface CreatedEvent {
  eventId: string;
  meetingUrl: string | null;
}

/**
 * One implementation per provider (providers/google.ts, providers/microsoft.ts).
 * All methods take a decrypted refresh token and manage access-token refresh
 * internally. Methods throw ProviderAuthError when the grant is revoked so
 * callers can flip the account to "reauth_required".
 */
export interface CalendarProvider {
  id: CalendarProviderId;
  /** Build the consent URL. `state` is an opaque signed blob from the caller. */
  getAuthUrl(state: string, redirectUri: string): string;
  /** Exchange an OAuth code for tokens (connect flow). */
  exchangeCode(code: string, redirectUri: string): Promise<ProviderTokens>;
  /** List calendars the account can read, for the admin picker. */
  listCalendars(refreshToken: string): Promise<ProviderCalendarListEntry[]>;
  /**
   * Busy intervals across the given calendars, clamped to [fromMs, toMs).
   * Tentative and out-of-office count as busy; free/transparent events do not.
   */
  getBusy(
    refreshToken: string,
    calendarIds: string[],
    fromMs: number,
    toMs: number
  ): Promise<BusyInterval[]>;
  createEvent(refreshToken: string, input: CreateEventInput): Promise<CreatedEvent>;
  /** Move an existing event (reschedule). */
  updateEventTime(
    refreshToken: string,
    calendarId: string,
    eventId: string,
    startAt: string,
    endAt: string
  ): Promise<void>;
  deleteEvent(refreshToken: string, calendarId: string, eventId: string): Promise<void>;
}

/** Thrown by providers when the refresh grant is invalid/revoked. */
export class ProviderAuthError extends Error {
  constructor(provider: CalendarProviderId, detail: string) {
    super(`${provider}: re-authorization required (${detail})`);
    this.name = "ProviderAuthError";
  }
}

/* ------------------------------------------------------------------ */
/* API payloads (client <-> /api/meet)                                 */
/* ------------------------------------------------------------------ */

/** GET /api/meet/availability?from=YYYY-MM-DD&to=YYYY-MM-DD (host-tz dates) */
export interface AvailabilityResponse {
  /** UTC ISO start instants of bookable slots, ascending. */
  slots: string[];
  durationMinutes: number;
  /** Host timezone, for the "8:30-22:00 SF time" footnote in the UI. */
  hostTimezone: string;
  /**
   * Server's minimum-notice window. The client re-applies it against a live
   * clock so slots that age past the boundary disappear without a refetch.
   */
  minNoticeMinutes: number;
}

/** POST /api/meet/bookings */
export interface CreateBookingRequest {
  start: string; // UTC ISO, must equal a currently-available slot start
  /** Member key of the personal page this came from; omitted = team page. */
  host?: string;
  name: string;
  email: string;
  notes?: string;
  /** Guest emails to include on the calendar invite (max 10). */
  guests?: string[];
  timezone: string; // IANA zone the booker was viewing
  /** Honeypot; any non-empty value silently drops the request. */
  company?: string;
}

export interface BookingView {
  id: string;
  /** Personal page this came from, "" for the team page. */
  pageKey: string;
  /**
   * Display name of the person this call is with, or null for a team booking.
   * Resolved server-side so the manage page does not need the member roster.
   */
  hostName: string | null;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  name: string;
  email: string;
  notes: string | null;
  timezone: string;
  guests: string[];
  meetingUrl: string | null;
  status: BookingStatus;
  manageToken: string;
}

export interface CreateBookingResponse {
  booking: BookingView;
}

/** POST /api/meet/bookings/[token]/reschedule */
export interface RescheduleRequest {
  start: string; // UTC ISO, must equal a currently-available slot start
  timezone: string;
}

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

/** Merge overlapping/adjacent busy intervals into a sorted minimal set. */
export function mergeBusy(intervals: BusyInterval[]): BusyInterval[] {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const out: BusyInterval[] = [];
  for (const iv of sorted) {
    if (iv.endMs <= iv.startMs) continue;
    const last = out[out.length - 1];
    if (last && iv.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, iv.endMs);
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

/** True when [startMs, endMs) overlaps any interval in a merged, sorted set. */
export function overlapsBusy(busy: BusyInterval[], startMs: number, endMs: number): boolean {
  for (const iv of busy) {
    if (iv.startMs >= endMs) return false;
    if (iv.endMs > startMs) return true;
  }
  return false;
}

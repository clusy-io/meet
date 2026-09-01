import type {
  CalendarProviderId,
  Member,
  SelectedCalendar,
} from "@/lib/meet/types";

/** A provider account shown in the calendar-connection workspace. */
export interface AdminAccount {
  id: string;
  memberKey: string;
  provider: CalendarProviderId;
  email: string;
  selectedCalendars: SelectedCalendar[];
  status: "ok" | "reauth_required";
  createdAt: string;
}

/** GET /api/meet/admin/accounts. */
export interface AdminOverview {
  members: Member[];
  quorum: number;
  hostTimezone: string;
  window: { start: string; end: string };
  accounts: AdminAccount[];
  /** True when the server runs on in-memory fake calendars. */
  mockMode: boolean;
}

export interface CalendarEntry {
  id: string;
  name: string;
  primary: boolean;
}

/** One operational row from GET /api/meet/admin/bookings. */
export interface AdminBooking {
  id: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  name: string;
  email: string;
  guests: string[];
  notes: string | null;
  timezone: string;
  attendeeMemberKeys: string[];
  meetingUrl: string | null;
  status: "confirmed" | "cancelled";
  syncStatus: "synced" | "partial" | "failed";
  history: Array<{ startAt: string; endAt: string; changedAt: string }>;
  remindersSent: string[];
  manageUrl: string;
  createdAt: string;
  cancelledAt: string | null;
}

/** GET /api/meet/admin/bookings. */
export interface BookingsResponse {
  hostTimezone: string;
  members: Member[];
  bookings: AdminBooking[];
}

export interface PersonalPage {
  memberKey: string;
  memberName: string;
  /** Canonical address used for booking notifications and calendar invites. */
  memberEmail: string;
  url: string;
  enabled: boolean;
  /** Stored headline override; older rows may contain only the member name. */
  headline: string | null;
  blurb: string | null;
  /** The host-specific values used when every override is cleared. */
  inherited: {
    /** Permanent/target IANA zone for this host's working hours. */
    timezone: string;
    /** IANA zone currently in force, accounting for a scheduled move. */
    timezoneToday: string;
    timezoneUntil: { beforeDate: string; timezone: string } | null;
    durationMinutes: number;
    slotStepMinutes: number;
    windowStart: string;
    windowEnd: string;
    minNoticeMinutes: number;
    horizonDays: number;
    bookableWeekdays: number[];
    eventTitle: string;
    eventDescription: string;
  };
  effective: {
    timezone: string;
    timezoneToday: string;
    timezoneUntil: { beforeDate: string; timezone: string } | null;
    durationMinutes: number;
    slotStepMinutes: number;
    windowStart: string;
    windowEnd: string;
    minNoticeMinutes: number;
    horizonDays: number;
    bookableWeekdays: number[];
    eventTitle: string;
    eventDescription: string;
  };
  overrides: {
    timezone: string | null;
    timezoneUntil: { beforeDate: string; timezone: string } | null;
    durationMinutes: number | null;
    slotStepMinutes: number | null;
    windowStartMin: number | null;
    windowEndMin: number | null;
    minNoticeMinutes: number | null;
    horizonDays: number | null;
    bookableWeekdays: number[] | null;
    eventTitle: string | null;
    eventDescription: string | null;
  };
  slackWebhookConfigured: boolean;
  calendarReady: boolean;
}

export interface PersonalPagesResponse {
  hostTimezone: string;
  defaults: {
    timezone: string;
    timezoneToday: string;
    timezoneUntil: { beforeDate: string; timezone: string } | null;
    durationMinutes: number;
    slotStepMinutes: number;
    windowStart: string;
    windowEnd: string;
    minNoticeMinutes: number;
    horizonDays: number;
    bookableWeekdays: number[];
    eventTitle: string;
    eventDescription: string;
  };
  pages: PersonalPage[];
  /** Removed members stay recoverable without appearing on public booking pages. */
  archivedMembers: Array<{
    key: string;
    name: string;
    email: string;
  }>;
}

export interface AdminBusyInterval {
  startAt: string;
  endAt: string;
}

export interface TeamAvailabilityMember {
  key: string;
  name: string;
  /** Unavailable is fail-closed: the calendar could not be read reliably. */
  status: "ready" | "unavailable";
  busy: AdminBusyInterval[];
  /** Absolute intervals when this member's configured team window is open. */
  working: AdminBusyInterval[];
  /** Absolute team-grid starts allowed by this member's own hours and zone. */
  eligibleStarts: string[];
}

export interface TeamAvailabilityServerSlot {
  startAt: string;
  endAt: string;
  freeMemberKeys: string[];
}

export interface TeamAvailabilityResponse {
  hostTimezone: string;
  generatedAt: string;
  /** Civil-date bounds in hostTimezone; `to` is exclusive. */
  range: { from: string; to: string };
  /** Display bounds in hostTimezone, expanded for member-specific hours. */
  window: { start: string; end: string };
  durationMinutes: number;
  slotStepMinutes: number;
  minNoticeMinutes: number;
  quorum: number;
  bookableWeekdays: number[];
  /** Host-timezone dates with at least one eligible member start. */
  bookableDates: string[];
  members: TeamAvailabilityMember[];
  /** Server-authoritative team starts after notice, horizon, busy and quorum rules. */
  slots: TeamAvailabilityServerSlot[];
}

export type AdminWorkspaceView =
  "schedule" | "availability" | "members" | "calendars";

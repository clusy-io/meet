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
  url: string;
  enabled: boolean;
  /** Stored headline override; older rows may contain only the member name. */
  headline: string | null;
  blurb: string | null;
  /** The host-specific values used when every override is cleared. */
  inherited: {
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
}

export type AdminWorkspaceView = "schedule" | "pages" | "calendars";

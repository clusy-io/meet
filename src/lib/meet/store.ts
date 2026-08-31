import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getMeetConfig } from "./config";
import type {
  Booking,
  CalendarAccount,
  MemberRecord,
  PageSettings,
} from "./types";

/**
 * clusy/meet — persistence.
 *
 * A small storage interface with two implementations: Supabase Postgres
 * (production; schema in docs/schema.sql) and an in-memory store for
 * MEET_MOCK_MODE / local demos. Server-only.
 */

export type InsertBookingResult =
  | { ok: true }
  | { ok: false; reason: "slot_taken" | "not_confirmed" | "stale" };

export type MemberWriteResult =
  | { ok: true; member: MemberRecord }
  | { ok: false; reason: "key_taken" | "email_taken" };

export interface MeetStore {
  /** Runtime roster rows layered over the MEET_MEMBERS baseline. */
  listMemberRecords(): Promise<MemberRecord[]>;
  getMemberRecord(memberKey: string): Promise<MemberRecord | null>;
  insertMemberRecord(
    member: Omit<MemberRecord, "createdAt" | "updatedAt">
  ): Promise<MemberWriteResult>;
  /** Insert a baseline row if absent; never overwrite a concurrent winner. */
  ensureMemberRecord(
    member: Omit<MemberRecord, "createdAt" | "updatedAt">
  ): Promise<MemberWriteResult>;
  upsertMemberRecord(
    member: Omit<MemberRecord, "createdAt" | "updatedAt">
  ): Promise<MemberWriteResult>;
  /** Identity-only write: archive state and omitted identity fields are untouched. */
  updateMemberIdentity(
    memberKey: string,
    patch: Partial<Pick<MemberRecord, "name" | "email">>
  ): Promise<MemberWriteResult>;
  /** Archive-only write: identity is deliberately untouched. */
  updateMemberArchivedAt(
    memberKey: string,
    archivedAt: string | null
  ): Promise<MemberRecord>;
  /** Restore only the exact archive marker written by the compensating request. */
  restoreMemberArchivedAt(memberKey: string, expectedArchivedAt: string): Promise<boolean>;

  listAccounts(): Promise<CalendarAccount[]>;
  getAccount(id: string): Promise<CalendarAccount | null>;
  /** Insert, or replace the row for the same (memberKey, provider, email). */
  upsertAccount(
    account: Omit<CalendarAccount, "id" | "createdAt" | "updatedAt">
  ): Promise<CalendarAccount>;
  updateAccount(
    id: string,
    patch: Partial<Pick<CalendarAccount, "selectedCalendars" | "status" | "refreshTokenEnc">>
  ): Promise<void>;
  deleteAccount(id: string): Promise<void>;

  /** Stored overrides for the personal booking pages, one row per member. */
  listPageSettings(): Promise<PageSettings[]>;
  getPageSettings(memberKey: string): Promise<PageSettings | null>;
  /**
   * Insert-or-update by memberKey. Fields absent from `patch` are left as they
   * are; a field explicitly set to null clears the override and returns that
   * setting to the global config value.
   */
  upsertPageSettings(
    memberKey: string,
    patch: Partial<Omit<PageSettings, "memberKey" | "createdAt" | "updatedAt">>
  ): Promise<PageSettings>;

  /** Fails with slot_taken when a confirmed booking already holds startAt. */
  insertBooking(booking: Booking): Promise<InsertBookingResult>;
  getBookingByToken(manageToken: string): Promise<Booking | null>;
  updateBooking(id: string, patch: Partial<Booking>): Promise<void>;
  /**
   * Reschedule primitive: compare-and-swaps from expectedStartAt, moves
   * startAt/endAt, and appends history. Fails stale when another reschedule
   * already moved this version; fails
   * with slot_taken when another confirmed booking already holds the target
   * start (the partial unique index enforces this atomically in Postgres),
   * and with not_confirmed when the row is no longer status "confirmed"
   * (a concurrent cancel won; rescheduling a cancelled booking must not
   * resurrect it).
   */
  updateBookingTime(
    id: string,
    expectedStartAt: string,
    startAt: string,
    endAt: string,
    history: Booking["history"],
    /** Defaults to [] for a normal move; compensation restores prior markers. */
    remindersSent?: Booking["remindersSent"]
  ): Promise<InsertBookingResult>;
  /**
   * Conditional cancel: transitions confirmed -> cancelled and reports
   * whether THIS call won the transition. Losers must not re-run side
   * effects (event deletion, emails).
   */
  transitionToCancelled(id: string, cancelledAt: string): Promise<boolean>;
  /**
   * Records that a reminder of `kind` was delivered, returning true only when
   * the booking is still confirmed and the marker was not already present.
   * Callers invoke this only after successful provider delivery so failures
   * remain retryable.
   */
  markReminderSent(id: string, kind: string): Promise<boolean>;
  /** Confirmed bookings overlapping [fromMs, toMs) — overlaid as busy time. */
  listConfirmedBookingsInRange(fromMs: number, toMs: number): Promise<Booking[]>;
  /**
   * Any future/in-progress confirmed booking naming this member or page.
   * Every team booking names every active member because team calendar events
   * and lifecycle emails invite/notify the full roster, even when only a
   * quorum is recorded in attendeeMemberKeys. This also covers degraded legacy
   * team rows whose attendee list is empty.
   */
  hasFutureConfirmedBookingForMember(memberKey: string, nowMs: number): Promise<boolean>;
  /**
   * Every booking starting inside [fromMs, toMs), cancelled ones included,
   * ascending by start. Admin-only listing: availability must keep using
   * listConfirmedBookingsInRange, which filters by status on purpose.
   */
  listBookingsStartingInRange(fromMs: number, toMs: number): Promise<Booking[]>;
}

/* ------------------------------------------------------------------ */
/* Supabase implementation                                             */
/* ------------------------------------------------------------------ */

interface AccountRow {
  id: string;
  member_key: string;
  provider: string;
  email: string;
  refresh_token_enc: string;
  selected_calendars: CalendarAccount["selectedCalendars"];
  status: string;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  member_key: string;
  name: string;
  email: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BookingRow {
  id: string;
  page_key: string;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  name: string;
  email: string;
  notes: string | null;
  timezone: string;
  attendee_member_keys: string[];
  guests: string[];
  event_refs: Booking["eventRefs"];
  meeting_url: string | null;
  status: string;
  manage_token: string;
  history: Booking["history"];
  reminders_sent: string[];
  sync_status: string;
  created_at: string;
  cancelled_at: string | null;
}

interface PageSettingsRow {
  member_key: string;
  enabled: boolean;
  headline: string | null;
  blurb: string | null;
  timezone: string | null;
  timezone_until_date: string | null;
  timezone_until_zone: string | null;
  window_start_min: number | null;
  window_end_min: number | null;
  bookable_weekdays: number[] | null;
  duration_minutes: number | null;
  slot_step_minutes: number | null;
  min_notice_minutes: number | null;
  horizon_days: number | null;
  event_title: string | null;
  event_description: string | null;
  slack_webhook_enc: string | null;
  created_at: string;
  updated_at: string;
}

function memberFromRow(row: MemberRow): MemberRecord {
  return {
    key: row.member_key,
    name: row.name,
    email: row.email,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pageSettingsFromRow(r: PageSettingsRow): PageSettings {
  return {
    memberKey: r.member_key,
    enabled: r.enabled,
    headline: r.headline,
    blurb: r.blurb,
    timezone: r.timezone ?? null,
    timezoneUntil:
      r.timezone_until_date && r.timezone_until_zone
        ? {
            beforeDate: r.timezone_until_date,
            timezone: r.timezone_until_zone,
          }
        : null,
    windowStartMin: r.window_start_min,
    windowEndMin: r.window_end_min,
    bookableWeekdays: r.bookable_weekdays,
    durationMinutes: r.duration_minutes,
    slotStepMinutes: r.slot_step_minutes,
    minNoticeMinutes: r.min_notice_minutes,
    horizonDays: r.horizon_days,
    eventTitle: r.event_title,
    eventDescription: r.event_description,
    slackWebhookEnc: r.slack_webhook_enc,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Only the keys present in `patch` are written, so a caller that means "leave
 * the headline alone" (omit) is never confused with "clear the headline"
 * (explicit null).
 */
function pageSettingsPatchToRow(
  patch: Partial<Omit<PageSettings, "memberKey" | "createdAt" | "updatedAt">>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.headline !== undefined) row.headline = patch.headline;
  if (patch.blurb !== undefined) row.blurb = patch.blurb;
  if (patch.timezone !== undefined) row.timezone = patch.timezone;
  if (patch.timezoneUntil !== undefined) {
    row.timezone_until_date = patch.timezoneUntil?.beforeDate ?? null;
    row.timezone_until_zone = patch.timezoneUntil?.timezone ?? null;
  }
  if (patch.windowStartMin !== undefined) row.window_start_min = patch.windowStartMin;
  if (patch.windowEndMin !== undefined) row.window_end_min = patch.windowEndMin;
  if (patch.bookableWeekdays !== undefined) row.bookable_weekdays = patch.bookableWeekdays;
  if (patch.durationMinutes !== undefined) row.duration_minutes = patch.durationMinutes;
  if (patch.slotStepMinutes !== undefined) row.slot_step_minutes = patch.slotStepMinutes;
  if (patch.minNoticeMinutes !== undefined) row.min_notice_minutes = patch.minNoticeMinutes;
  if (patch.horizonDays !== undefined) row.horizon_days = patch.horizonDays;
  if (patch.eventTitle !== undefined) row.event_title = patch.eventTitle;
  if (patch.eventDescription !== undefined) row.event_description = patch.eventDescription;
  if (patch.slackWebhookEnc !== undefined) row.slack_webhook_enc = patch.slackWebhookEnc;
  return row;
}

function accountFromRow(r: AccountRow): CalendarAccount {
  return {
    id: r.id,
    memberKey: r.member_key,
    provider: r.provider as CalendarAccount["provider"],
    email: r.email,
    refreshTokenEnc: r.refresh_token_enc,
    selectedCalendars: r.selected_calendars ?? [],
    status: (r.status as CalendarAccount["status"]) ?? "ok",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function bookingFromRow(r: BookingRow): Booking {
  return {
    id: r.id,
    // Rows written before personal pages existed have no page_key; they are
    // all team bookings, which is what "" means.
    pageKey: r.page_key ?? "",
    startAt: r.start_at,
    endAt: r.end_at,
    durationMinutes: r.duration_minutes,
    name: r.name,
    email: r.email,
    notes: r.notes,
    timezone: r.timezone,
    attendeeMemberKeys: r.attendee_member_keys ?? [],
    guests: r.guests ?? [],
    eventRefs: r.event_refs ?? [],
    meetingUrl: r.meeting_url,
    status: r.status as Booking["status"],
    manageToken: r.manage_token,
    history: r.history ?? [],
    remindersSent: r.reminders_sent ?? [],
    syncStatus: (r.sync_status as Booking["syncStatus"]) ?? "synced",
    createdAt: r.created_at,
    cancelledAt: r.cancelled_at,
  };
}

function bookingToRow(b: Booking): BookingRow {
  return {
    id: b.id,
    page_key: b.pageKey,
    start_at: b.startAt,
    end_at: b.endAt,
    duration_minutes: b.durationMinutes,
    name: b.name,
    email: b.email,
    notes: b.notes,
    timezone: b.timezone,
    attendee_member_keys: b.attendeeMemberKeys,
    guests: b.guests,
    event_refs: b.eventRefs,
    meeting_url: b.meetingUrl,
    status: b.status,
    manage_token: b.manageToken,
    history: b.history,
    reminders_sent: b.remindersSent,
    sync_status: b.syncStatus,
    created_at: b.createdAt,
    cancelled_at: b.cancelledAt,
  };
}

/**
 * True when a constraint violation came from the confirmed-slot index rather
 * than some other constraint on the table. Both index names are accepted so a
 * booking during the migration window still reads correctly.
 */
function isSlotConflict(error: { message: string; details?: string | null }): boolean {
  const detail = `${error.message} ${error.details ?? ""}`;
  return (
    detail.includes("meet_bookings_confirmed_page_slot") ||
    detail.includes("meet_bookings_confirmed_slot") ||
    // 23P01 comes from the overlap constraint, whose name matches neither
    // index. Without it a real overlap throws and the visitor gets a 500
    // instead of "that time was just booked".
    detail.includes("meet_bookings_no_overlap")
  );
}

class SupabaseMeetStore implements MeetStore {
  private client: SupabaseClient;

  constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("meet: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
    }
    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async listMemberRecords(): Promise<MemberRecord[]> {
    const { data, error } = await this.client
      .from("meet_members")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw new Error(`meet_members list failed: ${error.message}`);
    return (data as MemberRow[]).map(memberFromRow);
  }

  async getMemberRecord(memberKey: string): Promise<MemberRecord | null> {
    const { data, error } = await this.client
      .from("meet_members")
      .select("*")
      .eq("member_key", memberKey)
      .maybeSingle();
    if (error) throw new Error(`meet_members get failed: ${error.message}`);
    return data ? memberFromRow(data as MemberRow) : null;
  }

  private memberConflict(error: {
    code?: string;
    message: string;
    details?: string | null;
  }): MemberWriteResult | null {
    if (error.code !== "23505") return null;
    const detail = `${error.message} ${error.details ?? ""}`;
    return {
      ok: false,
      reason: detail.includes("meet_members_email_lower")
        ? "email_taken"
        : "key_taken",
    };
  }

  async insertMemberRecord(
    member: Omit<MemberRecord, "createdAt" | "updatedAt">
  ): Promise<MemberWriteResult> {
    const { data, error } = await this.client
      .from("meet_members")
      .insert({
        member_key: member.key,
        name: member.name,
        email: member.email,
        archived_at: member.archivedAt,
      })
      .select()
      .single();
    if (error) {
      const conflict = this.memberConflict(error);
      if (conflict) return conflict;
      throw new Error(`meet_members insert failed: ${error.message}`);
    }
    return { ok: true, member: memberFromRow(data as MemberRow) };
  }

  async ensureMemberRecord(
    member: Omit<MemberRecord, "createdAt" | "updatedAt">
  ): Promise<MemberWriteResult> {
    const { error } = await this.client
      .from("meet_members")
      .upsert(
        {
          member_key: member.key,
          name: member.name,
          email: member.email,
          archived_at: member.archivedAt,
        },
        { onConflict: "member_key", ignoreDuplicates: true }
      );
    if (error) {
      const conflict = this.memberConflict(error);
      if (conflict) return conflict;
      throw new Error(`meet_members ensure failed: ${error.message}`);
    }
    const ensured = await this.getMemberRecord(member.key);
    if (!ensured) {
      throw new Error(`meet_members ensure failed: ${member.key} was not written`);
    }
    return { ok: true, member: ensured };
  }

  async upsertMemberRecord(
    member: Omit<MemberRecord, "createdAt" | "updatedAt">
  ): Promise<MemberWriteResult> {
    const { data, error } = await this.client
      .from("meet_members")
      .upsert(
        {
          member_key: member.key,
          name: member.name,
          email: member.email,
          archived_at: member.archivedAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "member_key" }
      )
      .select()
      .single();
    if (error) {
      const conflict = this.memberConflict(error);
      if (conflict) return conflict;
      throw new Error(`meet_members upsert failed: ${error.message}`);
    }
    return { ok: true, member: memberFromRow(data as MemberRow) };
  }

  async updateMemberIdentity(
    memberKey: string,
    patch: Partial<Pick<MemberRecord, "name" | "email">>
  ): Promise<MemberWriteResult> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.email !== undefined) row.email = patch.email;
    if (Object.keys(row).length === 1) {
      const current = await this.getMemberRecord(memberKey);
      if (!current) {
        throw new Error(`meet_members identity update failed: unknown ${memberKey}`);
      }
      return { ok: true, member: current };
    }
    const { data, error } = await this.client
      .from("meet_members")
      .update(row)
      .eq("member_key", memberKey)
      .select()
      .single();
    if (error) {
      const conflict = this.memberConflict(error);
      if (conflict) return conflict;
      throw new Error(`meet_members identity update failed: ${error.message}`);
    }
    return { ok: true, member: memberFromRow(data as MemberRow) };
  }

  async updateMemberArchivedAt(
    memberKey: string,
    archivedAt: string | null
  ): Promise<MemberRecord> {
    const { data, error } = await this.client
      .from("meet_members")
      .update({
        archived_at: archivedAt,
        updated_at: new Date().toISOString(),
      })
      .eq("member_key", memberKey)
      .select()
      .single();
    if (error) throw new Error(`meet_members archive update failed: ${error.message}`);
    return memberFromRow(data as MemberRow);
  }

  async restoreMemberArchivedAt(
    memberKey: string,
    expectedArchivedAt: string
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from("meet_members")
      .update({ archived_at: null, updated_at: new Date().toISOString() })
      .eq("member_key", memberKey)
      .eq("archived_at", expectedArchivedAt)
      .select("member_key");
    if (error) throw new Error(`meet_members archive restore failed: ${error.message}`);
    return !!data && data.length > 0;
  }

  async listAccounts(): Promise<CalendarAccount[]> {
    const { data, error } = await this.client
      .from("meet_accounts")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw new Error(`meet_accounts list failed: ${error.message}`);
    return (data as AccountRow[]).map(accountFromRow);
  }

  async getAccount(id: string): Promise<CalendarAccount | null> {
    const { data, error } = await this.client
      .from("meet_accounts")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`meet_accounts get failed: ${error.message}`);
    return data ? accountFromRow(data as AccountRow) : null;
  }

  async upsertAccount(
    account: Omit<CalendarAccount, "id" | "createdAt" | "updatedAt">
  ): Promise<CalendarAccount> {
    const { data, error } = await this.client
      .from("meet_accounts")
      .upsert(
        {
          member_key: account.memberKey,
          provider: account.provider,
          email: account.email,
          refresh_token_enc: account.refreshTokenEnc,
          selected_calendars: account.selectedCalendars,
          status: account.status,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "member_key,provider,email" }
      )
      .select()
      .single();
    if (error) throw new Error(`meet_accounts upsert failed: ${error.message}`);
    return accountFromRow(data as AccountRow);
  }

  async updateAccount(
    id: string,
    patch: Partial<Pick<CalendarAccount, "selectedCalendars" | "status" | "refreshTokenEnc">>
  ): Promise<void> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.selectedCalendars !== undefined) row.selected_calendars = patch.selectedCalendars;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.refreshTokenEnc !== undefined) row.refresh_token_enc = patch.refreshTokenEnc;
    const { error } = await this.client.from("meet_accounts").update(row).eq("id", id);
    if (error) throw new Error(`meet_accounts update failed: ${error.message}`);
  }

  async deleteAccount(id: string): Promise<void> {
    const { error } = await this.client.from("meet_accounts").delete().eq("id", id);
    if (error) throw new Error(`meet_accounts delete failed: ${error.message}`);
  }

  async listPageSettings(): Promise<PageSettings[]> {
    const { data, error } = await this.client
      .from("meet_page_settings")
      .select("*")
      .order("member_key", { ascending: true });
    if (error) throw new Error(`meet_page_settings list failed: ${error.message}`);
    return (data as PageSettingsRow[]).map(pageSettingsFromRow);
  }

  async getPageSettings(memberKey: string): Promise<PageSettings | null> {
    const { data, error } = await this.client
      .from("meet_page_settings")
      .select("*")
      .eq("member_key", memberKey)
      .maybeSingle();
    if (error) throw new Error(`meet_page_settings get failed: ${error.message}`);
    return data ? pageSettingsFromRow(data as PageSettingsRow) : null;
  }

  async upsertPageSettings(
    memberKey: string,
    patch: Partial<Omit<PageSettings, "memberKey" | "createdAt" | "updatedAt">>
  ): Promise<PageSettings> {
    const { data, error } = await this.client
      .from("meet_page_settings")
      .upsert(
        {
          member_key: memberKey,
          ...pageSettingsPatchToRow(patch),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "member_key" }
      )
      .select()
      .single();
    if (error) throw new Error(`meet_page_settings upsert failed: ${error.message}`);
    return pageSettingsFromRow(data as PageSettingsRow);
  }

  async insertBooking(booking: Booking): Promise<InsertBookingResult> {
    const { error } = await this.client.from("meet_bookings").insert(bookingToRow(booking));
    if (error) {
      // 23505 = unique_violation, 23P01 = exclusion_violation. Only the
      // confirmed-slot index means "that time is taken"; the table also has a
      // unique manage_token, and reporting that as a slot conflict would hide
      // a real bug behind a phantom one.
      if ((error.code === "23505" || error.code === "23P01") && isSlotConflict(error)) {
        return { ok: false, reason: "slot_taken" };
      }
      throw new Error(`meet_bookings insert failed: ${error.message}`);
    }
    return { ok: true };
  }

  async getBookingByToken(manageToken: string): Promise<Booking | null> {
    const { data, error } = await this.client
      .from("meet_bookings")
      .select("*")
      .eq("manage_token", manageToken)
      .maybeSingle();
    if (error) throw new Error(`meet_bookings get failed: ${error.message}`);
    return data ? bookingFromRow(data as BookingRow) : null;
  }

  async updateBooking(id: string, patch: Partial<Booking>): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.startAt !== undefined) row.start_at = patch.startAt;
    if (patch.endAt !== undefined) row.end_at = patch.endAt;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.eventRefs !== undefined) row.event_refs = patch.eventRefs;
    if (patch.meetingUrl !== undefined) row.meeting_url = patch.meetingUrl;
    if (patch.history !== undefined) row.history = patch.history;
    if (patch.syncStatus !== undefined) row.sync_status = patch.syncStatus;
    if (patch.cancelledAt !== undefined) row.cancelled_at = patch.cancelledAt;
    if (patch.attendeeMemberKeys !== undefined) row.attendee_member_keys = patch.attendeeMemberKeys;
    if (patch.timezone !== undefined) row.timezone = patch.timezone;
    if (Object.keys(row).length === 0) return;
    const { error } = await this.client.from("meet_bookings").update(row).eq("id", id);
    if (error) throw new Error(`meet_bookings update failed: ${error.message}`);
  }

  async updateBookingTime(
    id: string,
    expectedStartAt: string,
    startAt: string,
    endAt: string,
    history: Booking["history"],
    remindersSent: Booking["remindersSent"] = []
  ): Promise<InsertBookingResult> {
    // Status + expected start make this a compare-and-swap: a concurrent
    // cancel or reschedule that already won makes this update match zero rows.
    const { data, error } = await this.client
      .from("meet_bookings")
      .update({ start_at: startAt, end_at: endAt, history, reminders_sent: remindersSent })
      .eq("id", id)
      .eq("status", "confirmed")
      .eq("start_at", expectedStartAt)
      .select("id");
    if (error) {
      if (error.code === "23505" || error.code === "23P01") {
        return { ok: false, reason: "slot_taken" };
      }
      throw new Error(`meet_bookings time update failed: ${error.message}`);
    }
    if (!data || data.length === 0) {
      const { data: current, error: currentError } = await this.client
        .from("meet_bookings")
        .select("status")
        .eq("id", id)
        .maybeSingle();
      if (currentError) {
        throw new Error(`meet_bookings stale-state read failed: ${currentError.message}`);
      }
      return current?.status === "confirmed"
        ? { ok: false, reason: "stale" }
        : { ok: false, reason: "not_confirmed" };
    }
    return { ok: true };
  }

  async transitionToCancelled(id: string, cancelledAt: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("meet_bookings")
      .update({ status: "cancelled", cancelled_at: cancelledAt })
      .eq("id", id)
      .eq("status", "confirmed")
      .select("id");
    if (error) throw new Error(`meet_bookings cancel failed: ${error.message}`);
    return !!data && data.length > 0;
  }

  async markReminderSent(id: string, kind: string): Promise<boolean> {
    // Read-modify-write guarded by a contains filter: a concurrent cron run
    // that already appended `kind` makes this update match zero rows.
    const { data: rows, error: readError } = await this.client
      .from("meet_bookings")
      .select("reminders_sent")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw new Error(`meet_bookings reminder read failed: ${readError.message}`);
    const current: string[] = (rows?.reminders_sent as string[] | null) ?? [];
    if (current.includes(kind)) return false;
    const { data, error } = await this.client
      .from("meet_bookings")
      .update({ reminders_sent: [...current, kind] })
      .eq("id", id)
      .eq("status", "confirmed")
      .not("reminders_sent", "cs", JSON.stringify([kind]))
      .select("id");
    if (error) throw new Error(`meet_bookings reminder mark failed: ${error.message}`);
    return !!data && data.length > 0;
  }

  async listConfirmedBookingsInRange(fromMs: number, toMs: number): Promise<Booking[]> {
    const { data, error } = await this.client
      .from("meet_bookings")
      .select("*")
      .eq("status", "confirmed")
      .lt("start_at", new Date(toMs).toISOString())
      .gt("end_at", new Date(fromMs).toISOString());
    if (error) throw new Error(`meet_bookings range failed: ${error.message}`);
    return (data as BookingRow[]).map(bookingFromRow);
  }

  async hasFutureConfirmedBookingForMember(
    memberKey: string,
    nowMs: number
  ): Promise<boolean> {
    const now = new Date(nowMs).toISOString();
    const [page, attendee, team] = await Promise.all([
      this.client
        .from("meet_bookings")
        .select("id", { count: "exact", head: true })
        .eq("status", "confirmed")
        .gt("end_at", now)
        .eq("page_key", memberKey),
      this.client
        .from("meet_bookings")
        .select("id", { count: "exact", head: true })
        .eq("status", "confirmed")
        .gt("end_at", now)
        .contains("attendee_member_keys", [memberKey]),
      this.client
        .from("meet_bookings")
        .select("id", { count: "exact", head: true })
        .eq("status", "confirmed")
        .gt("end_at", now)
        .eq("page_key", ""),
    ]);
    if (page.error) {
      throw new Error(`meet_bookings member-page preflight failed: ${page.error.message}`);
    }
    if (attendee.error) {
      throw new Error(
        `meet_bookings member-attendee preflight failed: ${attendee.error.message}`
      );
    }
    if (team.error) {
      throw new Error(
        `meet_bookings team preflight failed: ${team.error.message}`
      );
    }
    return (
      (page.count ?? 0) > 0 ||
      (attendee.count ?? 0) > 0 ||
      (team.count ?? 0) > 0
    );
  }

  async listBookingsStartingInRange(fromMs: number, toMs: number): Promise<Booking[]> {
    const { data, error } = await this.client
      .from("meet_bookings")
      .select("*")
      .gte("start_at", new Date(fromMs).toISOString())
      .lt("start_at", new Date(toMs).toISOString())
      .order("start_at", { ascending: true });
    if (error) throw new Error(`meet_bookings listing failed: ${error.message}`);
    return (data as BookingRow[]).map(bookingFromRow);
  }
}

/* ------------------------------------------------------------------ */
/* In-memory implementation (mock mode, unit tests)                    */
/* ------------------------------------------------------------------ */

export class MemoryMeetStore implements MeetStore {
  memberRecords: MemberRecord[] = [];
  accounts: CalendarAccount[] = [];
  bookings: Booking[] = [];
  pageSettings: PageSettings[] = [];

  async listMemberRecords(): Promise<MemberRecord[]> {
    return this.memberRecords.map((member) => ({ ...member }));
  }

  async getMemberRecord(memberKey: string): Promise<MemberRecord | null> {
    const found = this.memberRecords.find((member) => member.key === memberKey);
    return found ? { ...found } : null;
  }

  async insertMemberRecord(
    member: Omit<MemberRecord, "createdAt" | "updatedAt">
  ): Promise<MemberWriteResult> {
    if (this.memberRecords.some((row) => row.key === member.key)) {
      return { ok: false, reason: "key_taken" };
    }
    if (
      this.memberRecords.some(
        (row) => row.email.toLowerCase() === member.email.toLowerCase()
      )
    ) {
      return { ok: false, reason: "email_taken" };
    }
    const now = new Date().toISOString();
    const created: MemberRecord = { ...member, createdAt: now, updatedAt: now };
    this.memberRecords.push(created);
    return { ok: true, member: { ...created } };
  }

  async ensureMemberRecord(
    member: Omit<MemberRecord, "createdAt" | "updatedAt">
  ): Promise<MemberWriteResult> {
    const existing = this.memberRecords.find((row) => row.key === member.key);
    if (existing) return { ok: true, member: { ...existing } };
    return this.insertMemberRecord(member);
  }

  async upsertMemberRecord(
    member: Omit<MemberRecord, "createdAt" | "updatedAt">
  ): Promise<MemberWriteResult> {
    if (
      this.memberRecords.some(
        (row) =>
          row.key !== member.key &&
          row.email.toLowerCase() === member.email.toLowerCase()
      )
    ) {
      return { ok: false, reason: "email_taken" };
    }
    const now = new Date().toISOString();
    const existing = this.memberRecords.find((row) => row.key === member.key);
    if (existing) {
      Object.assign(existing, member, { updatedAt: now });
      return { ok: true, member: { ...existing } };
    }
    const created: MemberRecord = { ...member, createdAt: now, updatedAt: now };
    this.memberRecords.push(created);
    return { ok: true, member: { ...created } };
  }

  async updateMemberIdentity(
    memberKey: string,
    patch: Partial<Pick<MemberRecord, "name" | "email">>
  ): Promise<MemberWriteResult> {
    const existing = this.memberRecords.find((row) => row.key === memberKey);
    if (!existing) {
      throw new Error(`meet_members identity update failed: unknown ${memberKey}`);
    }
    if (
      patch.email !== undefined &&
      this.memberRecords.some(
        (row) =>
          row.key !== memberKey &&
          row.email.toLowerCase() === patch.email?.toLowerCase()
      )
    ) {
      return { ok: false, reason: "email_taken" };
    }
    if (patch.name !== undefined) existing.name = patch.name;
    if (patch.email !== undefined) existing.email = patch.email;
    existing.updatedAt = new Date().toISOString();
    return { ok: true, member: { ...existing } };
  }

  async updateMemberArchivedAt(
    memberKey: string,
    archivedAt: string | null
  ): Promise<MemberRecord> {
    const existing = this.memberRecords.find((row) => row.key === memberKey);
    if (!existing) {
      throw new Error(`meet_members archive update failed: unknown ${memberKey}`);
    }
    existing.archivedAt = archivedAt;
    existing.updatedAt = new Date().toISOString();
    return { ...existing };
  }

  async restoreMemberArchivedAt(
    memberKey: string,
    expectedArchivedAt: string
  ): Promise<boolean> {
    const existing = this.memberRecords.find((row) => row.key === memberKey);
    if (!existing || existing.archivedAt !== expectedArchivedAt) return false;
    existing.archivedAt = null;
    existing.updatedAt = new Date().toISOString();
    return true;
  }

  async listAccounts(): Promise<CalendarAccount[]> {
    return [...this.accounts];
  }

  async getAccount(id: string): Promise<CalendarAccount | null> {
    return this.accounts.find((a) => a.id === id) ?? null;
  }

  async upsertAccount(
    account: Omit<CalendarAccount, "id" | "createdAt" | "updatedAt">
  ): Promise<CalendarAccount> {
    const now = new Date().toISOString();
    const existing = this.accounts.find(
      (a) =>
        a.memberKey === account.memberKey &&
        a.provider === account.provider &&
        a.email === account.email
    );
    if (existing) {
      Object.assign(existing, account, { updatedAt: now });
      return existing;
    }
    const created: CalendarAccount = {
      ...account,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.push(created);
    return created;
  }

  async updateAccount(
    id: string,
    patch: Partial<Pick<CalendarAccount, "selectedCalendars" | "status" | "refreshTokenEnc">>
  ): Promise<void> {
    const account = this.accounts.find((a) => a.id === id);
    if (account) Object.assign(account, patch, { updatedAt: new Date().toISOString() });
  }

  async deleteAccount(id: string): Promise<void> {
    this.accounts = this.accounts.filter((a) => a.id !== id);
  }

  async listPageSettings(): Promise<PageSettings[]> {
    return this.pageSettings.map((p) => ({ ...p }));
  }

  async getPageSettings(memberKey: string): Promise<PageSettings | null> {
    const found = this.pageSettings.find((p) => p.memberKey === memberKey);
    return found ? { ...found } : null;
  }

  async upsertPageSettings(
    memberKey: string,
    patch: Partial<Omit<PageSettings, "memberKey" | "createdAt" | "updatedAt">>
  ): Promise<PageSettings> {
    const now = new Date().toISOString();
    // Mirrors the SQL upsert: only keys present in the patch are written, so
    // an omitted field keeps its stored value and an explicit null clears it.
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    );
    const existing = this.pageSettings.find((p) => p.memberKey === memberKey);
    if (existing) {
      Object.assign(existing, defined, { updatedAt: now });
      return { ...existing };
    }
    const created: PageSettings = {
      memberKey,
      enabled: true,
      headline: null,
      blurb: null,
      timezone: null,
      timezoneUntil: null,
      windowStartMin: null,
      windowEndMin: null,
      bookableWeekdays: null,
      durationMinutes: null,
      slotStepMinutes: null,
      minNoticeMinutes: null,
      horizonDays: null,
      eventTitle: null,
      eventDescription: null,
      slackWebhookEnc: null,
      createdAt: now,
      updatedAt: now,
      ...defined,
    };
    this.pageSettings.push(created);
    return { ...created };
  }

  async insertBooking(booking: Booking): Promise<InsertBookingResult> {
    // Hand-written mirror of meet_bookings_confirmed_page_slot. If this drifts
    // from the SQL index, mock mode and the whole test suite keep proving a
    // rule production does not have.
    const clash = this.bookings.some(
      (b) =>
        b.status === "confirmed" &&
        b.startAt === booking.startAt &&
        b.pageKey === booking.pageKey
    );
    if (clash) return { ok: false, reason: "slot_taken" };
    this.bookings.push({ ...booking });
    return { ok: true };
  }

  async getBookingByToken(manageToken: string): Promise<Booking | null> {
    return this.bookings.find((b) => b.manageToken === manageToken) ?? null;
  }

  async updateBooking(id: string, patch: Partial<Booking>): Promise<void> {
    const booking = this.bookings.find((b) => b.id === id);
    if (booking) Object.assign(booking, patch);
  }

  async updateBookingTime(
    id: string,
    expectedStartAt: string,
    startAt: string,
    endAt: string,
    history: Booking["history"],
    remindersSent: Booking["remindersSent"] = []
  ): Promise<InsertBookingResult> {
    const booking = this.bookings.find((b) => b.id === id);
    if (!booking || booking.status !== "confirmed") {
      return { ok: false, reason: "not_confirmed" };
    }
    if (booking.startAt !== expectedStartAt) {
      return { ok: false, reason: "stale" };
    }
    const clash = this.bookings.some(
      (b) =>
        b.id !== id &&
        b.status === "confirmed" &&
        b.startAt === startAt &&
        b.pageKey === booking.pageKey
    );
    if (clash) return { ok: false, reason: "slot_taken" };
    booking.startAt = startAt;
    booking.endAt = endAt;
    booking.history = history;
    booking.remindersSent = [...remindersSent];
    return { ok: true };
  }

  async transitionToCancelled(id: string, cancelledAt: string): Promise<boolean> {
    const booking = this.bookings.find((b) => b.id === id);
    if (!booking || booking.status !== "confirmed") return false;
    booking.status = "cancelled";
    booking.cancelledAt = cancelledAt;
    return true;
  }

  async markReminderSent(id: string, kind: string): Promise<boolean> {
    const booking = this.bookings.find((b) => b.id === id);
    if (!booking || booking.status !== "confirmed") return false;
    if (booking.remindersSent.includes(kind)) return false;
    booking.remindersSent = [...booking.remindersSent, kind];
    return true;
  }

  async listConfirmedBookingsInRange(fromMs: number, toMs: number): Promise<Booking[]> {
    return this.bookings.filter(
      (b) =>
        b.status === "confirmed" &&
        Date.parse(b.startAt) < toMs &&
        Date.parse(b.endAt) > fromMs
    );
  }

  async hasFutureConfirmedBookingForMember(
    memberKey: string,
    nowMs: number
  ): Promise<boolean> {
    return this.bookings.some(
      (booking) =>
        booking.status === "confirmed" &&
        Date.parse(booking.endAt) > nowMs &&
        (booking.pageKey === memberKey ||
          booking.attendeeMemberKeys.includes(memberKey) ||
          booking.pageKey === "")
    );
  }

  async listBookingsStartingInRange(fromMs: number, toMs: number): Promise<Booking[]> {
    return this.bookings
      .filter((b) => Date.parse(b.startAt) >= fromMs && Date.parse(b.startAt) < toMs)
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  }
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

// One store per lambda instance. globalThis-stashed so Next dev HMR and
// route-handler module duplication share the same memory store.
const STORE_KEY = "__meet_store__" as const;

type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: MeetStore };

export function getMeetStore(): MeetStore {
  const g = globalThis as GlobalWithStore;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = getMeetConfig().mockMode ? new MemoryMeetStore() : new SupabaseMeetStore();
  }
  return g[STORE_KEY];
}

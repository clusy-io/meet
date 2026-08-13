import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getMeetConfig } from "./config";
import type { Booking, CalendarAccount } from "./types";

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

export interface MeetStore {
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
    history: Booking["history"]
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

interface BookingRow {
  id: string;
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

  async insertBooking(booking: Booking): Promise<InsertBookingResult> {
    const { error } = await this.client.from("meet_bookings").insert(bookingToRow(booking));
    if (error) {
      // 23505 = unique_violation on the confirmed-slot index.
      if (error.code === "23505" || error.code === "23P01") {
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
    history: Booking["history"]
  ): Promise<InsertBookingResult> {
    // Status + expected start make this a compare-and-swap: a concurrent
    // cancel or reschedule that already won makes this update match zero rows.
    const { data, error } = await this.client
      .from("meet_bookings")
      .update({ start_at: startAt, end_at: endAt, history, reminders_sent: [] })
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
  accounts: CalendarAccount[] = [];
  bookings: Booking[] = [];

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

  async insertBooking(booking: Booking): Promise<InsertBookingResult> {
    const clash = this.bookings.some(
      (b) => b.status === "confirmed" && b.startAt === booking.startAt
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
    history: Booking["history"]
  ): Promise<InsertBookingResult> {
    const booking = this.bookings.find((b) => b.id === id);
    if (!booking || booking.status !== "confirmed") {
      return { ok: false, reason: "not_confirmed" };
    }
    if (booking.startAt !== expectedStartAt) {
      return { ok: false, reason: "stale" };
    }
    const clash = this.bookings.some(
      (b) => b.id !== id && b.status === "confirmed" && b.startAt === startAt
    );
    if (clash) return { ok: false, reason: "slot_taken" };
    booking.startAt = startAt;
    booking.endAt = endAt;
    booking.history = history;
    booking.remindersSent = [];
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

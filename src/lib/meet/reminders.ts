import type { Booking } from "./types";

/**
 * clusy/meet: reminder scheduling logic, pure and clock-injected so the
 * windows are unit-testable. The cron route owns the I/O.
 */

export interface ReminderKind {
  kind: string;
  /** Reminder fires when now >= start - leadMs. */
  leadMs: number;
  /**
   * Skip when the booking was created after (start - leadMs - graceMs):
   * whoever books inside the reminder window just received the confirmation
   * email, and a reminder seconds later reads as a duplicate.
   */
  graceMs: number;
}

export const REMINDER_KINDS: ReminderKind[] = [
  { kind: "24h", leadMs: 24 * 3_600_000, graceMs: 3_600_000 },
  { kind: "1h", leadMs: 3_600_000, graceMs: 3_600_000 },
];

/**
 * Reminder kinds due for a booking at `nowMs`: confirmed, meeting not yet
 * started, inside the kind's window, not already sent, and not booked so
 * recently that the confirmation email still counts as the reminder.
 */
export function dueReminderKinds(booking: Booking, nowMs: number): string[] {
  if (booking.status !== "confirmed") return [];
  const startMs = Date.parse(booking.startAt);
  if (!Number.isFinite(startMs) || nowMs >= startMs) return [];
  const createdMs = Date.parse(booking.createdAt);

  const due: string[] = [];
  for (const { kind, leadMs, graceMs } of REMINDER_KINDS) {
    if (booking.remindersSent.includes(kind)) continue;
    if (nowMs < startMs - leadMs) continue;
    if (Number.isFinite(createdMs) && createdMs > startMs - leadMs - graceMs) continue;
    due.push(kind);
  }
  return due;
}

/** Human phrasing for email subjects ("24h" -> "in 24 hours"). */
export function reminderPhrase(kind: string): string {
  if (kind === "24h") return "tomorrow";
  if (kind === "1h") return "in one hour";
  return "soon";
}

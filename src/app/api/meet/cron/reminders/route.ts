import { NextResponse } from "next/server";
import { getMeetConfig } from "@/lib/meet/config";
import { sendBookingReminder } from "@/lib/meet/emails";
import { dueReminderKinds, REMINDER_KINDS, reminderPhrase } from "@/lib/meet/reminders";
import { notifyBookingSlack } from "@/lib/meet/slackNotify";
import { getMeetStore } from "@/lib/meet/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reminder dispatch, invoked by Vercel Cron every 15 minutes (vercel.json).
 *
 * Routing contract: the booker is reminded at their own address in their own
 * timezone; the team copy goes to every configured member, with the attending
 * ones named in the body (see teamRecipients in emails.ts).
 * Delivery happens before remindersSent is recorded: a provider failure must
 * leave the reminder eligible for the next cron run rather than suppressing it
 * forever. A reschedule clears remindersSent and re-arms both kinds.
 */
export async function GET(request: Request) {
  const config = getMeetConfig();
  const cronSecret = config.cronSecret;
  const auth = request.headers.get("authorization");
  const isCron = !!cronSecret && auth === `Bearer ${cronSecret}`;
  // Production accepts only the dedicated bearer secret. This endpoint mutates
  // reminder state, so an admin browser cookie must never authorize a GET.
  if (!isCron && !config.mockMode) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }

  const store = getMeetStore();
  const nowMs = Date.now();
  // Widest lead among the kinds bounds how far ahead a reminder can be due.
  const maxLeadMs = Math.max(...REMINDER_KINDS.map((k) => k.leadMs));
  const upcoming = await store.listConfirmedBookingsInRange(nowMs, nowMs + maxLeadMs + 3_600_000);

  let sent = 0;
  const failures: string[] = [];
  for (const booking of upcoming) {
    // The roster the body resolves "Attending" against. Narrowed for a
    // personal booking so its reminder names one person, not the whole team;
    // the recipient list itself is decided inside emails.ts.
    const host = booking.pageKey
      ? config.members.find((m) => m.key === booking.pageKey)
      : undefined;
    const memberScope = host ? [host] : config.members;
    for (const kind of dueReminderKinds(booking, nowMs)) {
      try {
        await sendBookingReminder(booking, memberScope, kind, reminderPhrase(kind));
        const recorded = await store.markReminderSent(booking.id, kind);
        if (!recorded) {
          failures.push(`${booking.id}:${kind}:state_changed`);
          continue;
        }
        sent++;
        // After the conditional write, so a run that lost the race to another
        // cron invocation does not double-post. notifyBookingSlack never
        // throws, so it cannot turn a delivered reminder into a retried one.
        if (kind === "24h" || kind === "1h") {
          await notifyBookingSlack(booking, kind);
        }
      } catch (err) {
        console.error(`meet: ${kind} reminder failed for booking ${booking.id}`, err);
        failures.push(`${booking.id}:${kind}`);
      }
    }
  }

  return NextResponse.json({ checked: upcoming.length, sent, failures });
}

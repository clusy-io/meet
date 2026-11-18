import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/meet/admin";
import { getHistoricalMeetConfig } from "@/lib/meet/members";
import { investorWindow } from "@/lib/meet/meetingTypes";
import { getMeetStore } from "@/lib/meet/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bookings listing for /admin: everything scheduled in a window around
 * now, cancelled rows included, so the console shows what the calendar
 * config actually produced. Admin-gated; the manage link is handed over
 * whole because an authenticated admin may need to cancel or move a call
 * on someone's behalf.
 */

const PAST_DAYS = 30;
/** Past the booking horizon, to catch anything created before it shrank. */
const FUTURE_DAYS = 120;
const DAY_MS = 86_400_000;

export async function GET(request: Request) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }

  const config = await getHistoricalMeetConfig();
  const nowMs = Date.now();
  const store = getMeetStore();
  const rangeEnd = nowMs + FUTURE_DAYS * DAY_MS;
  const investor = investorWindow(config);
  // Investors can book their configured dates before the ordinary agenda reaches them.
  const [ordinaryWindow, investorWindowBookings] = await Promise.all([
    store.listBookingsStartingInRange(nowMs - PAST_DAYS * DAY_MS, rangeEnd),
    investor && investor.toMs > rangeEnd
      ? store.listBookingsStartingInRange(Math.max(rangeEnd, investor.fromMs), investor.toMs)
      : [],
  ]);
  const bookings = [...ordinaryWindow, ...investorWindowBookings];

  return NextResponse.json({
    hostTimezone: config.hostTimezone,
    members: config.members,
    bookings: bookings.map((b) => ({
      id: b.id,
      meetingType: b.meetingType ?? null,
      startAt: b.startAt,
      endAt: b.endAt,
      durationMinutes: b.durationMinutes,
      name: b.name,
      email: b.email,
      guests: b.guests,
      notes: b.notes,
      timezone: b.timezone,
      attendeeMemberKeys: b.attendeeMemberKeys,
      meetingUrl: b.meetingUrl,
      status: b.status,
      syncStatus: b.syncStatus,
      /** Non-zero means the booker moved the call at least once. */
      rescheduleCount: b.history.length,
      /** Every previous time for an expanded operational audit trail. */
      history: b.history,
      remindersSent: b.remindersSent,
      manageUrl: `${config.siteOrigin}/manage/${b.manageToken}`,
      createdAt: b.createdAt,
      cancelledAt: b.cancelledAt,
    })),
  });
}

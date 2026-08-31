import "server-only";

import { getHistoricalMeetConfig } from "./members";
import { slackWebhookForPage } from "./pages";
import {
  getMeetingSlackSettings,
  postMeetingSlackEvent,
  type MeetingSlackEventType,
} from "./slack";
import type { Booking } from "./types";

/**
 * meet — the one entry point the booking lifecycle uses to announce
 * itself in Slack.
 *
 * Best-effort by construction. A Slack outage must never fail a booking, delay
 * the response the visitor is waiting on, degrade syncStatus, or (in the cron)
 * make a delivered reminder look undelivered and be sent again. So this
 * function never throws and never rejects: every failure is swallowed after a
 * categorical log line.
 *
 * Routing: a personal page posts to its own webhook when one is configured in
 * /admin, otherwise to the team-wide MEET_SLACK_WEBHOOK_URL. Everything
 * lands in the team channel by default, which is what keeps personal bookings
 * visible to the whole team even though their email goes to one person.
 *
 * Server-only.
 */

export async function notifyBookingSlack(
  booking: Booking,
  type: MeetingSlackEventType,
  previousStartAt?: string
): Promise<void> {
  try {
    const settings = getMeetingSlackSettings();
    if (settings.state !== "enabled") return;
    // The activation timestamp is also a cutoff: a booking made before Slack
    // was switched on is never announced retroactively.
    if (Date.parse(booking.createdAt) < settings.enabledAtMs && type !== "cancelled") return;

    const config = await getHistoricalMeetConfig();
    const host = booking.pageKey
      ? config.members.find((m) => m.key === booking.pageKey)
      : undefined;

    const webhookUrl = await slackWebhookForPage(booking.pageKey, settings.webhookUrl);
    const result = await postMeetingSlackEvent(
      webhookUrl,
      {
        bookingId: booking.id,
        type,
        startAt: booking.startAt,
        endAt: booking.endAt,
        hostName: host?.name ?? null,
        bookerName: booking.name,
        meetingUrl: booking.meetingUrl,
        ...(previousStartAt === undefined ? {} : { previousStartAt }),
      },
      config.hostTimezone,
      settings.referenceSecret
    );
    if (!result.ok) {
      // Categorical on purpose: Slack bodies and webhook URLs are secrets.
      console.error(`meet slack: ${type} notice not delivered (${result.reason})`);
    }
  } catch {
    console.error(`meet slack: ${type} notice failed`);
  }
}

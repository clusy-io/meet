import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/meet/admin";
import { getMeetConfig } from "@/lib/meet/config";
import { ensureMockReady } from "@/lib/meet/mock";
import { listPages } from "@/lib/meet/pages";
import { getMeetStore } from "@/lib/meet/store";
import { minutesToClock } from "@/lib/meet/tz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Personal booking pages, for the admin console.
 *
 * Every configured member appears, whether or not they have a settings row:
 * a member with no row is a live page on inherited defaults, and the console
 * has to be able to see and edit it. Effective values are resolved so the UI
 * can show what the page actually does, while `overrides` says which of them
 * are stored here rather than inherited, so the form can render inherited
 * values as placeholders.
 */
export async function GET(request: Request) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }
  const config = getMeetConfig();
  if (config.mockMode) await ensureMockReady();

  const [pages, accounts] = await Promise.all([listPages(), getMeetStore().listAccounts()]);

  return NextResponse.json({
    hostTimezone: config.hostTimezone,
    defaults: {
      durationMinutes: config.durationMinutes,
      slotStepMinutes: config.slotStepMinutes,
      windowStart: minutesToClock(config.windowStartMin),
      windowEnd: minutesToClock(config.windowEndMin),
      minNoticeMinutes: config.minNoticeMinutes,
      horizonDays: config.horizonDays,
      eventTitle: config.eventTitle,
    },
    pages: pages.map((page) => {
      const stored = page.settings;
      return {
        memberKey: page.member.key,
        memberName: page.member.name,
        url: `${config.siteOrigin}/${page.member.key}`,
        enabled: page.enabled,
        headline: stored?.headline ?? null,
        blurb: stored?.blurb ?? null,
        // What the page actually runs on, defaults folded in.
        effective: {
          durationMinutes: page.config.durationMinutes,
          slotStepMinutes: page.config.slotStepMinutes,
          windowStart: minutesToClock(page.config.windowStartMin),
          windowEnd: minutesToClock(page.config.windowEndMin),
          minNoticeMinutes: page.config.minNoticeMinutes,
          horizonDays: page.config.horizonDays,
          bookableWeekdays: page.config.bookableWeekdays,
          eventTitle: page.config.eventTitle,
          eventDescription: page.config.eventDescription,
        },
        // Which of those are this page's own, so the form can distinguish an
        // override from an inherited value.
        overrides: {
          durationMinutes: stored?.durationMinutes ?? null,
          slotStepMinutes: stored?.slotStepMinutes ?? null,
          windowStartMin: stored?.windowStartMin ?? null,
          windowEndMin: stored?.windowEndMin ?? null,
          minNoticeMinutes: stored?.minNoticeMinutes ?? null,
          horizonDays: stored?.horizonDays ?? null,
          bookableWeekdays: stored?.bookableWeekdays ?? null,
          eventTitle: stored?.eventTitle ?? null,
          eventDescription: stored?.eventDescription ?? null,
        },
        // Presence only. The webhook is a live posting credential; neither it
        // nor its ciphertext leaves the server, exactly like refresh tokens.
        slackWebhookConfigured: page.slackWebhookEnc !== null,
        // A page with no readable calendar can only ever show an empty
        // month — surfaced here so enabling one is not a silent dead end.
        calendarReady: accounts.some(
          (a) => a.memberKey === page.member.key && a.status === "ok" && a.selectedCalendars.length > 0
        ),
      };
    }),
  });
}

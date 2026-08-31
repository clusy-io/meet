import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/meet/admin";
import type { MeetConfig } from "@/lib/meet/config";
import { ensureMockReady } from "@/lib/meet/mock";
import { getEffectiveMeetConfig, listEffectiveMembers } from "@/lib/meet/members";
import { configForPage, listPages } from "@/lib/meet/pages";
import { zoneForCivilDay } from "@/lib/meet/slots";
import { getMeetStore } from "@/lib/meet/store";
import { minutesToClock, utcToWall } from "@/lib/meet/tz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function todayCivil(config: MeetConfig): { year: number; month: number; day: number } {
  const wall = utcToWall(config.hostTimezone, Date.now());
  return { year: wall.year, month: wall.month, day: wall.day };
}

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
  const config = await getEffectiveMeetConfig();
  if (config.mockMode) await ensureMockReady();

  const [pages, accounts, managedMembers] = await Promise.all([
    listPages(config),
    getMeetStore().listAccounts(),
    listEffectiveMembers(),
  ]);

  return NextResponse.json({
    hostTimezone: config.hostTimezone,
    defaults: {
      timezone: config.hostTimezone,
      timezoneToday: zoneForCivilDay(config, todayCivil(config)),
      timezoneUntil: config.timezoneUntil ?? null,
      durationMinutes: config.durationMinutes,
      slotStepMinutes: config.slotStepMinutes,
      windowStart: minutesToClock(config.windowStartMin),
      windowEnd: minutesToClock(config.windowEndMin),
      minNoticeMinutes: config.minNoticeMinutes,
      horizonDays: config.horizonDays,
      bookableWeekdays: config.bookableWeekdays,
      eventTitle: config.eventTitle,
      eventDescription: config.eventDescription,
    },
    archivedMembers: managedMembers
      .filter((member) => member.archived)
      .map(({ key, name, email }) => ({ key, name, email })),
    pages: pages.map((page) => {
      const stored = page.settings;
      const inherited = configForPage(config, page.member, null);
      return {
        memberKey: page.member.key,
        memberName: page.member.name,
        memberEmail: page.member.email,
        url: `${config.siteOrigin}/${page.member.key}`,
        enabled: page.enabled,
        headline: stored?.headline ?? null,
        blurb: stored?.blurb ?? null,
        // Personal pages generate host-specific invite copy even without a
        // stored row. Expose that baseline so inherited labels and the live
        // preview describe the real booking page.
        inherited: {
          timezone: inherited.hostTimezone,
          timezoneToday: zoneForCivilDay(inherited, todayCivil(inherited)),
          timezoneUntil: inherited.timezoneUntil ?? null,
          durationMinutes: inherited.durationMinutes,
          slotStepMinutes: inherited.slotStepMinutes,
          windowStart: minutesToClock(inherited.windowStartMin),
          windowEnd: minutesToClock(inherited.windowEndMin),
          minNoticeMinutes: inherited.minNoticeMinutes,
          horizonDays: inherited.horizonDays,
          bookableWeekdays: inherited.bookableWeekdays,
          eventTitle: inherited.eventTitle,
          eventDescription: inherited.eventDescription,
        },
        // What the page actually runs on, defaults folded in.
        effective: {
          timezone: page.config.hostTimezone,
          timezoneToday: zoneForCivilDay(page.config, todayCivil(page.config)),
          timezoneUntil: page.config.timezoneUntil ?? null,
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
          timezone: stored?.timezone ?? null,
          timezoneUntil: stored?.timezoneUntil ?? null,
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

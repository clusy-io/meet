import "server-only";

import { cache } from "react";
import { getMeetConfig, type MeetConfig } from "./config";
import { decryptSecret } from "./crypto";
import { getMeetStore } from "./store";
import type { Member, PageSettings } from "./types";

/**
 * meet — personal booking pages (/<memberKey>).
 *
 * The team page at / asks for a quorum of members; a personal page asks
 * for exactly one, so nearly everything downstream can be reused by handing
 * it a MeetConfig whose quorum is 1 and whose window/duration carry that
 * person's overrides.
 *
 * Settings live in the DB (meet_page_settings), not in env: they are edited
 * from /admin at runtime, and getMeetConfig() memoizes one object for the
 * life of the lambda, so an env-backed setting would need a redeploy to take
 * effect and would differ between warm instances until then. Server-only.
 */

/**
 * Path segments a member key may never be.
 *
 * The personal page is a ROOT dynamic segment here, not nested under a /meet
 * prefix, so its siblings are the whole top level. Next.js resolves a static
 * segment before a dynamic one, so /admin and /manage/<token> keep their own
 * pages regardless — but everything with no route of its own falls through to
 * this one, including bare /manage, /api if its route ever moved, and stray
 * probes like /.env or /wp-login.php. Matching is case-sensitive, so keys are
 * lowercased before the comparison and /Admin cannot slip past.
 */
const RESERVED_SLUGS = new Set(["admin", "manage", "api"]);

export interface MeetPage {
  member: Member;
  /** Live pages are reachable; disabled ones 404 for visitors. */
  enabled: boolean;
  /** Page heading, defaulting to the member's name. */
  headline: string;
  blurb: string | null;
  /**
   * Global config with this page's overrides applied and quorum forced to 1.
   * A fresh object every time: getMeetConfig() hands out one memoized instance
   * shared by every request on the lambda, so mutating it would change the
   * team page's rules process-wide.
   */
  config: MeetConfig;
  /** Ciphertext, or null to fall back to the team-wide Slack webhook. */
  slackWebhookEnc: string | null;
  /** The stored row, or null when the page runs on pure inherited settings. */
  settings: PageSettings | null;
}

/**
 * Apply one page's overrides to the global config.
 *
 * Every override is bounds-checked here as well as at the admin write path:
 * a row written by an older/looser version, or edited directly in the DB,
 * must not be able to produce a config that makes candidateSlots loop forever
 * or offer slots the booking path will then reject.
 */
export function configForPage(
  base: MeetConfig,
  member: Member,
  settings: PageSettings | null
): MeetConfig {
  const config: MeetConfig = {
    ...base,
    // A personal page is booked when its one owner is free. This is why the
    // page can reuse availableSlots unchanged.
    quorum: 1,
  };
  // A personal call is not a call with the company. The global default
  // ("Clusy <> {name}") reads wrong in the invite the host themselves
  // receives, so name the host instead, and point the description at the page
  // that was actually booked. Both remain overridable per page below.
  config.eventTitle = `${member.name} <> {name}`;
  config.eventDescription =
    `Call with ${member.name} at ${base.brandName}. ` +
    `Booked via ${base.siteOrigin.replace(/^https?:\/\//, "")}/${member.key}.`;

  if (!settings) return config;

  const windowStart = settings.windowStartMin ?? base.windowStartMin;
  const windowEnd = settings.windowEndMin ?? base.windowEndMin;
  if (windowStart < windowEnd) {
    config.windowStartMin = windowStart;
    config.windowEndMin = windowEnd;
  }

  const duration = settings.durationMinutes ?? base.durationMinutes;
  if (duration > 0 && duration <= config.windowEndMin - config.windowStartMin) {
    config.durationMinutes = duration;
  }

  // The step drives the slot grid; below the duration it would offer
  // overlapping slots, which the booking-time check would then reject.
  // Clamp rather than skip. Skipping left the INHERITED step in place, so a
  // page that lengthened its meetings past the team-wide step (45 minutes on a
  // 30-minute grid) got overlapping slots offered and then refused at booking.
  const step = settings.slotStepMinutes ?? base.slotStepMinutes;
  config.slotStepMinutes = Math.max(step, config.durationMinutes);

  if (settings.minNoticeMinutes !== null && settings.minNoticeMinutes >= 0) {
    config.minNoticeMinutes = settings.minNoticeMinutes;
  }
  if (
    settings.horizonDays !== null &&
    settings.horizonDays >= 0 &&
    settings.horizonDays <= 366
  ) {
    config.horizonDays = settings.horizonDays;
  }

  const weekdays = settings.bookableWeekdays;
  if (Array.isArray(weekdays)) {
    const valid = [...new Set(weekdays)].filter(
      (d) => Number.isInteger(d) && d >= 1 && d <= 7
    );
    if (valid.length > 0) config.bookableWeekdays = valid.sort((a, b) => a - b);
  }

  if (settings.eventTitle) config.eventTitle = settings.eventTitle;
  if (settings.eventDescription) config.eventDescription = settings.eventDescription;

  return config;
}

function toPage(member: Member, settings: PageSettings | null): MeetPage {
  return {
    member,
    enabled: settings?.enabled ?? true,
    headline: settings?.headline?.trim() || member.name,
    blurb: settings?.blurb?.trim() || null,
    config: configForPage(getMeetConfig(), member, settings),
    slackWebhookEnc: settings?.slackWebhookEnc ?? null,
    settings,
  };
}

/** True for a slug that is a real route of its own, not a person. */
export function isReservedPageSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.trim().toLowerCase());
}

/**
 * The page for one member key, or null when the key is not a configured
 * member. Callers decide what an existing-but-disabled page means: visitors
 * get a 404, the admin console still lists it.
 */
export const getPage = cache(async (memberKey: string): Promise<MeetPage | null> => {
  if (isReservedPageSlug(memberKey)) return null;
  const member = getMeetConfig().members.find((m) => m.key === memberKey);
  if (!member) return null;
  return toPage(member, await getMeetStore().getPageSettings(memberKey));
});

/** Every configured member's page, in config order, live or not. */
export async function listPages(): Promise<MeetPage[]> {
  const config = getMeetConfig();
  const rows = await getMeetStore().listPageSettings();
  const byKey = new Map(rows.map((r) => [r.memberKey, r]));
  return config.members.map((member) => toPage(member, byKey.get(member.key) ?? null));
}

/**
 * The Slack webhook a page's notifications should go to, or null to use the
 * team-wide one. Decryption failures (a rotated MEET_TOKEN_SECRET) degrade to
 * the team webhook rather than taking a booking down over a notification.
 */
export function pageSlackWebhook(page: MeetPage): string | null {
  if (!page.slackWebhookEnc) return null;
  try {
    return decryptSecret(page.slackWebhookEnc);
  } catch {
    console.error(`meet: page ${page.member.key} has an undecryptable Slack webhook`);
    return null;
  }
}

/**
 * Where a booking's Slack notice should be posted: that page's own webhook if
 * one is configured, otherwise the team-wide webhook passed in.
 *
 * This is the whole of per-page Slack routing, and it is deliberately shaped
 * as a drop-in for the team-wide Slack dispatcher: that module already takes
 * the webhook URL as a PARAMETER rather than reading it from settings, so
 * routing a personal booking to its own channel is
 *
 *     postMeetingSlackEvent(
 *       await slackWebhookForPage(booking.pageKey, settings.webhookUrl),
 *       event, hostTimezone, settings.referenceSecret)
 *
 * in place of passing `settings.webhookUrl` directly. Nothing else changes,
 * and a page with no webhook of its own keeps landing in the team channel.
 *
 * Never throws: a notification must not be able to fail a booking.
 */
export async function slackWebhookForPage(
  pageKey: string,
  teamWebhookUrl: string
): Promise<string> {
  if (!pageKey) return teamWebhookUrl;
  try {
    const page = await getPage(pageKey);
    if (!page) return teamWebhookUrl;
    return pageSlackWebhook(page) ?? teamWebhookUrl;
  } catch (error) {
    console.error(`meet: could not resolve a Slack webhook for page ${pageKey}`, error);
    return teamWebhookUrl;
  }
}

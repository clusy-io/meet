import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/meet/admin";
import { getMeetConfig } from "@/lib/meet/config";
import { encryptSecret } from "@/lib/meet/crypto";
import { ensureMockReady } from "@/lib/meet/mock";
import { hasTrustedMutationOrigin } from "@/lib/meet/requestSecurity";
import { getMeetStore } from "@/lib/meet/store";
import { parseClockToMinutes } from "@/lib/meet/tz";
import type { PageSettings } from "@/lib/meet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Edit one personal booking page.
 *
 * Every field is optional; an omitted field is left alone and an explicit
 * null clears the override so the setting falls back to the global config.
 * That three-way distinction (absent / null / value) is why the body is not
 * simply a full settings object.
 */
const patchSchema = z.object({
  enabled: z.boolean().optional(),
  headline: z.string().trim().max(80).nullable().optional(),
  blurb: z.string().trim().max(200).nullable().optional(),
  windowStart: z.string().max(5).nullable().optional(),
  windowEnd: z.string().max(5).nullable().optional(),
  bookableWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(480).nullable().optional(),
  slotStepMinutes: z.number().int().min(5).max(480).nullable().optional(),
  minNoticeMinutes: z.number().int().min(0).max(43_200).nullable().optional(),
  horizonDays: z.number().int().min(0).max(366).nullable().optional(),
  eventTitle: z.string().trim().max(200).nullable().optional(),
  eventDescription: z.string().trim().max(2000).nullable().optional(),
  /** null clears the stored webhook; a value replaces it. */
  slackWebhookUrl: z.string().max(512).nullable().optional(),
});

const SLACK_WEBHOOK_RE = /^\/services\/[A-Za-z0-9_-]{8,128}\/[A-Za-z0-9_-]{8,128}\/[A-Za-z0-9_-]{8,192}$/;

/**
 * Exact-shape check for a Slack Incoming Webhook.
 *
 * This is a hard SSRF fence, not cosmetics: the server will POST to whatever
 * is stored here, so an unvalidated value is a stored request-forgery
 * primitive. Validated at WRITE time so a bad URL can never reach the table.
 * Mirrors the validator in the team-wide Slack module.
 */
function validSlackWebhook(raw: string): string | null {
  if (raw.length > 512 || raw.trim() !== raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "hooks.slack.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !SLACK_WEBHOOK_RE.test(url.pathname)
  ) {
    return null;
  }
  return url.toString();
}

type RouteContext = { params: Promise<{ memberKey: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  // Origin fence before the credential check, matching the other mutating
  // admin routes: reversing them tells a cross-site caller whether a secret
  // was valid.
  if (!hasTrustedMutationOrigin(request)) {
    return NextResponse.json({ message: "forbidden" }, { status: 403 });
  }
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }

  const { memberKey } = await params;
  const config = getMeetConfig();
  // The segment is attacker-supplied: without this the upsert would happily
  // create settings rows for members who do not exist.
  if (!config.members.some((m) => m.key === memberKey)) {
    return NextResponse.json({ message: "unknown member" }, { status: 404 });
  }

  const json: unknown = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 }
    );
  }
  const body = parsed.data;

  const patch: Partial<Omit<PageSettings, "memberKey" | "createdAt" | "updatedAt">> = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.headline !== undefined) patch.headline = body.headline || null;
  if (body.blurb !== undefined) patch.blurb = body.blurb || null;
  if (body.bookableWeekdays !== undefined) {
    patch.bookableWeekdays = body.bookableWeekdays
      ? [...new Set(body.bookableWeekdays)].sort((a, b) => a - b)
      : null;
  }
  if (body.durationMinutes !== undefined) patch.durationMinutes = body.durationMinutes;
  if (body.slotStepMinutes !== undefined) patch.slotStepMinutes = body.slotStepMinutes;
  if (body.minNoticeMinutes !== undefined) patch.minNoticeMinutes = body.minNoticeMinutes;
  if (body.horizonDays !== undefined) patch.horizonDays = body.horizonDays;
  if (body.eventTitle !== undefined) patch.eventTitle = body.eventTitle || null;
  if (body.eventDescription !== undefined) patch.eventDescription = body.eventDescription || null;

  for (const [field, raw] of [
    ["windowStartMin", body.windowStart],
    ["windowEndMin", body.windowEnd],
  ] as const) {
    if (raw === undefined) continue;
    if (raw === null || raw === "") {
      patch[field] = null;
      continue;
    }
    const minutes = parseClockToMinutes(raw);
    if (minutes === null) {
      return NextResponse.json(
        { message: "Booking hours must be an HH:MM time between 00:00 and 24:00." },
        { status: 400 }
      );
    }
    patch[field] = minutes;
  }

  if (getMeetConfig().mockMode) await ensureMockReady();
  const store = getMeetStore();

  // Validate the resulting window against what is actually stored, not just
  // against this request: editing only the start must not be able to land
  // past a previously stored end. Falls back to the global bounds for any
  // side that stays inherited.
  const current = await store.getPageSettings(memberKey);
  const nextStart =
    patch.windowStartMin !== undefined
      ? patch.windowStartMin
      : (current?.windowStartMin ?? null);
  const nextEnd =
    patch.windowEndMin !== undefined ? patch.windowEndMin : (current?.windowEndMin ?? null);
  const effectiveStart = nextStart ?? config.windowStartMin;
  const effectiveEnd = nextEnd ?? config.windowEndMin;
  if (effectiveStart >= effectiveEnd) {
    return NextResponse.json(
      { message: "The opening time must be before the closing time." },
      { status: 400 }
    );
  }
  const nextDuration =
    (patch.durationMinutes !== undefined
      ? patch.durationMinutes
      : (current?.durationMinutes ?? null)) ?? config.durationMinutes;
  if (nextDuration > effectiveEnd - effectiveStart) {
    return NextResponse.json(
      { message: "The meeting length does not fit inside the booking hours." },
      { status: 400 }
    );
  }
  const nextStep =
    (patch.slotStepMinutes !== undefined
      ? patch.slotStepMinutes
      : (current?.slotStepMinutes ?? null)) ?? config.slotStepMinutes;
  if (nextStep < nextDuration) {
    return NextResponse.json(
      { message: "The gap between slots cannot be shorter than the meeting length." },
      { status: 400 }
    );
  }

  if (body.slackWebhookUrl !== undefined) {
    if (body.slackWebhookUrl === null || body.slackWebhookUrl === "") {
      patch.slackWebhookEnc = null;
    } else {
      const webhook = validSlackWebhook(body.slackWebhookUrl);
      if (!webhook) {
        return NextResponse.json(
          { message: "That is not a Slack incoming-webhook URL (https://hooks.slack.com/services/...)." },
          { status: 400 }
        );
      }
      try {
        patch.slackWebhookEnc = encryptSecret(webhook);
      } catch {
        // keyBytes() throws when MEET_TOKEN_SECRET is unset; say so rather
        // than returning an undiagnosable 500.
        return NextResponse.json(
          { message: "MEET_TOKEN_SECRET is not configured, so the webhook cannot be stored." },
          { status: 500 }
        );
      }
    }
  }

  await store.upsertPageSettings(memberKey, patch);
  return NextResponse.json({ ok: true });
}

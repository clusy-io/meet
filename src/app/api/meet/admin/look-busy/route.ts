import { NextResponse } from "next/server";
import { z } from "zod";
import type {
  LookBusyCounts,
  LookBusyPreview,
  LookBusyPreviewDay,
  LookBusySlotState,
} from "@/components/meet/admin/types";
import { requireAdmin } from "@/lib/meet/admin";
import { computeAvailabilityPlan } from "@/lib/meet/availability";
import {
  DEFAULT_LOOK_BUSY_LEVEL,
  LOOK_BUSY_LEVELS,
  type LookBusyLevel,
} from "@/lib/meet/lookBusyLevels";
import { getEffectiveMeetConfig, getRuntimeMeetConfig } from "@/lib/meet/members";
import { ensureMockReady } from "@/lib/meet/mock";
import { getPage } from "@/lib/meet/pages";
import { hasTrustedMutationOrigin } from "@/lib/meet/requestSecurity";
import { getMeetStore } from "@/lib/meet/store";
import { formatCivilDate, utcToWall } from "@/lib/meet/tz";
import { TEAM_PAGE_KEY } from "@/lib/meet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Make my calendar look busy", for the admin console: the switch and the
 * live preview behind it, for the team page (no `host`) or one personal page.
 *
 * The preview answers the one question the switch raises, "what will people
 * actually see?", from the page's real calendars and bookings: every time in
 * the next few bookable days, marked taken, hidden or open. That is the very
 * thing the public availability API must never reveal, so it lives here,
 * behind the admin gate, and nowhere else.
 */

/** Bookable days the preview draws. */
const PREVIEW_DAYS = 5;

const hostSchema = z.string().trim().min(1).max(64);

const querySchema = z.object({
  host: hostSchema.optional(),
  /** Preview at this level instead of the stored one (the picker's hover). */
  level: z.enum(LOOK_BUSY_LEVELS).optional(),
});

const patchSchema = z.object({
  /** Member key; omitted for the team page. */
  host: hostSchema.optional(),
  /** The new level, or null to switch off. */
  level: z.enum(LOOK_BUSY_LEVELS).nullable(),
});

function emptyCounts(): LookBusyCounts {
  return { visible: 0, hidden: 0, busy: 0 };
}

export async function GET(request: Request) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    host: url.searchParams.get("host") ?? undefined,
    level: url.searchParams.get("level") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Invalid query." },
      { status: 400 },
    );
  }
  const { host } = parsed.data;

  try {
    const base = await getRuntimeMeetConfig();
    if (base.mockMode) await ensureMockReady();

    // The page exactly as the public page offers it. A paused personal page
    // still previews: the admin is deciding how it should look before it goes
    // live.
    let config = base;
    let storedLevel: LookBusyLevel | null;
    if (host) {
      const page = await getPage(host);
      if (!page) {
        return NextResponse.json({ message: "Unknown member." }, { status: 404 });
      }
      config = page.config;
      storedLevel = page.settings?.lookBusy ?? null;
    } else {
      storedLevel = (await getMeetStore().getPageSettings(TEAM_PAGE_KEY))?.lookBusy ?? null;
    }
    const level = parsed.data.level ?? storedLevel ?? DEFAULT_LOOK_BUSY_LEVEL;

    const today = utcToWall(config.hostTimezone, Date.now());
    const plan = (
      await computeAvailabilityPlan(
        formatCivilDate(today.year, today.month, today.day),
        config.horizonDays + 3,
        { hostKey: host, config, lookBusy: level },
      )
    ).lookBusy;
    if (!plan) throw new Error("meet: look-busy preview produced no plan");

    const days = new Map<string, LookBusyPreviewDay>();
    const horizon = emptyCounts();
    for (const startMs of [...plan.grid].sort((a, b) => a - b)) {
      if (startMs < plan.bookableFromMs) continue;
      const state: LookBusySlotState = !plan.open.has(startMs)
        ? "busy"
        : plan.hidden.has(startMs)
          ? "hidden"
          : "open";
      horizon[state === "open" ? "visible" : state] += 1;
      const wall = utcToWall(config.hostTimezone, startMs);
      const date = formatCivilDate(wall.year, wall.month, wall.day);
      let day = days.get(date);
      if (!day) {
        day = { date, slots: [] };
        days.set(date, day);
      }
      day.slots.push({
        start: new Date(startMs).toISOString(),
        minute: wall.hour * 60 + wall.minute,
        state,
      });
    }

    // The next days a visitor could actually book: a day of nothing but
    // taken times is still worth drawing (it is what the page shows), but
    // only once a free time exists somewhere, so a dead calendar draws as
    // "nothing to preview" rather than as five solid days.
    const anyFree = horizon.visible + horizon.hidden > 0;
    const shown = anyFree ? [...days.values()].slice(0, PREVIEW_DAYS) : [];
    const next = emptyCounts();
    for (const day of shown) {
      for (const slot of day.slots) next[slot.state === "open" ? "visible" : slot.state] += 1;
    }

    const preview: LookBusyPreview = {
      host: host ?? null,
      level,
      storedLevel,
      path: host ? `/${host}` : "/",
      hostTimezone: config.hostTimezone,
      durationMinutes: config.durationMinutes,
      days: shown,
      next,
      horizon,
    };
    return NextResponse.json(preview);
  } catch (error) {
    console.error("meet: look-busy preview failed", error);
    return NextResponse.json(
      { message: "The preview could not read the calendars. Try again in a moment." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  // Origin fence before the credential check, like the other mutating admin
  // routes: reversing them tells a cross-site caller whether a secret was
  // valid.
  if (!hasTrustedMutationOrigin(request)) {
    return NextResponse.json({ message: "forbidden" }, { status: 403 });
  }
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  const { host, level } = parsed.data;

  const config = await getEffectiveMeetConfig();
  // The key is caller-supplied: without this the upsert would create rows
  // for members who do not exist.
  if (host !== undefined && !config.members.some((member) => member.key === host)) {
    return NextResponse.json({ message: "unknown member" }, { status: 404 });
  }
  if (config.mockMode) await ensureMockReady();

  await getMeetStore().upsertPageSettings(host ?? TEAM_PAGE_KEY, { lookBusy: level });
  return NextResponse.json({ ok: true, host: host ?? null, level });
}

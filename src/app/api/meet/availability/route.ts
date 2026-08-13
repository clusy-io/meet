import { NextResponse } from "next/server";
import { z } from "zod";
import { computeAvailability } from "@/lib/meet/availability";
import { getMeetConfig } from "@/lib/meet/config";
import { rateLimit } from "@/lib/meet/ratelimit";
import { getMeetStore } from "@/lib/meet/store";
import {
  addCivilDays,
  civilDayNumber,
  formatCivilDate,
  parseCivilDate,
  utcToWall,
} from "@/lib/meet/tz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "from must be a YYYY-MM-DD date.")
    .optional(),
  days: z.coerce.number().int("days must be a whole number.").optional(),
  token: z.string().min(1).max(200).optional(),
});

export async function GET(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit("availability", ip, 60, 300_000)) {
    return NextResponse.json(
      { message: "Too many requests. Try again in a few minutes." },
      { status: 429 }
    );
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    days: url.searchParams.get("days") ?? undefined,
    token: url.searchParams.get("token") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Invalid query." },
      { status: 400 }
    );
  }

  const config = getMeetConfig();
  const days = Math.min(36, Math.max(1, parsed.data.days ?? 23));

  // "from" is a civil date in the host timezone, clamped to
  // [today, today + horizon]: the past has no slots and neither does
  // anything beyond the booking horizon.
  const today = utcToWall(config.hostTimezone, Date.now());
  const todayNumber = civilDayNumber(today.year, today.month, today.day);
  let from = formatCivilDate(today.year, today.month, today.day);
  if (parsed.data.from) {
    const civil = parseCivilDate(parsed.data.from);
    if (!civil) {
      return NextResponse.json(
        { message: "from must be a valid YYYY-MM-DD date." },
        { status: 400 }
      );
    }
    const fromNumber = civilDayNumber(civil.year, civil.month, civil.day);
    if (fromNumber > todayNumber + config.horizonDays) {
      const edge = addCivilDays(today.year, today.month, today.day, config.horizonDays);
      from = formatCivilDate(edge.year, edge.month, edge.day);
    } else if (fromNumber > todayNumber) {
      from = parsed.data.from;
    }
  }

  // A manage token narrows the slots to times the booking's committed
  // attendees can make (the reschedule flow keeps the original attendees).
  let requiredMemberKeys: string[] | undefined;
  if (parsed.data.token) {
    const booking = await getMeetStore().getBookingByToken(parsed.data.token);
    if (!booking || booking.status !== "confirmed") {
      return NextResponse.json({ message: "Booking not found." }, { status: 404 });
    }
    requiredMemberKeys = booking.attendeeMemberKeys;
  }

  try {
    const data = await computeAvailability(from, days, requiredMemberKeys);
    return NextResponse.json(data);
  } catch (error) {
    console.error("meet: availability failed", error);
    return NextResponse.json(
      { message: "Availability is temporarily unavailable." },
      { status: 500 }
    );
  }
}

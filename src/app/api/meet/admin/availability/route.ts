import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/meet/admin";
import { computeMemberBusyTimeline, MEMBER_BUSY_TIMELINE_MAX_DAYS } from "@/lib/meet/availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const DEFAULT_DAYS = 7;

function isRealCivilDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1000 || year > 9999) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() + 1 === month && probe.getUTCDate() === day;
}

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be a YYYY-MM-DD date.")
    .refine(isRealCivilDate, "from must be a real calendar date."),
  days: z.string().regex(/^[1-9]\d{0,14}$/, "days must be a positive whole number.").optional(),
});

export async function GET(request: Request) {
  if (!requireAdmin(request)) return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    days: url.searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ message: parsed.error.issues[0]?.message ?? "Invalid query." }, { status: 400 });
  }
  const requestedDays = parsed.data.days ? Number(parsed.data.days) : DEFAULT_DAYS;
  try {
    return NextResponse.json(await computeMemberBusyTimeline(
      parsed.data.from,
      Math.min(requestedDays, MEMBER_BUSY_TIMELINE_MAX_DAYS)
    ));
  } catch (error) {
    console.error("meet: admin member availability failed", error);
    return NextResponse.json(
      { message: "Calendar availability is temporarily unavailable." },
      { status: 500 }
    );
  }
}

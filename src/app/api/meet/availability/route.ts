import { NextResponse } from "next/server";
import { z } from "zod";
import { computeAvailability } from "@/lib/meet/availability";
import { getEffectiveMeetConfig } from "@/lib/meet/members";
import { availabilityRange, configForMeetingType, MEETING_TYPES } from "@/lib/meet/meetingTypes";
import { getPage } from "@/lib/meet/pages";
import { rateLimit } from "@/lib/meet/ratelimit";
import { getMeetStore } from "@/lib/meet/store";
import { parseCivilDate } from "@/lib/meet/tz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "from must be a YYYY-MM-DD date.")
    .optional(),
  days: z.coerce.number().int("days must be a whole number.").optional(),
  token: z.string().min(1).max(200).optional(),
  /** Personal page slug (/<host>); absent means the team page. */
  host: z.string().min(1).max(64).optional(),
  type: z.enum(MEETING_TYPES).optional(),
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
    host: url.searchParams.get("host") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Invalid query." },
      { status: 400 }
    );
  }

  const { token, from: requestedFrom } = parsed.data;
  const civil = requestedFrom ? parseCivilDate(requestedFrom) : null;
  if (requestedFrom && !civil) {
    return NextResponse.json({ message: "from must be a valid YYYY-MM-DD date." }, { status: 400 });
  }

  try {
    const booking = token ? await getMeetStore().getBookingByToken(token) : null;
    if (token && (!booking || booking.status !== "confirmed")) {
      return NextResponse.json({ message: "Booking not found." }, { status: 404 });
    }

    // A reschedule follows the original page and type, including older bookings
    // that predate team meeting types.
    const host = booking ? booking.pageKey : parsed.data.host;
    const meetingType = (booking ? booking.meetingType : parsed.data.type) ?? "meeting";
    const page = host ? await getPage(host) : null;
    if (host && (!page || (!page.enabled && !booking))) {
      return NextResponse.json({ message: "Unknown host." }, { status: 404 });
    }
    if (page && meetingType !== "meeting") {
      return NextResponse.json({ message: "That meeting type is unavailable on this page." }, { status: 404 });
    }

    const pageConfig = page
      ? page.config
      : configForMeetingType(await getEffectiveMeetConfig(), meetingType);
    if (!pageConfig) {
      return NextResponse.json({ message: "That meeting type is unavailable." }, { status: 404 });
    }
    const effective = booking?.durationMinutes
      ? { ...pageConfig, durationMinutes: booking.durationMinutes }
      : pageConfig;
    const { from, days } = availabilityRange(effective, meetingType, civil ?? undefined, parsed.data.days);
    const data = await computeAvailability(from, days, {
      requiredMemberKeys: booking?.attendeeMemberKeys,
      meetingType,
      durationMinutes: booking?.durationMinutes,
      hostKey: page?.member.key,
      config: effective,
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("meet: availability failed", error);
    return NextResponse.json(
      { message: "Availability is temporarily unavailable." },
      { status: 500 }
    );
  }
}

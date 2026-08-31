import { NextResponse } from "next/server";
import { z } from "zod";
import { rescheduleBooking, toBookingView } from "@/lib/meet/bookings";
import { listEffectiveMembers } from "@/lib/meet/members";
import { rateLimit } from "@/lib/meet/ratelimit";
import { hasTrustedMutationOrigin } from "@/lib/meet/requestSecurity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  start: z.string().min(1, "A start time is required."),
  timezone: z.string().min(1, "A timezone is required."),
});

function clientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || "unknown";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  if (!hasTrustedMutationOrigin(request)) {
    return NextResponse.json({ message: "forbidden" }, { status: 403 });
  }
  if (!rateLimit("manage", clientIp(request), 10, 300_000)) {
    return NextResponse.json({ message: "Too many requests. Try again in a few minutes." }, { status: 429 });
  }

  const { token } = await params;
  const json: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Invalid submission." },
      { status: 400 }
    );
  }

  try {
    const result = await rescheduleBooking(token, parsed.data);
    if (result.ok) {
      return NextResponse.json({
        booking: toBookingView(result.booking, await listEffectiveMembers()),
      });
    }
    const status = result.code === "invalid" ? 400 : result.code === "not_found" ? 404 : 409;
    return NextResponse.json({ message: result.message }, { status });
  } catch (err) {
    console.error("meet: booking reschedule failed", err);
    return NextResponse.json({ message: "Something went wrong. Try again." }, { status: 500 });
  }
}

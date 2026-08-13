import { NextResponse } from "next/server";
import { cancelBooking, toBookingView } from "@/lib/meet/bookings";
import { rateLimit } from "@/lib/meet/ratelimit";
import { hasTrustedMutationOrigin } from "@/lib/meet/requestSecurity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  try {
    const result = await cancelBooking(token);
    if (result.ok) {
      return NextResponse.json({ booking: toBookingView(result.booking) });
    }
    const status = result.code === "not_found" ? 404 : result.code === "invalid" ? 400 : 409;
    return NextResponse.json({ message: result.message }, { status });
  } catch (err) {
    console.error("meet: booking cancel failed", err);
    return NextResponse.json({ message: "Something went wrong. Try again." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { createBooking, toBookingView } from "@/lib/meet/bookings";
import { listEffectiveMembers } from "@/lib/meet/members";
import { rateLimit } from "@/lib/meet/ratelimit";
import { hasTrustedMutationOrigin } from "@/lib/meet/requestSecurity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  start: z.string().min(1, "A start time is required."),
  // Must be declared: z.object() strips unknown keys, so an undeclared `host`
  // would be dropped in silence and every personal booking would be filed as
  // a team booking with no error to notice.
  host: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1, "A name is required.").max(120, "Name is too long."),
  email: z.email("A valid email address is required."),
  notes: z.string().max(2000, "Notes are too long.").optional(),
  guests: z.array(z.string().email()).max(10).optional(),
  timezone: z.string().min(1, "A timezone is required."),
  company: z.string().optional(),
});

function clientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || "unknown";
}

export async function POST(request: Request) {
  if (!hasTrustedMutationOrigin(request)) {
    return NextResponse.json({ message: "forbidden" }, { status: 403 });
  }
  if (!rateLimit("bookings", clientIp(request), 10, 300_000)) {
    return NextResponse.json({ message: "Too many requests. Try again in a few minutes." }, { status: 429 });
  }

  const json: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "Invalid submission." },
      { status: 400 }
    );
  }

  // Honeypot: the visible form never fills `company`. Pretend success so
  // bots learn nothing; create nothing.
  if (parsed.data.company?.trim()) {
    return NextResponse.json({ message: "ok" }, { status: 200 });
  }

  try {
    const result = await createBooking(parsed.data);
    if (result.ok) {
      return NextResponse.json(
        { booking: toBookingView(result.booking, await listEffectiveMembers()) },
        { status: 201 }
      );
    }
    const status = result.code === "invalid" ? 400 : result.code === "not_found" ? 404 : 409;
    return NextResponse.json({ message: result.message }, { status });
  } catch (err) {
    console.error("meet: booking create failed", err);
    return NextResponse.json({ message: "Something went wrong. Try again." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_COOKIE, adminCookieValue } from "@/lib/meet/admin";
import { getMeetConfig } from "@/lib/meet/config";
import { secretEquals } from "@/lib/meet/crypto";
import { rateLimit } from "@/lib/meet/ratelimit";
import { hasTrustedMutationOrigin } from "@/lib/meet/requestSecurity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({ secret: z.string().min(1) });

function clientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || "unknown";
}

export async function POST(request: Request) {
  if (!hasTrustedMutationOrigin(request)) {
    return NextResponse.json({ message: "forbidden" }, { status: 403 });
  }
  if (!rateLimit("admin-login", clientIp(request), 10, 300_000)) {
    return NextResponse.json(
      { message: "Too many attempts. Try again in a few minutes." },
      { status: 429 }
    );
  }

  const json: unknown = await request.json().catch(() => null);
  const parsed = loginSchema.safeParse(json);
  const adminSecret = getMeetConfig().adminSecret;
  if (!parsed.success || !adminSecret || !secretEquals(parsed.data.secret, adminSecret)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }

  let cookieValue: string;
  try {
    cookieValue = adminCookieValue();
  } catch {
    // Signing needs MEET_TOKEN_SECRET; without it no session can be issued.
    return NextResponse.json(
      { message: "MEET_TOKEN_SECRET is not configured" },
      { status: 500 }
    );
  }

  const attributes = [
    `${ADMIN_COOKIE}=${cookieValue}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  if (process.env.NODE_ENV === "production") attributes.push("Secure");

  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", attributes.join("; "));
  return response;
}

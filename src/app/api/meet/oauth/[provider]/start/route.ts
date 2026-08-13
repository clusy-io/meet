import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/meet/admin";
import { getMeetConfig } from "@/lib/meet/config";
import { sign } from "@/lib/meet/crypto";
import { getProvider } from "@/lib/meet/providers";
import type { CalendarProviderId } from "@/lib/meet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isProviderId(value: string): value is CalendarProviderId {
  return value === "google" || value === "microsoft";
}

type RouteContext = { params: Promise<{ provider: string }> };

type StartErrorCode =
  | "mock_mode"
  | "unauthorized"
  | "bad_provider"
  | "bad_member"
  | "config_missing";

export async function GET(request: Request, { params }: RouteContext) {
  const config = getMeetConfig();
  // The admin panel links a browser navigation straight at this route, so
  // every failure redirects back to /admin with an error code instead
  // of dead-ending the tab on raw JSON.
  const fail = (code: StartErrorCode) =>
    NextResponse.redirect(`${config.siteOrigin}/admin?error=${code}`);

  const { provider } = await params;
  if (!isProviderId(provider)) return fail("bad_provider");
  const memberKey = new URL(request.url).searchParams.get("member");
  if (!memberKey || !config.members.some((m) => m.key === memberKey)) {
    return fail("bad_member");
  }
  if (!requireAdmin(request)) return fail("unauthorized");
  if (config.mockMode) return fail("mock_mode");

  try {
    // Signed so the callback can trust the member key; timestamped so a leaked
    // URL cannot start a connect flow later (15 min window, checked there).
    const state = sign(
      Buffer.from(JSON.stringify({ m: memberKey, t: Date.now() })).toString("base64url")
    );
    const redirectUri = `${config.siteOrigin}/api/meet/oauth/${provider}/callback`;
    return NextResponse.redirect(getProvider(provider).getAuthUrl(state, redirectUri));
  } catch {
    // sign() throws without MEET_TOKEN_SECRET; getAuthUrl throws when the
    // provider's client credentials are unset. Both are server config gaps.
    return fail("config_missing");
  }
}

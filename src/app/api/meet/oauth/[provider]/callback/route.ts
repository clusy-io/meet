import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/meet/admin";
import { invalidateAvailabilityCache } from "@/lib/meet/availability";
import { encryptSecret, verifySigned } from "@/lib/meet/crypto";
import { getEffectiveMeetConfig } from "@/lib/meet/members";
import { getProvider } from "@/lib/meet/providers";
import { getMeetStore } from "@/lib/meet/store";
import type { CalendarProviderId, SelectedCalendar } from "@/lib/meet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_MAX_AGE_MS = 15 * 60 * 1000;

function isProviderId(value: string): value is CalendarProviderId {
  return value === "google" || value === "microsoft";
}

/** State blob from the start route: {m: memberKey, t: issuedAtMs}. */
function decodeState(payload: string): { memberKey: string; issuedAtMs: number } | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return null;
    const m = (decoded as { m?: unknown }).m;
    const t = (decoded as { t?: unknown }).t;
    if (typeof m !== "string" || typeof t !== "number") return null;
    return { memberKey: m, issuedAtMs: t };
  } catch {
    return null;
  }
}

type RouteContext = { params: Promise<{ provider: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const config = await getEffectiveMeetConfig();
  const adminRedirect = (query: string) =>
    NextResponse.redirect(new URL(`/admin?${query}`, config.siteOrigin));

  const { provider } = await params;
  if (!isProviderId(provider)) return adminRedirect("error=connect_failed");
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }

  try {
    const search = new URL(request.url).searchParams;
    const code = search.get("code");
    const stateRaw = search.get("state");
    if (!code || !stateRaw) return adminRedirect("error=connect_failed");

    const payload = verifySigned(stateRaw);
    if (payload === null) return adminRedirect("error=connect_failed");
    const state = decodeState(payload);
    if (!state) return adminRedirect("error=connect_failed");
    if (Date.now() - state.issuedAtMs > STATE_MAX_AGE_MS) {
      return adminRedirect("error=state_expired");
    }
    if (!config.members.some((m) => m.key === state.memberKey)) {
      return adminRedirect("error=connect_failed");
    }

    const providerImpl = getProvider(provider);
    // Must match the redirectUri the start route sent, or the exchange fails.
    const redirectUri = `${config.siteOrigin}/api/meet/oauth/${provider}/callback`;
    const tokens = await providerImpl.exchangeCode(code, redirectUri);
    if (!tokens.refreshToken) return adminRedirect("error=no_refresh_token");

    // Default the picker to the account's primary calendar; the admin can
    // refine the selection later, so a failed listing is not fatal here.
    // The fallback is provider-aware: "primary" is a valid alias on Google
    // but not on Microsoft Graph, so Microsoft falls back to an empty
    // selection (it contributes nothing to availability until the admin
    // picks calendars in the admin UI).
    let selectedCalendars: SelectedCalendar[] =
      provider === "google" ? [{ id: "primary", name: "Primary" }] : [];
    try {
      const calendars = await providerImpl.listCalendars(tokens.refreshToken);
      const primary = calendars.find((c) => c.primary) ?? calendars[0];
      if (primary) selectedCalendars = [{ id: primary.id, name: primary.name }];
    } catch (error) {
      console.error("meet: calendar listing after connect failed", error);
    }

    const store = getMeetStore();
    const latestConfig = await getEffectiveMeetConfig();
    if (!latestConfig.members.some((member) => member.key === state.memberKey)) {
      return adminRedirect("error=connect_failed");
    }
    const existing = (await store.listAccounts()).find(
      (account) =>
        account.memberKey === state.memberKey &&
        account.provider === provider &&
        account.email.toLowerCase() === tokens.email.toLowerCase()
    );
    // Reauthorization refreshes credentials and health, but must not erase
    // the admin's deliberate multi-calendar selection.
    if (existing && existing.selectedCalendars.length > 0) {
      selectedCalendars = existing.selectedCalendars;
    }

    await store.upsertAccount({
      memberKey: state.memberKey,
      provider,
      email: existing?.email ?? tokens.email.toLowerCase(),
      refreshTokenEnc: encryptSecret(tokens.refreshToken),
      selectedCalendars,
      status: "ok",
    });
    invalidateAvailabilityCache();
    return adminRedirect(`connected=${encodeURIComponent(tokens.email)}`);
  } catch (error) {
    console.error("meet: oauth callback failed", error);
    return adminRedirect("error=connect_failed");
  }
}

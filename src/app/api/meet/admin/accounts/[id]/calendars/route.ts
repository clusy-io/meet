import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/meet/admin";
import { getMeetConfig } from "@/lib/meet/config";
import { decryptSecret } from "@/lib/meet/crypto";
import { ensureMockReady } from "@/lib/meet/mock";
import { getProvider } from "@/lib/meet/providers";
import { getMeetStore } from "@/lib/meet/store";
import { ProviderAuthError } from "@/lib/meet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const config = getMeetConfig();
  if (config.mockMode) await ensureMockReady();
  const store = getMeetStore();
  const account = await store.getAccount(id);
  if (!account) {
    return NextResponse.json({ message: "account not found" }, { status: 404 });
  }
  try {
    // Mock accounts hold raw "mock:<memberKey>" tokens, never ciphertext.
    const refreshToken = config.mockMode
      ? account.refreshTokenEnc
      : decryptSecret(account.refreshTokenEnc);
    const calendars = await getProvider(account.provider).listCalendars(refreshToken);
    return NextResponse.json({ calendars });
  } catch (error) {
    if (error instanceof ProviderAuthError) {
      await store.updateAccount(id, { status: "reauth_required" });
      return NextResponse.json({ message: "reauthorization required" }, { status: 409 });
    }
    console.error("meet: calendar listing failed", error);
    return NextResponse.json({ message: "calendar listing failed" }, { status: 502 });
  }
}

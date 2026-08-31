import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/meet/admin";
import { ensureMockReady } from "@/lib/meet/mock";
import { getEffectiveMeetConfig } from "@/lib/meet/members";
import { getMeetStore } from "@/lib/meet/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 510 -> "8:30", 1320 -> "22:00". */
function minutesToClock(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

export async function GET(request: Request) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }
  const config = await getEffectiveMeetConfig();
  if (config.mockMode) await ensureMockReady();
  const accounts = await getMeetStore().listAccounts();
  const activeMemberKeys = new Set(config.members.map((member) => member.key));
  return NextResponse.json({
    members: config.members,
    quorum: config.quorum,
    hostTimezone: config.hostTimezone,
    // Lets the admin UI disable the connect flows instead of dead-ending.
    mockMode: config.mockMode,
    window: {
      start: minutesToClock(config.windowStartMin),
      end: minutesToClock(config.windowEndMin),
    },
    // Refresh-token ciphertext never leaves the server, even encrypted.
    accounts: accounts.filter((a) => activeMemberKeys.has(a.memberKey)).map((a) => ({
      id: a.id,
      memberKey: a.memberKey,
      provider: a.provider,
      email: a.email,
      selectedCalendars: a.selectedCalendars,
      status: a.status,
      createdAt: a.createdAt,
    })),
  });
}

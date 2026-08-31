import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/meet/admin";
import { invalidateAvailabilityCache } from "@/lib/meet/availability";
import { getMeetConfig } from "@/lib/meet/config";
import { ensureMockReady } from "@/lib/meet/mock";
import { hasTrustedMutationOrigin } from "@/lib/meet/requestSecurity";
import { getMeetStore } from "@/lib/meet/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  selectedCalendars: z
    .array(z.object({ id: z.string().min(1), name: z.string() }))
    .max(20),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  if (!hasTrustedMutationOrigin(request)) {
    return NextResponse.json({ message: "forbidden" }, { status: 403 });
  }
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const json: unknown = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ message: "invalid body" }, { status: 400 });
  }
  if (getMeetConfig().mockMode) await ensureMockReady();
  const store = getMeetStore();
  const account = await store.getAccount(id);
  if (!account) {
    return NextResponse.json({ message: "account not found" }, { status: 404 });
  }
  await store.updateAccount(id, { selectedCalendars: parsed.data.selectedCalendars });
  invalidateAvailabilityCache();
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: RouteContext) {
  if (!hasTrustedMutationOrigin(request)) {
    return NextResponse.json({ message: "forbidden" }, { status: 403 });
  }
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (getMeetConfig().mockMode) await ensureMockReady();
  const store = getMeetStore();
  const account = await store.getAccount(id);
  if (!account) {
    return NextResponse.json({ message: "account not found" }, { status: 404 });
  }
  const nowMs = Date.now();
  const latestBookableMs = nowMs + (getMeetConfig().horizonDays + 2) * 86_400_000;
  const upcoming = await store.listConfirmedBookingsInRange(nowMs, latestBookableMs);
  if (upcoming.some((booking) => booking.eventRefs.some((ref) => ref.accountId === id))) {
    return NextResponse.json(
      {
        message:
          "This account owns an upcoming booking event. Cancel or move that booking before disconnecting it.",
      },
      { status: 409 }
    );
  }
  await store.deleteAccount(id);
  invalidateAvailabilityCache();
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/meet/admin";
import { invalidateAvailabilityCache } from "@/lib/meet/availability";
import { getMeetConfig } from "@/lib/meet/config";
import { listEffectiveMembers } from "@/lib/meet/members";
import { hasTrustedMutationOrigin } from "@/lib/meet/requestSecurity";
import { getMeetStore, type MeetStore } from "@/lib/meet/store";
import type { MemberRecord } from "@/lib/meet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().min(3).max(320).optional(),
    /** Restore only; DELETE owns archival and all of its safety checks. */
    archived: z.literal(false).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.email !== undefined ||
      body.archived !== undefined,
    "At least one member change is required.",
  );

type RouteContext = { params: Promise<{ memberKey: string }> };

function trusted(request: Request): NextResponse | null {
  if (!hasTrustedMutationOrigin(request)) {
    return NextResponse.json({ message: "forbidden" }, { status: 403 });
  }
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }
  return null;
}

async function compensateArchive(
  store: MeetStore,
  memberKey: string,
  archivedAt: string,
  priorEnabled: boolean,
): Promise<boolean> {
  const restored = await store.restoreMemberArchivedAt(memberKey, archivedAt);
  const latest = restored ? null : await store.getMemberRecord(memberKey);
  const active = restored || latest?.archivedAt === null;
  if (active) {
    await store.upsertPageSettings(memberKey, { enabled: priorEnabled });
  }
  return active;
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const denied = trusted(request);
  if (denied) return denied;
  const { memberKey } = await params;
  const current = await listEffectiveMembers();
  const existing = current.find((member) => member.key === memberKey);
  if (!existing) {
    return NextResponse.json({ message: "unknown member" }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  const name = parsed.data.name ?? existing.name;
  const email = (parsed.data.email ?? existing.email).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { message: "A valid member email is required." },
      { status: 400 },
    );
  }
  if (
    current.some(
      (member) =>
        member.key !== memberKey && member.email.trim().toLowerCase() === email,
    )
  ) {
    return NextResponse.json(
      { message: "A member with that email already exists." },
      { status: 409 },
    );
  }

  const store = getMeetStore();
  const ensured = await store.ensureMemberRecord({
    key: existing.key,
    name: existing.name,
    email: existing.email,
    archivedAt: existing.archived ? new Date().toISOString() : null,
  });
  if (!ensured.ok) {
    return NextResponse.json(
      { message: "A member with that email already exists." },
      { status: 409 },
    );
  }
  const restoreExpectedAt = ensured.member.archivedAt;
  if (parsed.data.archived === false && existing.archived) {
    // Restoration never silently republishes a personal page.
    await store.upsertPageSettings(memberKey, { enabled: false });
  }
  let written = ensured.member;
  if (parsed.data.name !== undefined || parsed.data.email !== undefined) {
    const identity = await store.updateMemberIdentity(memberKey, {
      ...(parsed.data.name !== undefined ? { name } : {}),
      ...(parsed.data.email !== undefined ? { email } : {}),
    });
    if (!identity.ok) {
      return NextResponse.json(
        { message: "A member with that email already exists." },
        { status: 409 },
      );
    }
    written = identity.member;
  }
  if (parsed.data.archived === false && existing.archived) {
    if (restoreExpectedAt !== null) {
      const restored = await store.restoreMemberArchivedAt(
        memberKey,
        restoreExpectedAt,
      );
      written = (await store.getMemberRecord(memberKey)) ?? written;
      if (!restored || written.archivedAt !== null) {
        invalidateAvailabilityCache();
        return NextResponse.json(
          {
            message:
              "This member changed while restore was in progress. Refresh to see their current state.",
            member: {
              key: written.key,
              name: written.name,
              email: written.email,
              archived: written.archivedAt !== null,
            },
          },
          { status: 409 },
        );
      }
    } else {
      written = (await store.getMemberRecord(memberKey)) ?? written;
    }
  }
  invalidateAvailabilityCache();
  return NextResponse.json({
    member: {
      key: existing.key,
      name: written.name,
      email: written.email,
      archived: written.archivedAt !== null,
    },
  });
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const denied = trusted(request);
  if (denied) return denied;
  const { memberKey } = await params;
  const current = await listEffectiveMembers();
  const existing = current.find((member) => member.key === memberKey);
  if (!existing) {
    return NextResponse.json({ message: "unknown member" }, { status: 404 });
  }
  const store = getMeetStore();
  if (existing.archived) {
    await store.upsertPageSettings(memberKey, { enabled: false });
    return NextResponse.json({ member: { ...existing, archived: true } });
  }

  const activeCount = current.filter((member) => !member.archived).length;
  const quorum = getMeetConfig().quorum;
  if (activeCount - 1 < quorum) {
    return NextResponse.json(
      {
        message: `Removing this member would leave fewer than the required ${quorum} active hosts.`,
      },
      { status: 409 },
    );
  }
  if (await store.hasFutureConfirmedBookingForMember(memberKey, Date.now())) {
    return NextResponse.json(
      {
        message:
          "This member has an upcoming booking. Cancel or move it before removing them.",
      },
      { status: 409 },
    );
  }

  const ensured = await store.ensureMemberRecord({
    key: existing.key,
    name: existing.name,
    email: existing.email,
    archivedAt: null,
  });
  if (!ensured.ok) {
    return NextResponse.json(
      { message: "The member changed while removal was in progress." },
      { status: 409 },
    );
  }
  if (ensured.member.archivedAt !== null) {
    // A concurrent DELETE already won. Do not replace its marker (which would
    // also make that request's compare-and-swap compensation unsafe).
    await store.upsertPageSettings(memberKey, { enabled: false });
    invalidateAvailabilityCache();
    return NextResponse.json({
      member: {
        key: ensured.member.key,
        name: ensured.member.name,
        email: ensured.member.email,
        archived: true,
      },
    });
  }

  // Settings, accounts and booking history remain untouched. Pause first so
  // a partial failure cannot leave a public page owned by an archived host.
  // If the archive is rejected or compensated, restore exactly the visibility
  // state that existed before this request.
  const priorSettings = await store.getPageSettings(memberKey);
  const priorEnabled = priorSettings?.enabled ?? true;
  const archivedAt = new Date().toISOString();
  let written: MemberRecord;
  try {
    await store.upsertPageSettings(memberKey, { enabled: false });
    written = await store.updateMemberArchivedAt(memberKey, archivedAt);
    invalidateAvailabilityCache();

    // Recheck the predicates after the write. A booking or another archive can
    // race the preflight; the compare-and-swap compensation restores only the
    // archive marker written above, never a newer admin change.
    const [latest, gainedBooking] = await Promise.all([
      listEffectiveMembers(),
      store.hasFutureConfirmedBookingForMember(memberKey, Date.now()),
    ]);
    if (
      latest.filter((member) => !member.archived).length < quorum ||
      gainedBooking
    ) {
      const active = await compensateArchive(
        store,
        memberKey,
        archivedAt,
        priorEnabled,
      );
      invalidateAvailabilityCache();
      return NextResponse.json(
        {
          message: active
            ? gainedBooking
              ? "This member received an upcoming booking while removal was in progress. They were kept active."
              : `Another roster change would leave fewer than the required ${quorum} active hosts. This member was kept active.`
            : "The member changed while removal was in progress. Their page remains paused; refresh before trying again.",
        },
        { status: 409 },
      );
    }
  } catch (error) {
    try {
      await compensateArchive(store, memberKey, archivedAt, priorEnabled);
    } catch (compensationError) {
      console.error(
        "meet: member archive compensation failed",
        compensationError,
      );
    }
    invalidateAvailabilityCache();
    throw error;
  }

  return NextResponse.json({
    member: {
      key: existing.key,
      name: written.name,
      email: written.email,
      archived: true,
    },
  });
}

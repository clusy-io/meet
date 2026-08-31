import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/meet/admin";
import { invalidateAvailabilityCache } from "@/lib/meet/availability";
import { listEffectiveMembers } from "@/lib/meet/members";
import { isReservedPageSlug } from "@/lib/meet/pages";
import { hasTrustedMutationOrigin } from "@/lib/meet/requestSecurity";
import { getMeetStore } from "@/lib/meet/store";
import { isValidTimezone } from "@/lib/meet/tz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const createSchema = z.object({
  key: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().min(3).max(320),
  timezone: z.string().trim().min(1).max(64).nullable().optional(),
});

function view(member: { key: string; name: string; email: string; archived: boolean }) {
  return {
    key: member.key,
    name: member.name,
    email: member.email,
    archived: member.archived,
  };
}

export async function GET(request: Request) {
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ members: (await listEffectiveMembers()).map(view) });
}

export async function POST(request: Request) {
  if (!hasTrustedMutationOrigin(request)) {
    return NextResponse.json({ message: "forbidden" }, { status: 403 });
  }
  if (!requireAdmin(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 }
    );
  }
  const key = parsed.data.key.toLowerCase();
  const name = parsed.data.name;
  const email = parsed.data.email.toLowerCase();
  const timezone = parsed.data.timezone ?? null;
  if (!KEY_RE.test(key) || isReservedPageSlug(key)) {
    return NextResponse.json(
      {
        message:
          "Member keys use lowercase letters, numbers and hyphens, and cannot be admin, manage or api.",
      },
      { status: 400 }
    );
  }
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ message: "A valid member email is required." }, { status: 400 });
  }
  if (timezone !== null && !isValidTimezone(timezone)) {
    return NextResponse.json(
      { message: "That is not a valid IANA timezone." },
      { status: 400 }
    );
  }

  const current = await listEffectiveMembers();
  if (current.some((member) => member.key === key)) {
    return NextResponse.json(
      { message: "A member with that key already exists." },
      { status: 409 }
    );
  }
  if (current.some((member) => member.email.trim().toLowerCase() === email)) {
    return NextResponse.json(
      { message: "A member with that email already exists." },
      { status: 409 }
    );
  }

  const store = getMeetStore();
  // Claim both unique identities with an archived row BEFORE touching shared
  // settings. A concurrent loser returns 409 without overwriting the winner's
  // page. If a later step fails, the staged member remains invisible and can
  // be recovered through the restore path.
  const stagedAt = new Date().toISOString();
  const inserted = await store.insertMemberRecord({
    key,
    name,
    email,
    archivedAt: stagedAt,
  });
  if (!inserted.ok) {
    return NextResponse.json(
      {
        message:
          inserted.reason === "email_taken"
            ? "A member with that email already exists."
            : "A member with that key already exists.",
      },
      { status: 409 }
    );
  }
  await store.upsertPageSettings(key, { enabled: false, timezone });
  // Activate only the exact staged marker. Identity edits survive, and a
  // concurrent later DELETE cannot be cleared by this older create request.
  if (!(await store.restoreMemberArchivedAt(key, stagedAt))) {
    invalidateAvailabilityCache();
    return NextResponse.json(
      {
        message:
          "The member changed while setup was finishing. They remain paused; refresh before restoring them.",
      },
      { status: 409 }
    );
  }
  const activated = await store.getMemberRecord(key);
  if (!activated || activated.archivedAt !== null) {
    invalidateAvailabilityCache();
    return NextResponse.json(
      { message: "The member changed again while setup was finishing. Refresh to see their current state." },
      { status: 409 }
    );
  }
  invalidateAvailabilityCache();
  return NextResponse.json(
    {
      member: {
        key: activated.key,
        name: activated.name,
        email: activated.email,
        archived: false,
      },
    },
    { status: 201 }
  );
}

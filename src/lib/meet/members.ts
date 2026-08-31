import "server-only";

import { getMeetConfig, type MeetConfig } from "./config";
import { getMeetStore } from "./store";
import type { Member, MemberRecord } from "./types";

/** A baseline-or-persisted member, including soft-archive state. */
export interface EffectiveMember extends Member {
  archived: boolean;
}

/**
 * Overlay persisted identities on MEET_MEMBERS without turning the environment
 * variable into mutable state. Baseline order is stable; database-only members
 * follow it in creation order. An archived baseline member stays addressable
 * for history, but disappears from every live scheduling surface.
 */
export async function listEffectiveMembers(): Promise<EffectiveMember[]> {
  const baseline = getMeetConfig().members;
  const records = await getMeetStore().listMemberRecords();
  const byKey = new Map(records.map((record) => [record.key, record]));
  const baselineKeys = new Set(baseline.map((member) => member.key));

  const members: EffectiveMember[] = baseline.map((member) => {
    const override = byKey.get(member.key);
    return {
      key: member.key,
      name: override?.name ?? member.name,
      email: override?.email ?? member.email,
      archived: override?.archivedAt !== null && override?.archivedAt !== undefined,
    };
  });

  for (const record of records) {
    if (baselineKeys.has(record.key)) continue;
    members.push({
      key: record.key,
      name: record.name,
      email: record.email,
      archived: record.archivedAt !== null,
    });
  }

  const keys = new Set<string>();
  const emails = new Set<string>();
  for (const member of members) {
    const email = member.email.trim().toLowerCase();
    if (
      !member.key ||
      !member.name.trim() ||
      !email ||
      keys.has(member.key) ||
      emails.has(email)
    ) {
      throw new Error("meet: effective member roster is invalid");
    }
    keys.add(member.key);
    emails.add(email);
  }
  return members;
}

export async function listActiveMembers(): Promise<Member[]> {
  return (await listEffectiveMembers())
    .filter((member) => !member.archived)
    .map(({ key, name, email }) => ({ key, name, email }));
}

/** Active runtime roster without a quorum assertion, for admin recovery paths. */
export async function getEffectiveMeetConfig(): Promise<MeetConfig> {
  return { ...getMeetConfig(), members: await listActiveMembers() };
}

/** Team-booking config, fail-closed unless the active roster can meet quorum. */
export async function getRuntimeMeetConfig(): Promise<MeetConfig> {
  const config = await getEffectiveMeetConfig();
  if (config.members.length === 0 || config.quorum > config.members.length) {
    throw new Error(
      `meet: active member count (${config.members.length}) cannot satisfy quorum ${config.quorum}`
    );
  }
  return config;
}

/** Config for historical/admin projections, including soft-archived identities. */
export async function getHistoricalMeetConfig(): Promise<MeetConfig> {
  const members = (await listEffectiveMembers()).map(({ key, name, email }) => ({
    key,
    name,
    email,
  }));
  return { ...getMeetConfig(), members };
}

export function memberRecordInput(
  member: Member,
  archived: boolean
): Omit<MemberRecord, "createdAt" | "updatedAt"> {
  return {
    ...member,
    archivedAt: archived ? new Date().toISOString() : null,
  };
}

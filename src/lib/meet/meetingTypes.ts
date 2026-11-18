import type { MeetConfig } from "./config";
import type { MeetingType } from "./types";
import { addCivilDays, civilDayNumber, formatCivilDate, parseCivilDate, utcToWall, wallToUtcMs } from "./tz";

export { MEETING_TYPES } from "./types";

const LABELS: Record<MeetingType, string> = { chat: "Chat", meeting: "Meeting", investor: "Investor" };

export function meetingTypeLabel(type: MeetingType): string {
  return LABELS[type];
}

export function teamMeetingTypes(base: MeetConfig): {
  key: MeetingType;
  label: string;
  durationMinutes: number;
  description?: string;
}[] {
  return [
    { key: "chat", label: meetingTypeLabel("chat"), durationMinutes: 15 },
    { key: "meeting", label: meetingTypeLabel("meeting"), durationMinutes: base.durationMinutes },
    ...(base.investor ? [{ key: "investor" as const, label: meetingTypeLabel("investor"), durationMinutes: 30 }] : []),
  ];
}

export function specialMeetingNoun(type?: MeetingType | null): string | undefined {
  if (type === "investor") return "investor meeting";
  if (type === "chat") return "chat";
}

/** Event copy is also needed for historical invitations after a type is disabled. */
export function meetingTypeEventCopy(
  base: MeetConfig,
  type: MeetingType
): Pick<MeetConfig, "eventTitle" | "eventDescription"> {
  const event = specialMeetingNoun(type);
  if (!event) {
    return { eventTitle: base.eventTitle, eventDescription: base.eventDescription };
  }
  return {
    eventTitle: `${base.brandName} ${event} with {name}`,
    eventDescription: type === "investor"
      ? `Investor meeting with the ${base.brandName} team.`
      : `A 15-minute chat with the ${base.brandName} team.`,
  };
}

export function configForMeetingType(base: MeetConfig, type: MeetingType): MeetConfig | null {
  if (type === "meeting") return base;
  if (type === "chat") {
    return {
      ...base,
      ...meetingTypeEventCopy(base, type),
      durationMinutes: 15,
      slotStepMinutes: Math.max(15, base.slotStepMinutes),
      quorum: 1,
    };
  }
  const investor = base.investor;
  if (!investor) return null;
  const eligible = new Set([investor.requiredMember, ...investor.partners]);
  return {
    ...base,
    ...meetingTypeEventCopy(base, type),
    members: base.members.filter((member) => eligible.has(member.key)),
    durationMinutes: 30,
    slotStepMinutes: Math.max(30, base.slotStepMinutes),
    quorum: 2,
  };
}

/** The configured dates are inclusive in the host's timezone. */
export function investorWindow(config: MeetConfig): { fromMs: number; toMs: number } | undefined {
  if (!config.investor) return undefined;
  const start = parseCivilDate(config.investor.startDate)!;
  const end = parseCivilDate(config.investor.endDate)!;
  const after = addCivilDays(end.year, end.month, end.day, 1);
  return {
    fromMs: wallToUtcMs(config.hostTimezone, start.year, start.month, start.day, 0, 0),
    toMs: wallToUtcMs(config.hostTimezone, after.year, after.month, after.day, 0, 0),
  };
}

export function availabilityRange(
  config: MeetConfig,
  type: MeetingType,
  requestedFrom?: { year: number; month: number; day: number },
  requestedDays?: number
): { from: string; days: number } {
  let span: number;
  let from: { year: number; month: number; day: number };
  if (type === "investor") {
    if (!config.investor) throw new Error("meet: Investor booking is disabled");
    const first = parseCivilDate(config.investor.startDate)!;
    const last = parseCivilDate(config.investor.endDate)!;
    span = civilDayNumber(last.year, last.month, last.day) -
      civilDayNumber(first.year, first.month, first.day) + 1;
    from = requestedFrom ?? first;
  } else {
    const today = utcToWall(config.hostTimezone, Date.now());
    const offset = requestedFrom
      ? civilDayNumber(requestedFrom.year, requestedFrom.month, requestedFrom.day) -
        civilDayNumber(today.year, today.month, today.day)
      : 0;
    from = addCivilDays(today.year, today.month, today.day, Math.min(config.horizonDays, Math.max(0, offset)));
    // Include the last opening day plus the grids of members whose zones are ahead.
    span = config.horizonDays + 3;
  }
  return {
    from: formatCivilDate(from.year, from.month, from.day),
    days: Math.min(span, Math.max(1, requestedDays ?? span)),
  };
}

import { civilDateKey } from "./schedule";
import type {
  AdminBusyInterval,
  TeamAvailabilityMember,
  TeamAvailabilityResponse,
} from "./types";

const DAY_MS = 86_400_000;

export interface MinuteRange {
  start: number;
  end: number;
}

export interface TeamAvailabilitySlot extends MinuteRange {
  dateKey: string;
  startAt: string;
  freeMemberKeys: string[];
}

export interface TeamAvailabilityWindow extends MinuteRange {
  dateKey: string;
  freeMemberKeys: string[];
}

function parseCivilDate(dateKey: string): [number, number, number] {
  const [year, month, day] = dateKey.split("-").map(Number);
  return [year, month, day];
}

export function addCivilDays(dateKey: string, amount: number): string {
  const [year, month, day] = parseCivilDate(dateKey);
  const next = new Date(Date.UTC(year, month - 1, day + amount));
  return [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, "0"),
    String(next.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function isoWeekday(dateKey: string): number {
  const [year, month, day] = parseCivilDate(dateKey);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function startOfIsoWeek(dateKey: string): string {
  return addCivilDays(dateKey, 1 - isoWeekday(dateKey));
}

export function todayInTimezone(timeZone: string, nowMs = Date.now()): string {
  return civilDateKey(new Date(nowMs).toISOString(), timeZone);
}

export function clockToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function minutesToClock(value: number): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  const suffix = hours >= 12 && hours < 24 ? "PM" : "AM";
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

export function minuteInTimezone(iso: string, timeZone: string): number {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", options).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", {
      ...options,
      timeZone: "UTC",
    }).formatToParts(date);
  }
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return value("hour") * 60 + value("minute");
}

export function mergeMinuteRanges(ranges: MinuteRange[]): MinuteRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: MinuteRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Team-grid time this member is willing to host, projected into the shared zone. */
export function workingRangesForMember(
  member: TeamAvailabilityMember,
  dateKey: string,
  response: TeamAvailabilityResponse,
): MinuteRange[] {
  if (member.status !== "ready") return [];
  return busyRangesForDay(
    member.working,
    dateKey,
    response.hostTimezone,
    clockToMinutes(response.window.start),
    clockToMinutes(response.window.end),
  );
}

/** Visible time outside a member's own hours/weekday grid. */
export function outsideWorkingRangesForMember(
  member: TeamAvailabilityMember,
  dateKey: string,
  response: TeamAvailabilityResponse,
): MinuteRange[] {
  const windowStart = clockToMinutes(response.window.start);
  const windowEnd = clockToMinutes(response.window.end);
  const working = workingRangesForMember(member, dateKey, response);
  const outside: MinuteRange[] = [];
  let cursor = windowStart;
  for (const range of working) {
    if (range.start > cursor) outside.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < windowEnd) outside.push({ start: cursor, end: windowEnd });
  return outside;
}

/** Privacy-safe provider intervals clipped to one civil day's work window. */
export function busyRangesForDay(
  busy: AdminBusyInterval[],
  dateKey: string,
  timeZone: string,
  windowStart: number,
  windowEnd: number,
): MinuteRange[] {
  const ranges = busy.flatMap((interval): MinuteRange[] => {
    const startMs = Date.parse(interval.startAt);
    const endMs = Date.parse(interval.endAt);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    ) {
      return [];
    }

    const startDay = civilDateKey(interval.startAt, timeZone);
    const endDay = civilDateKey(interval.endAt, timeZone);
    if (startDay > dateKey || endDay < dateKey) return [];

    const start =
      startDay < dateKey ? 0 : minuteInTimezone(interval.startAt, timeZone);
    const end =
      endDay > dateKey ? 24 * 60 : minuteInTimezone(interval.endAt, timeZone);
    const clipped = {
      start: Math.max(windowStart, start),
      end: Math.min(windowEnd, end),
    };
    return clipped.end > clipped.start ? [clipped] : [];
  });
  return mergeMinuteRanges(ranges);
}

export function freeRangesForMember(
  member: TeamAvailabilityMember,
  dateKey: string,
  response: TeamAvailabilityResponse,
): MinuteRange[] {
  if (member.status !== "ready") return [];
  const windowStart = clockToMinutes(response.window.start);
  const windowEnd = clockToMinutes(response.window.end);
  const busy = busyRangesForDay(
    member.busy,
    dateKey,
    response.hostTimezone,
    windowStart,
    windowEnd,
  );
  const free: MinuteRange[] = [];
  for (const working of workingRangesForMember(member, dateKey, response)) {
    let cursor = working.start;
    for (const range of busy) {
      if (range.end <= cursor || range.start >= working.end) continue;
      if (range.start > cursor) {
        free.push({ start: cursor, end: Math.min(range.start, working.end) });
      }
      cursor = Math.max(cursor, Math.min(range.end, working.end));
      if (cursor >= working.end) break;
    }
    if (cursor < working.end) free.push({ start: cursor, end: working.end });
  }
  return free;
}

export function availabilitySlotsForDates(
  response: TeamAvailabilityResponse,
  dateKeys: string[],
): TeamAvailabilitySlot[] {
  const includedDates = new Set(dateKeys);
  return response.slots.flatMap((slot): TeamAvailabilitySlot[] => {
    const dateKey = civilDateKey(slot.startAt, response.hostTimezone);
    if (!includedDates.has(dateKey)) return [];
    const start = minuteInTimezone(slot.startAt, response.hostTimezone);
    const endDate = civilDateKey(slot.endAt, response.hostTimezone);
    const end =
      endDate > dateKey
        ? 24 * 60
        : minuteInTimezone(slot.endAt, response.hostTimezone);
    if (end <= start) return [];
    return [
      {
        dateKey,
        startAt: slot.startAt,
        start,
        end,
        freeMemberKeys: [...slot.freeMemberKeys],
      },
    ];
  });
}

export function groupAvailabilitySlots(
  slots: TeamAvailabilitySlot[],
): TeamAvailabilityWindow[] {
  const windows: TeamAvailabilityWindow[] = [];
  for (const slot of slots) {
    const keys = slot.freeMemberKeys.join("|");
    const previous = windows[windows.length - 1];
    if (
      previous &&
      previous.dateKey === slot.dateKey &&
      previous.freeMemberKeys.join("|") === keys &&
      slot.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, slot.end);
    } else {
      windows.push({
        dateKey: slot.dateKey,
        start: slot.start,
        end: slot.end,
        freeMemberKeys: [...slot.freeMemberKeys],
      });
    }
  }
  return windows;
}

export function bestAvailabilityWindows(
  response: TeamAvailabilityResponse,
  dateKeys: string[],
  limit = 4,
): TeamAvailabilityWindow[] {
  return groupAvailabilitySlots(availabilitySlotsForDates(response, dateKeys))
    .sort((left, right) => {
      const memberDelta =
        right.freeMemberKeys.length - left.freeMemberKeys.length;
      if (memberDelta !== 0) return memberDelta;
      const durationDelta = right.end - right.start - (left.end - left.start);
      if (durationDelta !== 0) return durationDelta;
      return (
        left.dateKey.localeCompare(right.dateKey) || left.start - right.start
      );
    })
    .slice(0, limit);
}

export function dateKeysBetween(from: string, days: number): string[] {
  return Array.from({ length: days }, (_, index) => addCivilDays(from, index));
}

export function ordinal(dateKey: string): number {
  const [year, month, day] = parseCivilDate(dateKey);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

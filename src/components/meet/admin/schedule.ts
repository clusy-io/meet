import type { AdminBooking, BookingsResponse } from "./types";

export type ScheduleTimeframe = "upcoming" | "today" | "7d" | "past" | "all";
export type ScheduleStatus = "all" | "confirmed" | "cancelled" | "attention";
export type ScheduleDensity = "comfortable" | "compact";

export interface ScheduleFilters {
  search: string;
  timeframe: ScheduleTimeframe;
  host: "all" | string;
  status: ScheduleStatus;
}
export interface ScheduleCounts {
  today: number;
  nextSevenDays: number;
  needsAttention: number;
}

const DAY_MS = 86_400_000;

/** Resolve an instant to a stable timezone-local YYYY-MM-DD. */
export function civilDateKey(iso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", options).formatToParts(
      new Date(iso),
    );
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: "UTC",
    }).formatToParts(new Date(iso));
  }
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function civilOrdinal(iso: string, timeZone: string): number {
  const [year, month, day] = civilDateKey(iso, timeZone).split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function bookingNeedsAttention(
  booking: AdminBooking,
  nowMs: number,
): boolean {
  return (
    booking.status === "confirmed" &&
    Date.parse(booking.endAt) >= nowMs &&
    booking.syncStatus !== "synced"
  );
}

export function hostLabel(
  booking: Pick<AdminBooking, "attendeeMemberKeys">,
  members: BookingsResponse["members"],
): string {
  const names = booking.attendeeMemberKeys.map(
    (key) => members.find((member) => member.key === key)?.name ?? key,
  );
  return names.length > 0 ? names.join(", ") : "No host assigned";
}

function matchesTimeframe(
  booking: AdminBooking,
  timeframe: ScheduleTimeframe,
  hostTimezone: string,
  nowMs: number,
): boolean {
  const endMs = Date.parse(booking.endAt);
  if (timeframe === "upcoming") return endMs >= nowMs;
  if (timeframe === "past") return endMs < nowMs;
  if (timeframe === "all") return true;

  const today = civilOrdinal(new Date(nowMs).toISOString(), hostTimezone);
  const bookingDay = civilOrdinal(booking.startAt, hostTimezone);
  if (timeframe === "today") return bookingDay === today;
  return endMs >= nowMs && bookingDay >= today && bookingDay < today + 7;
}

export function filterScheduleBookings(
  bookings: AdminBooking[],
  members: BookingsResponse["members"],
  hostTimezone: string,
  filters: ScheduleFilters,
  nowMs: number,
): AdminBooking[] {
  const query = filters.search.trim().toLowerCase();

  return bookings
    .filter((booking) =>
      matchesTimeframe(booking, filters.timeframe, hostTimezone, nowMs),
    )
    .filter((booking) => {
      if (filters.status === "attention") {
        return bookingNeedsAttention(booking, nowMs);
      }
      return filters.status === "all" || booking.status === filters.status;
    })
    .filter(
      (booking) =>
        filters.host === "all" ||
        booking.attendeeMemberKeys.includes(filters.host),
    )
    .filter((booking) => {
      if (!query) return true;
      const hosts = booking.attendeeMemberKeys.map(
        (key) => members.find((member) => member.key === key)?.name ?? key,
      );
      return [
        booking.name,
        booking.email,
        booking.notes ?? "",
        ...booking.guests,
        ...hosts,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => {
      const delta = Date.parse(a.startAt) - Date.parse(b.startAt);
      return filters.timeframe === "past" ? -delta : delta;
    });
}

export function scheduleCounts(
  bookings: AdminBooking[],
  hostTimezone: string,
  nowMs: number,
): ScheduleCounts {
  const today = civilOrdinal(new Date(nowMs).toISOString(), hostTimezone);
  const confirmed = bookings.filter(
    (booking) => booking.status === "confirmed",
  );
  return {
    today: confirmed.filter(
      (booking) => civilOrdinal(booking.startAt, hostTimezone) === today,
    ).length,
    nextSevenDays: confirmed.filter((booking) => {
      const day = civilOrdinal(booking.startAt, hostTimezone);
      return (
        Date.parse(booking.endAt) >= nowMs &&
        day >= today &&
        day < today + 7
      );
    }).length,
    needsAttention: confirmed.filter((booking) =>
      bookingNeedsAttention(booking, nowMs),
    ).length,
  };
}

export function nextBooking(
  bookings: AdminBooking[],
  nowMs: number,
): AdminBooking | null {
  return (
    bookings
      .filter(
        (booking) =>
          booking.status === "confirmed" && Date.parse(booking.endAt) >= nowMs,
      )
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))[0] ?? null
  );
}

export interface BookingGroup {
  dateKey: string;
  bookings: AdminBooking[];
}

export function groupScheduleBookings(
  bookings: AdminBooking[],
  hostTimezone: string,
): BookingGroup[] {
  const groups: BookingGroup[] = [];
  for (const booking of bookings) {
    const dateKey = civilDateKey(booking.startAt, hostTimezone);
    const last = groups[groups.length - 1];
    if (last?.dateKey === dateKey) last.bookings.push(booking);
    else groups.push({ dateKey, bookings: [booking] });
  }
  return groups;
}

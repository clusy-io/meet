import { memo } from "react";
import styles from "./SelectedSlotSummary.module.css";

type SelectedSlot = {
  start: string;
  durationMinutes: number;
  timezone: string;
};

function formatSelectedSlot(start: string, durationMinutes: number, timezone: string) {
  const from = Date.parse(start);
  const to = from + durationMinutes * 60_000;
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const date = day.format(from);
  const endDate = day.format(to);
  const fromTime = clock.format(from);
  const toTime = clock.format(to);
  const end = date === endDate ? toTime : `${endDate}, ${toTime}`;

  // Intl may print only the ending zone when a range crosses a DST change.
  const zoneAt = (ms: number) => clock.formatToParts(ms).find(p => p.type === "timeZoneName")?.value;
  const compact = date === endDate && zoneAt(from) === zoneAt(to) && typeof clock.formatRange === "function";
  const range = compact ? clock.formatRange(from, to) : `${fromTime} – ${end}`;
  return { date, range, spokenRange: `${fromTime} to ${end}` };
}

export const SelectedSlotSummary = memo(function SelectedSlotSummary({
  start,
  durationMinutes,
  timezone,
}: SelectedSlot) {
  const { date, range, spokenRange } = formatSelectedSlot(start, durationMinutes, timezone);

  return (
    <span className="block min-w-0 text-left text-sm leading-5">
      <time dateTime={start} className="block font-medium text-ink">{date}</time>
      <span aria-hidden="true" className="block text-ink-soft">{range}</span>
      <span className="sr-only"> {spokenRange}</span>
    </span>
  );
});

type Appointment = { start: string; timezone: string } & (
  | { availableCount: number; durationMinutes?: never }
  | { durationMinutes: number; availableCount?: never }
);

export const AppointmentSummary = memo(function AppointmentSummary({
  start, timezone, availableCount, durationMinutes,
}: Appointment) {
  const calendarDate = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const parts = calendarDate.formatToParts(Date.parse(start));
  const { weekday, day, month, year } = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const slot = durationMinutes !== undefined ? formatSelectedSlot(start, durationMinutes, timezone) : null;

  return (
    <span className={styles.appointment}>
      <time className={styles.dateTile} dateTime={start}>
        <span aria-hidden="true" className={styles.weekday}>{weekday.slice(0, 3)}</span>
        <span aria-hidden="true" className={styles.day}>{day}</span>
        <span className="sr-only">{parts.map(({ value }) => value).join("")}</span>
      </time>
      <span className={styles.body}>
        <span className={styles.month} aria-hidden="true">{month} {year}</span>
        {slot ? (
          <>
            <span aria-hidden="true">{slot.range}</span>
            <span className="sr-only"> {slot.spokenRange}</span>
          </>
        ) : (
          <span>{availableCount} available {availableCount === 1 ? "time" : "times"}</span>
        )}
      </span>
    </span>
  );
});

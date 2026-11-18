import { memo } from "react";

type SelectedSlot = {
  start: string;
  durationMinutes: number;
  timezone: string;
};

export const SelectedSlotSummary = memo(function SelectedSlotSummary({
  start,
  durationMinutes,
  timezone,
}: SelectedSlot) {
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

  return (
    <span className="block min-w-0 text-left text-sm leading-5">
      <time dateTime={start} className="block font-medium text-ink">{date}</time>
      <span aria-hidden="true" className="block text-ink-soft">{range}</span>
      <span className="sr-only"> {fromTime} to {end}</span>
    </span>
  );
});

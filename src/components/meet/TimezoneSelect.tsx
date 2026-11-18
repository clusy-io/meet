"use client";

import styles from "./SlotPicker.module.css";
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { ChevronDown, Globe } from "lucide-react";

/**
 * Searchable timezone combobox for the public slot picker: a text input that
 * filters the IANA zone list as you type, with keyboard navigation. Zones
 * come from Intl.supportedValuesOf when the browser has it; the curated
 * fallback keeps older engines usable.
 */

const FALLBACK_ZONES: string[] = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Bogota",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Istanbul",
  "Africa/Cairo",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// Reuse the formatter, not the offset. A zone's offset can change between
// two slots on the same day as daylight saving time starts or ends.
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function displayLabel(zone: string, date: Date | null): string {
  const name = zone.replaceAll("_", " ");
  if (!date) return name;
  try {
    let formatter = offsetFormatters.get(zone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        timeZoneName: "shortOffset",
      });
      offsetFormatters.set(zone, formatter);
    }
    const offset = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
    if (!offset) return name;
    return `${name} (${offset === "GMT" ? "UTC+0" : offset.replace("GMT", "UTC")})`;
  } catch {
    return name;
  }
}

export function TimezoneSelect({
  value,
  slotIso,
  onChange,
}: {
  value: string;
  slotIso: string | null;
  onChange: (timezone: string) => void;
}): ReactElement {
  const zones = useMemo(() => {
    const supported =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : FALLBACK_ZONES;
    return supported.includes(value) ? [...supported] : [value, ...supported];
  }, [value]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listboxId = useId();
  const triggerId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const slotDate = useMemo(() => slotIso ? new Date(slotIso) : null, [slotIso]);
  const options = useMemo(() => {
    if (!open) return [];
    // Before choosing a date, keep offset search usable without presenting
    // today's offset as a promise about a future booking.
    const searchDate = slotDate ?? new Date();
    return zones.map((zone) => {
      const searchLabel = displayLabel(zone, searchDate);
      return {
        zone,
        label: slotDate ? searchLabel : displayLabel(zone, null),
        search: searchLabel.toLowerCase(),
      };
    });
  }, [open, slotDate, zones]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replaceAll("_", " ");
    return q ? options.filter((option) => option.search.includes(q)) : options;
  }, [options, query]);

  // Close on outside click; focus the search field on open.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted row in view while arrowing through the list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const pick = (zone: string) => {
    onChange(zone);
    setOpen(false);
    setQuery("");
    window.requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
  };

  return (
    <div ref={rootRef} className="relative">
      {/* A quiet text trigger, not a form field: the timezone is secondary
          chrome and should read like a caption until it is needed. */}
      <button
        id={triggerId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setQuery("");
          setHighlight(0);
        }}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-mute transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <Globe className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        {displayLabel(value, slotDate)}
        <ChevronDown
          className={`h-3 w-3 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          strokeWidth={1.5}
          aria-hidden
        />
      </button>

      {open ? (
        <div className={`${styles.panel} absolute bottom-full left-1/2 z-20 mb-2 w-72 max-w-[calc(100vw-3rem)] -translate-x-1/2 overflow-hidden`}>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-label="Search timezones"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-activedescendant={
              matches[highlight] ? `${listboxId}-option-${highlight}` : undefined
            }
            value={query}
            placeholder="Search timezones"
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                setQuery("");
                window.requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => Math.min(h + 1, matches.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (matches[highlight]) pick(matches[highlight].zone);
              }
            }}
            className="w-full border-b border-hairline bg-transparent px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Timezones"
            className={`${styles.scrollList} max-h-56 overflow-y-auto py-1`}
          >
            {matches.length === 0 ? (
              <li role="presentation" className="px-3 py-2 text-sm text-ink-mute">
                No matching timezone
              </li>
            ) : (
              matches.map(({ zone, label }, i) => (
                <li
                  key={zone}
                  id={`${listboxId}-option-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={zone === value}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(zone)}
                  className={`cursor-pointer px-3 py-1.5 text-left text-sm transition-colors duration-100 ${
                    i === highlight
                      ? "bg-ink text-paper"
                      : zone === value
                        ? "font-medium text-ink"
                        : "text-ink-soft"
                  }`}
                >
                  {label}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

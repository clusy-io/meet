"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CircleAlert, Eye, EyeOff, LoaderCircle, RefreshCw } from "lucide-react";
import {
  DEFAULT_LOOK_BUSY_LEVEL,
  LOOK_BUSY_LEVEL_INFO,
  LOOK_BUSY_LEVELS,
  type LookBusyLevel,
} from "@/lib/meet/lookBusyLevels";
import type { LookBusyPreview, LookBusySlotState } from "./types";

/**
 * "Make my calendar look busy" in the admin console: the switch, how busy,
 * and a live preview of exactly what visitors will see, drawn from the
 * page's real calendars and bookings.
 *
 * The switch and the level save the moment they are touched, like the page's
 * Live switch, rather than waiting on the form's Save: it is one decision with
 * an immediate, visible result, and the preview is how the admin judges it.
 * With the switch off, the preview can still be opened to see what a level
 * would do before turning it on.
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-paper";

/** Diagonal hatching for a time that is hidden rather than taken. */
export const HIDDEN_HATCH = {
  backgroundImage:
    "repeating-linear-gradient(135deg, hsl(var(--ink) / 0.24) 0 1px, transparent 1px 5px)",
} as const;

const CELL_CLASS: Record<LookBusySlotState, string> = {
  busy: "border-ink/80 bg-ink/80",
  hidden: "border-dashed border-hairline-strong bg-paper-raise",
  // The theme's green, not its accent: this repo's accent is a warm brown
  // that sits too close to the hatched "hidden" cells to tell apart.
  open: "border-status-ok/45 bg-status-ok/[0.12]",
};

const STATE_WORD: Record<LookBusySlotState, string> = {
  busy: "taken",
  hidden: "hidden",
  open: "open",
};

type Loaded =
  | { key: string; status: "ready"; preview: LookBusyPreview }
  | { key: string; status: "error"; message: string };

async function messageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" && body.message ? body.message : fallback;
  } catch {
    return fallback;
  }
}

function dayLabel(date: string): { weekday: string; day: string } {
  const [year, month, day] = date.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  return {
    weekday: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(instant),
    day: String(day),
  };
}

function timeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

/** The team page lives at the site root, which reads badly as a bare "/". */
function pageName(path: string): string {
  return path === "/" ? "the team page" : path;
}

function hourLabel(minute: number): string {
  const hour = Math.floor(minute / 60) % 24;
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

export function LookBusyControl({
  host,
  level,
  title,
  description,
  onSaved,
  onUnauthorized,
}: {
  /** Member key, or undefined for the team page. */
  host?: string;
  /** The stored level; null when off. */
  level: LookBusyLevel | null;
  title: string;
  description: string;
  onSaved: (level: LookBusyLevel | null) => void;
  onUnauthorized: () => void;
}) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const descriptionId = `${ids}-description`;
  const [saving, setSaving] = useState<LookBusyLevel | "off" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** The level the picker shows while the switch is off. */
  const [draftLevel, setDraftLevel] = useState<LookBusyLevel>(DEFAULT_LOOK_BUSY_LEVEL);
  const [previewingOff, setPreviewingOff] = useState(false);
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Read through a ref so a parent that hands in a fresh callback each render
  // does not refetch the preview each render.
  const unauthorized = useRef(onUnauthorized);
  useEffect(() => {
    unauthorized.current = onUnauthorized;
  });

  const on = level !== null;
  const selected = level ?? draftLevel;
  const expanded = on || previewingOff;
  const requestKey = `${host ?? ""}|${selected}|${reload}`;

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ level: selected });
    if (host) query.set("host", host);
    void (async () => {
      try {
        const response = await fetch(`/api/meet/admin/look-busy?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          unauthorized.current();
          return;
        }
        if (!response.ok) {
          throw new Error(await messageFrom(response, "The preview could not load."));
        }
        const preview = (await response.json()) as LookBusyPreview;
        if (!controller.signal.aborted) setLoaded({ key: requestKey, status: "ready", preview });
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoaded({
          key: requestKey,
          status: "error",
          message: error instanceof Error ? error.message : "The preview could not load.",
        });
      }
    })();
    return () => controller.abort();
  }, [expanded, host, requestKey, selected]);

  const save = async (next: LookBusyLevel | null) => {
    setSaving(next ?? "off");
    setSaveError(null);
    try {
      const response = await fetch("/api/meet/admin/look-busy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(host ? { host, level: next } : { level: next }),
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        throw new Error(await messageFrom(response, "Could not save this setting."));
      }
      if (next) setDraftLevel(next);
      setPreviewingOff(false);
      onSaved(next);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save this setting.");
    } finally {
      setSaving(null);
    }
  };

  const pickLevel = (next: LookBusyLevel) => {
    if (next === selected) return;
    if (on) void save(next);
    else setDraftLevel(next);
  };

  const current = loaded?.key === requestKey ? loaded : null;
  // Keep drawing the last preview while a new level loads, dimmed, rather
  // than flashing back to a skeleton on every pick.
  const shownPreview =
    current?.status === "ready"
      ? current.preview
      : loaded?.status === "ready" && loaded.preview.host === (host ?? null)
        ? loaded.preview
        : null;
  const loading = expanded && current === null;
  const pending = saving !== null;

  return (
    <div>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-ink-mute">
          <EyeOff className="h-4 w-4" strokeWidth={1.6} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p id={titleId} className="text-sm font-medium text-ink">
                {title}
              </p>
              <p id={descriptionId} className="mt-0.5 max-w-xl text-xs leading-5 text-ink-faint">
                {description}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-labelledby={titleId}
              aria-describedby={descriptionId}
              aria-busy={saving === "off" || (!on && saving !== null)}
              disabled={pending}
              onClick={() => void save(on ? null : selected)}
              className={`${FOCUS_RING} relative -mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl disabled:cursor-wait`}
            >
              <span
                aria-hidden
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border motion-safe:transition-colors ${on ? "border-ink bg-ink" : "border-hairline-strong bg-paper"} ${pending ? "opacity-70" : ""}`}
              >
                <span
                  className={`absolute left-1 grid h-4 w-4 place-items-center rounded-full bg-paper-raise shadow-sm motion-safe:transition-transform ${on ? "translate-x-5" : "translate-x-0"}`}
                >
                  {(saving === "off" || (!on && pending)) && (
                    <LoaderCircle className="h-3 w-3 text-ink-mute motion-safe:animate-spin" />
                  )}
                </span>
              </span>
            </button>
          </div>

          {!expanded && (
            <button
              type="button"
              onClick={() => setPreviewingOff(true)}
              className={`${FOCUS_RING} mt-2 inline-flex items-center gap-1.5 rounded text-xs font-medium text-ink-mute underline decoration-hairline-strong underline-offset-4 hover:text-ink`}
            >
              <Eye className="h-3.5 w-3.5" aria-hidden />
              Preview what visitors would see
            </button>
          )}

          {saveError && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-status-warn" role="alert">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {saveError}
            </p>
          )}

          <div
            className={`grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-300 motion-safe:ease-out ${expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
            inert={!expanded}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="mt-4 rounded-xl border border-hairline bg-paper">
                <div className="flex flex-col gap-3 border-b border-hairline p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                      How busy
                    </p>
                    <p className="mt-1 text-xs text-ink-mute">
                      {LOOK_BUSY_LEVEL_INFO[selected].detail}
                    </p>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="How busy the page should look"
                    className="inline-flex shrink-0 self-start rounded-lg border border-hairline bg-paper-raise p-0.5 sm:self-auto"
                  >
                    {LOOK_BUSY_LEVELS.map((key) => {
                      const checked = key === selected;
                      return (
                        <button
                          key={key}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          disabled={pending}
                          onClick={() => pickLevel(key)}
                          className={`${FOCUS_RING} relative inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-xs font-medium motion-safe:transition-colors disabled:cursor-wait ${checked ? "bg-ink text-paper shadow-sm" : "text-ink-mute hover:text-ink"}`}
                        >
                          {saving === key && (
                            <LoaderCircle className="h-3 w-3 motion-safe:animate-spin" aria-hidden />
                          )}
                          {LOOK_BUSY_LEVEL_INFO[key].label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <LookBusyPreviewPanel
                  preview={shownPreview}
                  loading={loading}
                  error={current?.status === "error" ? current.message : null}
                  onRetry={() => setReload((value) => value + 1)}
                  previewingOff={!on}
                />

                {!on && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-3 py-2.5 sm:px-4">
                    <p className="text-[11px] text-ink-faint">
                      Preview only. Visitors still see every free time.
                    </p>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setPreviewingOff(false)}
                        className={`${FOCUS_RING} rounded-md px-2.5 py-1.5 text-xs font-medium text-ink-mute hover:text-ink`}
                      >
                        Close
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => void save(selected)}
                        className={`${FOCUS_RING} inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-paper hover:opacity-90 disabled:opacity-60`}
                      >
                        {pending && <LoaderCircle className="h-3 w-3 motion-safe:animate-spin" aria-hidden />}
                        Turn on at {LOOK_BUSY_LEVEL_INFO[selected].label}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LookBusyPreviewPanel({
  preview,
  loading,
  error,
  onRetry,
  previewingOff,
}: {
  preview: LookBusyPreview | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  previewingOff: boolean;
}) {
  if (!preview) {
    if (error) {
      return (
        <div className="flex flex-wrap items-center justify-between gap-2 p-4 text-xs text-status-warn" role="alert">
          <span className="flex items-start gap-1.5">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {error}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className={`${FOCUS_RING} rounded-md px-2 py-1 font-medium text-ink-mute hover:text-ink`}
          >
            Try again
          </button>
        </div>
      );
    }
    return (
      <div className="space-y-2.5 p-3 sm:p-4" aria-busy="true" aria-label="Loading the preview">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="grid grid-cols-[3.25rem_minmax(0,1fr)_3.5rem] items-center gap-3">
            <span className="h-3 w-9 rounded bg-hairline motion-safe:animate-pulse" />
            <span className="h-5 rounded bg-hairline/70 motion-safe:animate-pulse" />
            <span className="h-3 rounded bg-hairline motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (preview.days.length === 0) {
    return (
      <p className="p-4 text-xs leading-5 text-ink-mute">
        Nothing to preview yet: {pageName(preview.path)} has no free times in the booking
        window. Check that a calendar is connected and readable.
      </p>
    );
  }

  const slots = preview.days.flatMap((day) => day.slots);
  const step = Math.max(
    5,
    Math.min(
      ...preview.days.flatMap((day) =>
        day.slots.slice(1).map((slot, index) => slot.minute - day.slots[index].minute),
      ).filter((gap) => gap > 0),
      preview.durationMinutes,
    ),
  );
  const minMinute = Math.min(...slots.map((slot) => slot.minute));
  const maxMinute = Math.max(...slots.map((slot) => slot.minute)) + step;
  const span = Math.max(step, maxMinute - minMinute);
  const ticks: number[] = [];
  for (let tick = Math.ceil(minMinute / 180) * 180; tick < maxMinute; tick += 180) ticks.push(tick);
  const { next, horizon } = preview;

  return (
    <div className={`p-3 motion-safe:transition-opacity sm:p-4 ${loading ? "opacity-55" : "opacity-100"}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
          {previewingOff ? "Visitors would see" : "Visitors see"} · {pageName(preview.path)}
        </p>
        <span className="flex items-center gap-2 text-[10px] text-ink-faint">
          {preview.hostTimezone.replaceAll("_", " ")}
          <button
            type="button"
            onClick={onRetry}
            aria-label="Refresh the preview"
            className={`${FOCUS_RING} grid h-6 w-6 place-items-center rounded text-ink-faint hover:text-ink`}
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          </button>
        </span>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-x-3 sm:grid-cols-[3.25rem_minmax(0,1fr)_3.5rem]">
        <span className="hidden sm:block" />
        <div className="relative h-4" aria-hidden>
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute top-0 -translate-x-1/2 text-[9px] tabular-nums text-ink-faint"
              style={{ left: `${((tick - minMinute) / span) * 100}%` }}
            >
              {hourLabel(tick)}
            </span>
          ))}
        </div>
        <span className="hidden sm:block" />
      </div>

      <div className="space-y-2.5 sm:space-y-1.5">
        {preview.days.map((day, row) => {
          const label = dayLabel(day.date);
          const counts = { open: 0, hidden: 0, busy: 0 };
          for (const slot of day.slots) counts[slot.state] += 1;
          return (
            // Phones stack the day's label and count over a full-width strip,
            // so a 13-hour day's half-hours stay wide enough to read.
            <div
              key={`${preview.level}-${day.date}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[3.25rem_minmax(0,1fr)_3.5rem]"
            >
              <span className="text-[11px] text-ink-mute">
                <span className="font-medium text-ink-soft">{label.weekday}</span> {label.day}
              </span>
              <div
                className="relative order-last col-span-2 h-6 rounded-md bg-hairline/30 sm:order-none sm:col-span-1"
                role="img"
                aria-label={`${label.weekday} ${label.day}: ${counts.open} open, ${counts.hidden} hidden, ${counts.busy} taken`}
              >
                {ticks.map((tick) => (
                  <span
                    key={tick}
                    className="absolute inset-y-0 w-px bg-hairline"
                    style={{ left: `${((tick - minMinute) / span) * 100}%` }}
                    aria-hidden
                  />
                ))}
                {day.slots.map((slot, index) => (
                  <span
                    key={slot.start}
                    title={`${timeLabel(slot.start, preview.hostTimezone)} · ${STATE_WORD[slot.state]}`}
                    style={{
                      left: `calc(${((slot.minute - minMinute) / span) * 100}% + 1px)`,
                      width: `calc(${(step / span) * 100}% - 2px)`,
                      transitionDelay: `${Math.min(row * 45 + index * 8, 420)}ms`,
                      ...(slot.state === "hidden" ? HIDDEN_HATCH : {}),
                    }}
                    className={`absolute inset-y-0.5 rounded-[4px] border motion-safe:transition-[opacity,transform] motion-safe:duration-300 starting:translate-y-0.5 starting:opacity-0 ${CELL_CLASS[slot.state]}`}
                  />
                ))}
              </div>
              <span className="text-right text-[11px] tabular-nums text-ink-mute">
                <span className="font-semibold text-ink">{counts.open}</span> open
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-ink-mute" aria-hidden>
        {(["open", "hidden", "busy"] as const).map((state) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <span
              style={state === "hidden" ? HIDDEN_HATCH : undefined}
              className={`h-2.5 w-3.5 rounded-[3px] border ${CELL_CLASS[state]}`}
            />
            {state === "open" ? "Open to book" : state === "hidden" ? "Hidden for now" : "Taken"}
          </span>
        ))}
      </div>

      <p className="mt-3 border-t border-hairline pt-3 text-xs leading-5 text-ink-mute">
        {next.hidden === 0 ? (
          <>
            These days are already busy enough, so nothing is hidden.{" "}
          </>
        ) : (
          <>
            Next {preview.days.length} {preview.days.length === 1 ? "day" : "days"}:{" "}
            <span className="font-medium text-ink">{next.visible} open</span> times shown,{" "}
            <span className="font-medium text-ink">{next.hidden} hidden</span>.{" "}
          </>
        )}
        Across the booking window, {horizon.hidden} of {horizon.visible + horizon.hidden} free times
        are held back. Each new booking brings one back, and no day is cut below two open times.
      </p>
    </div>
  );
}

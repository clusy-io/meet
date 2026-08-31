"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  BellRing,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Clock3,
  ExternalLink,
  Globe2,
  History,
  LayoutList,
  RefreshCw,
  Search,
  SlidersHorizontal,
  UserRound,
  Users,
  Video,
  X,
} from "lucide-react";
import type { AdminBooking, BookingsResponse } from "./types";
import {
  bookingNeedsAttention,
  civilDateKey,
  filterScheduleBookings,
  groupScheduleBookings,
  hostLabel,
  nextBooking,
  resolveScheduleDisplayTimezone,
  scheduleCounts,
  type ScheduleDensity,
  type ScheduleFilters,
  type ScheduleStatus,
  type ScheduleTimeframe,
} from "./schedule";

const DENSITY_STORAGE_KEY = "clusy-meet-admin-schedule-density";
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
const CONTROL = `h-10 rounded-lg border border-hairline bg-paper-raise text-sm text-ink outline-none transition-colors hover:border-hairline-strong focus:border-hairline-strong ${FOCUS_RING}`;
const CHIP =
  "inline-flex items-center rounded-full border border-hairline px-2 py-0.5 text-[11px]";

const DEFAULT_FILTERS: ScheduleFilters = {
  search: "",
  timeframe: "upcoming",
  host: "all",
  // Cancelled calls remain auditable without cluttering the daily agenda.
  status: "confirmed",
};

const TIMEFRAMES: ReadonlyArray<{ value: ScheduleTimeframe; label: string }> = [
  { value: "upcoming", label: "Upcoming" },
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "past", label: "Past" },
  { value: "all", label: "All" },
];

type Phase = "loading" | "ready" | "failed";

function formatInZone(
  iso: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(
      date,
    );
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: "UTC",
    }).format(date);
  }
}
function formatTime(iso: string, timeZone: string): string {
  return formatInZone(iso, timeZone, { hour: "numeric", minute: "2-digit" });
}

function formatFullDateTime(iso: string, timeZone: string): string {
  return formatInZone(iso, timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatDayHeading(
  iso: string,
  timeZone: string,
  nowMs: number,
): string {
  const day = formatInZone(iso, timeZone, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const isToday =
    civilDateKey(iso, timeZone) ===
    civilDateKey(new Date(nowMs).toISOString(), timeZone);
  return isToday ? `Today · ${day}` : day;
}

function formatShortDate(iso: string, timeZone: string): string {
  return formatInZone(iso, timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function relativeToStart(booking: AdminBooking, nowMs: number): string {
  const startMs = Date.parse(booking.startAt);
  const endMs = Date.parse(booking.endAt);
  if (startMs <= nowMs && endMs >= nowMs) return "Happening now";
  const minutes = Math.max(1, Math.round((startMs - nowMs) / 60_000));
  if (minutes < 60) return `In ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `In ${hours} hr${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `In ${days} day${days === 1 ? "" : "s"}`;
}

function freshnessLabel(fetchedAt: number | null, nowMs: number): string {
  if (fetchedAt === null) return "Not updated yet";
  const seconds = Math.max(0, Math.floor((nowMs - fetchedAt) / 1000));
  if (seconds < 45) return "Updated just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${Math.floor(minutes / 60)}h ago`;
}

function syncTone(status: AdminBooking["syncStatus"]): string {
  if (status === "synced") return "text-status-ok";
  if (status === "partial") return "text-status-warn";
  return "text-status-down";
}

export function ScheduleView({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const unauthorizedRef = useRef(onUnauthorized);
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<BookingsResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [browserTimezone, setBrowserTimezone] = useState<string | null>(null);
  const [filters, setFilters] = useState<ScheduleFilters>(DEFAULT_FILTERS);
  const [density, setDensity] = useState<ScheduleDensity>("comfortable");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    unauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setBrowserTimezone(
          Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        );
      } catch {
        // The configured booking timezone remains a safe display fallback.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
        if (stored === "comfortable" || stored === "compact") {
          setDensity(stored);
        }
      } catch {
        // A blocked storage API only makes this preference session-local.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const load = useCallback(async (background = false, signal?: AbortSignal) => {
    if (background) setRefreshing(true);
    else setPhase("loading");
    setLoadError(null);
    try {
      const response = await fetch("/api/meet/admin/bookings", {
        cache: "no-store",
        signal,
      });
      if (response.status === 401) {
        unauthorizedRef.current();
        return;
      }
      if (!response.ok) throw new Error(`status ${response.status}`);
      setData((await response.json()) as BookingsResponse);
      setFetchedAt(Date.now());
      setNowMs(Date.now());
      setPhase("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (background) {
        setLoadError(
          "Could not refresh the schedule. Showing the last loaded version.",
        );
      } else {
        setPhase("failed");
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void load(false, controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  const setFilter = <Key extends keyof ScheduleFilters>(
    key: Key,
    value: ScheduleFilters[Key],
  ) => setFilters((current) => ({ ...current, [key]: value }));

  const changeDensity = (next: ScheduleDensity) => {
    setDensity(next);
    try {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      // The visual change still applies if persistence is unavailable.
    }
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const view = useMemo(() => {
    if (!data) return null;
    const displayTimezone = resolveScheduleDisplayTimezone(
      browserTimezone,
      data.hostTimezone,
    );
    const filtered = filterScheduleBookings(
      data.bookings,
      data.members,
      displayTimezone,
      filters,
      nowMs,
    );
    return {
      displayTimezone,
      filtered,
      groups: groupScheduleBookings(filtered, displayTimezone),
      counts: scheduleCounts(data.bookings, displayTimezone, nowMs),
      next: nextBooking(data.bookings, nowMs),
    };
  }, [browserTimezone, data, filters, nowMs]);

  if (phase === "loading") return <ScheduleSkeleton />;
  if (phase === "failed" || !data || !view) {
    return <ScheduleFailure onRetry={() => void load(false)} />;
  }

  const activeFilterCount =
    Number(filters.search.trim() !== "") +
    Number(filters.timeframe !== DEFAULT_FILTERS.timeframe) +
    Number(filters.host !== DEFAULT_FILTERS.host) +
    Number(filters.status !== DEFAULT_FILTERS.status);

  return (
    <section className="mx-auto w-full max-w-7xl" aria-busy={refreshing}>
      <div className="flex flex-col gap-5 border-b border-hairline pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-serif-display text-4xl font-bold tracking-[-0.045em] text-ink sm:text-5xl">
            Schedule
          </h2>
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-6 text-ink-mute">
            <span>Times shown in your current timezone</span>
            <span aria-hidden className="text-hairline-strong">
              /
            </span>
            <span
              data-testid="schedule-timezone"
              className="font-medium text-ink-soft"
            >
              {view.displayTimezone.replaceAll("_", " ")}
            </span>
            <span className="text-ink-faint">
              {freshnessLabel(fetchedAt, nowMs)}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          className={`link-draw inline-flex h-9 items-center justify-center gap-2 self-start text-sm font-medium text-ink-mute transition-colors hover:text-ink disabled:opacity-60 sm:self-auto ${FOCUS_RING}`}
        >
          <RefreshCw
            size={15}
            strokeWidth={1.7}
            className={refreshing ? "motion-safe:animate-spin" : ""}
            aria-hidden
          />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {loadError && (
        <div
          role="alert"
          className="mt-5 flex items-start gap-2 rounded-lg border border-status-warn/25 bg-status-warn/5 px-3.5 py-3 text-sm text-status-warn"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>{loadError}</span>
        </div>
      )}

      <div className="mt-8 grid gap-5 lg:grid-cols-[minmax(0,1.8fr)_minmax(18rem,0.72fr)] lg:gap-8">
        <NextUpCard
          booking={view.next}
          members={data.members}
          displayTimezone={view.displayTimezone}
          nowMs={nowMs}
        />
        <div className="grid grid-cols-3 divide-x divide-hairline border-y border-hairline lg:grid-cols-1 lg:divide-x-0 lg:divide-y">
          <MetricButton
            icon={<CalendarDays size={16} strokeWidth={1.6} />}
            label="Today"
            value={view.counts.today}
            active={
              filters.timeframe === "today" && filters.status === "confirmed"
            }
            onClick={() =>
              setFilters((current) => ({
                ...current,
                timeframe: "today",
                status: "confirmed",
              }))
            }
          />
          <MetricButton
            icon={<CalendarClock size={16} strokeWidth={1.6} />}
            label="Next 7 days"
            shortLabel="7 days"
            value={view.counts.nextSevenDays}
            active={
              filters.timeframe === "7d" && filters.status === "confirmed"
            }
            onClick={() =>
              setFilters((current) => ({
                ...current,
                timeframe: "7d",
                status: "confirmed",
              }))
            }
          />
          <MetricButton
            icon={<AlertTriangle size={16} strokeWidth={1.6} />}
            label="Needs attention"
            shortLabel="Attention"
            value={view.counts.needsAttention}
            tone={view.counts.needsAttention > 0 ? "warn" : "quiet"}
            active={filters.status === "attention"}
            onClick={() =>
              setFilters((current) => ({
                ...current,
                timeframe: "upcoming",
                status: "attention",
              }))
            }
          />
        </div>
      </div>

      <div className="mt-12 border-t border-hairline-strong">
        <div className="border-b border-hairline py-4">
          <div
            className="flex gap-1 overflow-x-auto pb-1"
            role="group"
            aria-label="Schedule timeframe"
          >
            {TIMEFRAMES.map((item) => {
              const selected = filters.timeframe === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setFilter("timeframe", item.value)}
                  className={`shrink-0 border-b px-3 py-2 text-sm font-medium transition-colors ${FOCUS_RING} ${
                    selected
                      ? "border-accent text-ink"
                      : "border-transparent text-ink-mute hover:text-ink"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(240px,1fr)_repeat(2,minmax(145px,auto))]">
            <label className="relative block">
              <span className="sr-only">Search meetings</span>
              <Search
                size={15}
                strokeWidth={1.7}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
                aria-hidden
              />
              <input
                type="search"
                value={filters.search}
                onChange={(event) => setFilter("search", event.target.value)}
                placeholder="Search people, email or notes"
                className={`${CONTROL} w-full pl-9 ${filters.search ? "pr-9" : "pr-3"}`}
              />
              {filters.search && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setFilter("search", "")}
                  className={`absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-paper hover:text-ink ${FOCUS_RING}`}
                >
                  <X size={14} aria-hidden />
                </button>
              )}
            </label>
            <FilterSelect
              label="Host"
              value={filters.host}
              onChange={(value) => setFilter("host", value)}
              options={[
                { value: "all", label: "All hosts" },
                ...data.members.map((member) => ({
                  value: member.key,
                  label: member.name,
                })),
              ]}
            />
            <FilterSelect
              label="Status"
              value={filters.status}
              onChange={(value) => setFilter("status", value as ScheduleStatus)}
              options={[
                { value: "confirmed", label: "Confirmed" },
                { value: "attention", label: "Needs attention" },
                { value: "cancelled", label: "Cancelled" },
                { value: "all", label: "All statuses" },
              ]}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-ink-mute">
              <SlidersHorizontal size={14} strokeWidth={1.7} aria-hidden />
              <span>
                {view.filtered.length} meeting
                {view.filtered.length === 1 ? "" : "s"}
              </span>
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={() => setFilters(DEFAULT_FILTERS)}
                  className={`rounded-md text-accent transition-colors hover:text-accent-bright ${FOCUS_RING}`}
                >
                  Clear filters ({activeFilterCount})
                </button>
              )}
            </div>

            <div
              role="group"
              aria-label="Agenda density"
              className="inline-flex items-center rounded-lg border border-hairline bg-paper p-0.5"
            >
              {(["comfortable", "compact"] as const).map((option) => {
                const selected = density === option;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => changeDensity(option)}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs capitalize transition-colors ${FOCUS_RING} ${
                      selected
                        ? "bg-paper-raise font-medium text-ink"
                        : "text-ink-mute hover:text-ink"
                    }`}
                  >
                    <LayoutList size={13} strokeWidth={1.7} aria-hidden />
                    {option}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {view.groups.length === 0 ? (
          <ScheduleEmpty
            hasAnyBookings={data.bookings.length > 0}
            onClear={() => setFilters(DEFAULT_FILTERS)}
          />
        ) : (
          <div className="py-6">
            <div className="space-y-9">
              {view.groups.map((group) => {
                const headingId = `schedule-day-${group.dateKey}`;
                return (
                  <section key={group.dateKey} aria-labelledby={headingId}>
                    <div className="mb-3 flex items-center gap-4">
                      <h2
                        id={headingId}
                        className="shrink-0 font-serif-display text-lg font-bold tracking-tight text-ink"
                      >
                        {formatDayHeading(
                          group.bookings[0].startAt,
                          view.displayTimezone,
                          nowMs,
                        )}
                      </h2>
                      <span className="h-px flex-1 bg-hairline" aria-hidden />
                      <span className="font-mono text-[10px] tabular-nums text-ink-faint">
                        {group.bookings.length} call
                        {group.bookings.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <ul className="divide-y divide-hairline border-y border-hairline bg-paper-raise/45">
                      {group.bookings.map((booking) => (
                        <MeetingRow
                          key={booking.id}
                          booking={booking}
                          members={data.members}
                          displayTimezone={view.displayTimezone}
                          nowMs={nowMs}
                          density={density}
                          expanded={expanded.has(booking.id)}
                          onToggle={() => toggleExpanded(booking.id)}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function NextUpCard({
  booking,
  members,
  displayTimezone,
  nowMs,
}: {
  booking: AdminBooking | null;
  members: BookingsResponse["members"];
  displayTimezone: string;
  nowMs: number;
}) {
  if (!booking) {
    return (
      <div className="relative flex min-h-52 flex-col justify-between overflow-hidden rounded-xl bg-ink p-6 text-paper sm:p-8">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-paper/55">
          <Clock3 size={14} strokeWidth={1.6} aria-hidden />
          Next up
        </div>
        <div className="mt-8">
          <p className="font-serif-display text-3xl font-bold tracking-tight text-paper">
            The calendar is clear
          </p>
          <p className="mt-2 max-w-lg text-sm leading-6 text-paper/60">
            There are no confirmed meetings ahead in the loaded booking window.
          </p>
        </div>
      </div>
    );
  }

  const happening = Date.parse(booking.startAt) <= nowMs;
  return (
    <article className="relative min-w-0 overflow-hidden rounded-xl bg-ink p-6 text-paper sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-paper/55">
          <Clock3 size={14} strokeWidth={1.6} aria-hidden />
          Next up
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            happening
              ? "bg-status-ok/15 text-status-ok"
              : "bg-paper/10 text-paper/75"
          }`}
        >
          {relativeToStart(booking, nowMs)}
        </span>
      </div>

      <div className="mt-5 grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="min-w-0">
          <p className="text-sm font-medium text-paper/60">
            {formatShortDate(booking.startAt, displayTimezone)}
          </p>
          <p className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 font-serif-display text-[clamp(2rem,8vw,3rem)] font-bold leading-tight tracking-[-0.045em] text-paper sm:text-5xl">
            <span>{formatTime(booking.startAt, displayTimezone)}</span>
            <span className="text-paper/35" aria-hidden>
              –
            </span>
            <span>{formatTime(booking.endAt, displayTimezone)}</span>
          </p>
          <h2 className="mt-5 break-words text-lg font-semibold tracking-tight text-paper">
            {booking.name}
          </h2>
          <p className="mt-1 break-all text-sm text-paper/55">
            {booking.email}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span
              className={`${CHIP} border-paper/15 bg-paper/5 text-paper/70`}
            >
              Calendar {booking.syncStatus}
            </span>
            {booking.guests.length > 0 && (
              <span
                className={`${CHIP} border-paper/15 bg-paper/5 text-paper/70`}
              >
                {booking.guests.length} guest
                {booking.guests.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-paper/55">
            <UserRound size={13} strokeWidth={1.7} aria-hidden />
            With {hostLabel(booking, members)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 md:justify-end">
          {booking.meetingUrl && (
            <a
              href={booking.meetingUrl}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-paper px-4 text-sm font-medium text-ink transition-opacity hover:opacity-90 ${FOCUS_RING}`}
            >
              <Video size={15} strokeWidth={1.7} aria-hidden />
              Join call
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
          <a
            href={booking.manageUrl}
            target="_blank"
            rel="noreferrer"
            className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-paper/20 px-4 text-sm font-medium text-paper/70 transition-colors hover:border-paper/45 hover:text-paper ${FOCUS_RING}`}
          >
            Manage
            <ExternalLink size={14} strokeWidth={1.7} aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      </div>
    </article>
  );
}

function MetricButton({
  icon,
  label,
  shortLabel,
  value,
  active,
  tone = "quiet",
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortLabel?: string;
  value: number;
  active: boolean;
  tone?: "quiet" | "warn";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`group flex min-w-0 items-center gap-2 px-3 py-4 text-left transition-colors sm:px-5 ${FOCUS_RING} ${
        active ? "bg-accent/[0.055]" : "hover:bg-paper-raise/70"
      }`}
    >
      <span
        className={`hidden shrink-0 items-center justify-center sm:flex ${
          tone === "warn" ? "text-status-warn" : "text-ink-faint"
        }`}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium text-ink-mute">
          <span className="sm:hidden">{shortLabel ?? label}</span>
          <span className="hidden sm:inline">{label}</span>
        </span>
        <span
          className={`mt-1 block font-serif-display text-2xl font-bold leading-none tabular-nums ${
            tone === "warn" ? "text-status-warn" : "text-ink"
          }`}
        >
          {value}
        </span>
      </span>
    </button>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative block min-w-0">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL} w-full appearance-none pl-3 pr-8`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={14}
        strokeWidth={1.7}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
        aria-hidden
      />
    </label>
  );
}

function MeetingRow({
  booking,
  members,
  displayTimezone,
  nowMs,
  density,
  expanded,
  onToggle,
}: {
  booking: AdminBooking;
  members: BookingsResponse["members"];
  displayTimezone: string;
  nowMs: number;
  density: ScheduleDensity;
  expanded: boolean;
  onToggle: () => void;
}) {
  const cancelled = booking.status === "cancelled";
  const inProgress =
    !cancelled &&
    Date.parse(booking.startAt) <= nowMs &&
    Date.parse(booking.endAt) >= nowMs;
  const attention = bookingNeedsAttention(booking, nowMs);
  const detailsId = `meeting-details-${booking.id}`;
  const padding =
    density === "compact"
      ? "px-3 py-2.5 sm:px-4"
      : "px-3 py-4 sm:px-4 sm:py-[1.125rem]";

  return (
    <li
      className={
        cancelled
          ? "bg-paper-raise/25"
          : "transition-colors hover:bg-paper-raise/60"
      }
    >
      <article className={`${padding} ${cancelled ? "opacity-70" : ""}`}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-[7.25rem_minmax(0,1fr)_auto] sm:items-center">
          <div className="flex items-baseline justify-between gap-3 sm:block">
            <time
              dateTime={booking.startAt}
              className={`block text-sm font-semibold tabular-nums ${
                cancelled ? "text-ink-mute line-through" : "text-ink"
              }`}
            >
              {formatTime(booking.startAt, displayTimezone)}
            </time>
            <span className="mt-0.5 block text-xs tabular-nums text-ink-faint">
              {formatTime(booking.endAt, displayTimezone)} ·{" "}
              {booking.durationMinutes}m
            </span>
          </div>

          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3
                className={`min-w-0 truncate text-sm font-semibold ${
                  cancelled ? "text-ink-mute" : "text-ink"
                }`}
              >
                {booking.name}
              </h3>
              {inProgress && (
                <span
                  className={`${CHIP} border-status-ok/25 bg-status-ok/5 text-status-ok`}
                >
                  Now
                </span>
              )}
              {cancelled && (
                <span className={`${CHIP} text-status-warn`}>Cancelled</span>
              )}
              {attention && (
                <span className={`${CHIP} text-status-warn`}>
                  Needs attention
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-ink-mute">
              {booking.email}
            </p>
            <div
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-mute ${
                density === "compact" ? "mt-1" : "mt-2"
              }`}
            >
              <span className="inline-flex items-center gap-1">
                <UserRound size={12} strokeWidth={1.7} aria-hidden />
                {hostLabel(booking, members)}
              </span>
              {!cancelled && (
                <span className={`${CHIP} ${syncTone(booking.syncStatus)}`}>
                  Calendar {booking.syncStatus}
                </span>
              )}
              {booking.guests.length > 0 && (
                <span>
                  +{booking.guests.length} guest
                  {booking.guests.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
            {!cancelled && booking.meetingUrl && (
              <a
                href={booking.meetingUrl}
                target="_blank"
                rel="noreferrer"
                className={`inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-xs font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink ${FOCUS_RING}`}
              >
                <Video size={13} strokeWidth={1.7} aria-hidden />
                Join
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
            <a
              href={booking.manageUrl}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-mute transition-colors hover:bg-paper hover:text-ink ${FOCUS_RING}`}
            >
              Manage
              <ExternalLink size={12} strokeWidth={1.7} aria-hidden />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={`${expanded ? "Hide" : "Show"} details for ${booking.name}`}
              onClick={onToggle}
              className={`inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-ink-mute transition-colors hover:bg-paper hover:text-ink ${FOCUS_RING}`}
            >
              Details
              {expanded ? (
                <ChevronUp size={13} strokeWidth={1.7} aria-hidden />
              ) : (
                <ChevronDown size={13} strokeWidth={1.7} aria-hidden />
              )}
            </button>
          </div>
        </div>

        {expanded && (
          <MeetingDetails
            id={detailsId}
            booking={booking}
            members={members}
            displayTimezone={displayTimezone}
          />
        )}
      </article>
    </li>
  );
}

function MeetingDetails({
  id,
  booking,
  members,
  displayTimezone,
}: {
  id: string;
  booking: AdminBooking;
  members: BookingsResponse["members"];
  displayTimezone: string;
}) {
  return (
    <div
      id={id}
      role="region"
      aria-label={`Details for ${booking.name}`}
      className="mt-4 border-t border-hairline pt-4"
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <DetailCell icon={<Clock3 size={14} />} label="Your time">
          {formatFullDateTime(booking.startAt, displayTimezone)}
          <span className="mt-1 block text-[11px] text-ink-faint">
            {displayTimezone.replaceAll("_", " ")}
          </span>
        </DetailCell>
        <DetailCell icon={<Globe2 size={14} />} label="Booker time">
          {formatFullDateTime(booking.startAt, booking.timezone)}
          <span className="mt-1 block text-[11px] text-ink-faint">
            {booking.timezone.replaceAll("_", " ")}
          </span>
        </DetailCell>
        <DetailCell icon={<Users size={14} />} label="Guests">
          {booking.guests.length > 0
            ? booking.guests.join(", ")
            : "No additional guests"}
        </DetailCell>
        <DetailCell icon={<UserRound size={14} />} label="Hosts">
          {hostLabel(booking, members)}
          <span className="mt-1 block text-[11px] text-ink-faint">
            Created {formatFullDateTime(booking.createdAt, displayTimezone)}
          </span>
        </DetailCell>
      </div>

      {booking.notes && (
        <div className="mt-3 rounded-lg border border-hairline bg-paper px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
            Notes
          </p>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">
            {booking.notes}
          </p>
        </div>
      )}

      <div className="mt-3 rounded-lg border border-hairline bg-paper px-3.5 py-3">
        <div className="flex items-center gap-2">
          <BellRing size={14} className="text-ink-faint" aria-hidden />
          <h4 className="text-xs font-medium text-ink">
            Calendar delivery & reminders
          </h4>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className={`${CHIP} ${syncTone(booking.syncStatus)}`}>
            Calendar {booking.syncStatus}
          </span>
          {booking.remindersSent.length > 0 ? (
            booking.remindersSent.map((reminder) => (
              <span key={reminder} className={`${CHIP} text-ink-mute`}>
                {reminder === "24h"
                  ? "24-hour reminder sent"
                  : reminder === "1h"
                    ? "1-hour reminder sent"
                    : `${reminder} sent`}
              </span>
            ))
          ) : (
            <span className="text-xs text-ink-mute">No reminders sent yet</span>
          )}
        </div>
        {booking.status === "cancelled" && (
          <p className="mt-2 text-xs text-status-warn">
            Cancelled
            {booking.cancelledAt
              ? ` ${formatFullDateTime(booking.cancelledAt, displayTimezone)}`
              : ""}
          </p>
        )}
      </div>

      {booking.history.length > 0 && (
        <div className="mt-3 rounded-lg border border-hairline bg-paper px-3.5 py-3">
          <div className="flex items-center gap-2">
            <History size={14} className="text-ink-faint" aria-hidden />
            <h4 className="text-xs font-medium text-ink">Reschedule history</h4>
          </div>
          <ol className="mt-2 space-y-1.5 text-xs leading-5 text-ink-mute">
            {booking.history.map((change, index) => (
              <li key={`${change.changedAt}-${index}`}>
                Moved from {formatFullDateTime(change.startAt, displayTimezone)}
                {" · "}changed{" "}
                {formatFullDateTime(change.changedAt, displayTimezone)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function DetailCell({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-hairline bg-paper px-3.5 py-3">
      <div className="flex items-center gap-2 text-ink-faint">
        <span aria-hidden>{icon}</span>
        <span className="text-[11px] font-medium uppercase tracking-wide">
          {label}
        </span>
      </div>
      <p className="mt-1.5 break-words text-xs leading-5 text-ink-soft">
        {children}
      </p>
    </div>
  );
}

function ScheduleEmpty({
  hasAnyBookings,
  onClear,
}: {
  hasAnyBookings: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-5 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-paper text-ink-faint">
        <CalendarDays size={19} strokeWidth={1.5} aria-hidden />
      </span>
      <h2 className="font-serif-display mt-4 text-xl font-bold tracking-tight text-ink">
        {hasAnyBookings ? "No meetings match" : "No meetings booked yet"}
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-6 text-ink-mute">
        {hasAnyBookings
          ? "Try another timeframe or clear the filters to return to the upcoming schedule."
          : "New bookings will appear here as soon as someone chooses a time."}
      </p>
      {hasAnyBookings && (
        <button
          type="button"
          onClick={onClear}
          className={`mt-4 rounded-lg border border-hairline px-3.5 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink ${FOCUS_RING}`}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function ScheduleSkeleton() {
  return (
    <section
      className="mx-auto w-full max-w-7xl motion-safe:animate-pulse"
      aria-label="Loading schedule"
      aria-busy="true"
    >
      <div className="h-3 w-32 rounded bg-hairline" />
      <div className="mt-3 h-10 w-48 rounded bg-hairline" />
      <div className="mt-3 h-4 w-64 max-w-full rounded bg-hairline" />
      <div className="mt-6 grid gap-3 lg:grid-cols-[minmax(0,1.75fr)_minmax(320px,1fr)]">
        <div className="h-64 rounded-2xl border border-hairline bg-paper-raise" />
        <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className="h-24 rounded-xl border border-hairline bg-paper-raise"
            />
          ))}
        </div>
      </div>
      <div className="mt-6 overflow-hidden rounded-2xl border border-hairline bg-paper-raise">
        <div className="h-32 border-b border-hairline" />
        <div className="space-y-3 p-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="h-20 rounded-xl border border-hairline bg-paper"
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ScheduleFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="mx-auto flex min-h-[28rem] w-full max-w-3xl items-center justify-center px-5">
      <div className="w-full rounded-2xl border border-hairline bg-paper-raise p-7 text-center sm:p-9">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-status-warn/25 bg-status-warn/5 text-status-warn">
          <AlertTriangle size={19} strokeWidth={1.6} aria-hidden />
        </span>
        <h2 className="font-serif-display mt-4 text-2xl font-bold tracking-tight text-ink">
          The schedule could not load
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-mute">
          The booking data is temporarily unavailable. Your calendar connections
          and meetings were not changed.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className={`mt-5 inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-4 text-sm font-medium text-paper transition-opacity hover:opacity-90 ${FOCUS_RING}`}
        >
          <RefreshCw size={15} strokeWidth={1.7} aria-hidden />
          Try again
        </button>
      </div>
    </section>
  );
}

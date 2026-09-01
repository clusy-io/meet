"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CalendarCheck2,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  RefreshCw,
  Sparkles,
  WifiOff,
} from "lucide-react";
import {
  addCivilDays,
  availabilitySlotsForDates,
  busyRangesForDay,
  clockToMinutes,
  dateKeysBetween,
  freeRangesForMember,
  groupAvailabilitySlots,
  minuteInTimezone,
  minutesToClock,
  ordinal,
  outsideWorkingRangesForMember,
  startOfIsoWeek,
  todayInTimezone,
  type MinuteRange,
  type TeamAvailabilitySlot,
  type TeamAvailabilityWindow,
} from "./teamAvailability";
import type { TeamAvailabilityMember, TeamAvailabilityResponse } from "./types";

type Phase = "idle" | "loading" | "ready" | "failed";

const MEMBER_COLORS = [
  "#9a5b35",
  "#35756f",
  "#6b5b95",
  "#b17927",
  "#a65168",
  "#426e9b",
] as const;

function dateValue(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00.000Z`);
}

function formatDate(
  dateKey: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    ...options,
  }).format(dateValue(dateKey));
}

function formatWeekRange(dateKeys: string[]): string {
  const first = dateKeys[0];
  const last = dateKeys[dateKeys.length - 1];
  if (!first || !last) return "";
  const sameMonth = first.slice(0, 7) === last.slice(0, 7);
  const firstLabel = formatDate(first, {
    month: "short",
    day: "numeric",
    year: sameMonth ? undefined : "numeric",
  });
  const lastLabel = formatDate(last, {
    month: sameMonth ? undefined : "short",
    day: "numeric",
    year: "numeric",
  });
  return `${firstLabel} – ${lastLabel}`;
}

function relativeDayLabel(dateKey: string, today: string): string {
  const delta = ordinal(dateKey) - ordinal(today);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  return formatDate(dateKey, { weekday: "long" });
}

function rankWindows(windows: TeamAvailabilityWindow[]) {
  return [...windows].sort((left, right) => {
    const people = right.freeMemberKeys.length - left.freeMemberKeys.length;
    if (people !== 0) return people;
    const length = right.end - right.start - (left.end - left.start);
    if (length !== 0) return length;
    return (
      left.dateKey.localeCompare(right.dateKey) || left.start - right.start
    );
  });
}

function futureSlots(
  slots: TeamAvailabilitySlot[],
  nowMs: number,
  minNoticeMinutes: number,
): TeamAvailabilitySlot[] {
  const edgeMs = nowMs + minNoticeMinutes * 60_000;
  return slots.filter((slot) => Date.parse(slot.startAt) >= edgeMs);
}

function statusCopy(ready: number, total: number): string {
  if (ready === total) return "Every calendar is answering";
  if (ready === 0) return "Calendar data is unavailable";
  return `${ready} of ${total} calendars are answering`;
}

function describeRanges(ranges: MinuteRange[]): string {
  return ranges
    .map(
      (range) =>
        `${minutesToClock(range.start)} to ${minutesToClock(range.end)}`,
    )
    .join(", ");
}

function useLiveNow(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const update = () => setNowMs(Date.now());
    update();
    const timer = window.setInterval(update, 30_000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") update();
    };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [active]);
  return nowMs;
}

export function TeamAvailabilityView({
  active,
  hostTimezone,
  onUnauthorized,
}: {
  active: boolean;
  hostTimezone: string;
  onUnauthorized: () => void;
}) {
  const initialToday = todayInTimezone(hostTimezone);
  const [weekStart, setWeekStart] = useState(() =>
    startOfIsoWeek(initialToday),
  );
  const [selectedDate, setSelectedDate] = useState(initialToday);
  const [phase, setPhase] = useState<Phase>("idle");
  const [data, setData] = useState<TeamAvailabilityResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const loadedWeekRef = useRef<string | null>(null);
  const nowMs = useLiveNow(active);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const request = window.requestAnimationFrame(() => {
      const isBackground = loadedWeekRef.current === weekStart && data !== null;
      if (isBackground) {
        setRefreshing(true);
      } else {
        setPhase("loading");
        setData(null);
      }
      setRefreshError(null);

      void (async () => {
        try {
          const response = await fetch(
            `/api/meet/admin/availability?from=${encodeURIComponent(weekStart)}&days=7`,
            { cache: "no-store", signal: controller.signal },
          );
          if (response.status === 401) {
            onUnauthorized();
            return;
          }
          if (!response.ok) throw new Error(`status ${response.status}`);
          const next = (await response.json()) as TeamAvailabilityResponse;
          if (controller.signal.aborted) return;
          setData(next);
          setPhase("ready");
          loadedWeekRef.current = weekStart;
        } catch (error) {
          if (controller.signal.aborted) return;
          console.error("meet: admin availability failed", error);
          if (isBackground) {
            setPhase("ready");
            setRefreshError(
              "The refresh did not finish. Showing the last reliable calendar picture.",
            );
          } else {
            setPhase("failed");
          }
        } finally {
          if (!controller.signal.aborted) setRefreshing(false);
        }
      })();
    });

    return () => {
      window.cancelAnimationFrame(request);
      controller.abort();
    };
    // `data` is intentionally excluded: it only decides foreground vs.
    // background treatment and must not turn a successful response into a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onUnauthorized, reloadVersion, weekStart]);

  const dateKeys = useMemo(() => dateKeysBetween(weekStart, 7), [weekStart]);

  const availability = useMemo(() => {
    if (!data) return null;
    const slots = futureSlots(
      availabilitySlotsForDates(data, dateKeys),
      nowMs,
      data.minNoticeMinutes,
    );
    const today = todayInTimezone(data.hostTimezone, nowMs);
    const nowMinute = minuteInTimezone(
      new Date(nowMs).toISOString(),
      data.hostTimezone,
    );
    const upcomingWindows = rankWindows(groupAvailabilitySlots(slots));
    const selectedSlots = slots.filter((slot) => slot.dateKey === selectedDate);
    return {
      slots,
      today,
      nowMinute,
      upcomingWindows,
      selectedWindows: groupAvailabilitySlots(selectedSlots),
    };
  }, [data, dateKeys, nowMs, selectedDate]);

  const moveWeek = (amount: number) => {
    const next = addCivilDays(weekStart, amount * 7);
    setWeekStart(next);
    setSelectedDate(next);
  };

  const goToToday = () => {
    const today = todayInTimezone(data?.hostTimezone ?? hostTimezone);
    setWeekStart(startOfIsoWeek(today));
    setSelectedDate(today);
  };

  if (phase === "idle" || phase === "loading") {
    return <AvailabilityLoading />;
  }

  if (phase === "failed" || !data || !availability) {
    return (
      <AvailabilityError
        onRetry={() => {
          loadedWeekRef.current = null;
          setReloadVersion((value) => value + 1);
        }}
      />
    );
  }

  const readyMembers = data.members.filter(
    (member) => member.status === "ready",
  );
  const bestWindow = availability.upcomingWindows[0] ?? null;
  const totalOpenings = availability.slots.length;

  return (
    <section aria-labelledby="team-availability-heading">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-ink-faint">
            <CalendarRange className="h-3.5 w-3.5" strokeWidth={1.7} />
            Team calendar
          </div>
          <h2
            id="team-availability-heading"
            className="mt-2 max-w-full text-balance font-serif-display text-3xl tracking-tight text-ink"
          >
            Find the moment that fits
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-mute">
            See everyone’s busy time together, then choose a window with the
            right people free. Event details stay private.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-2 rounded-full border border-hairline bg-paper-raise px-3 py-2 text-xs text-ink-mute sm:inline-flex">
            <span
              className="h-1.5 w-1.5 rounded-full bg-status-ok"
              aria-hidden
            />
            Updated {formatSyncTime(data.generatedAt, data.hostTimezone)}
          </span>
          <button
            type="button"
            onClick={() => setReloadVersion((value) => value + 1)}
            disabled={refreshing}
            aria-label="Refresh calendar availability"
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-hairline bg-paper-raise px-3.5 text-sm font-medium text-ink-soft shadow-[0_1px_0_hsl(var(--ink)_/_0.03)] transition hover:border-hairline-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-60"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "motion-safe:animate-spin" : ""}`}
              aria-hidden
            />
            <span className="hidden sm:inline">
              {refreshing ? "Refreshing" : "Refresh"}
            </span>
          </button>
        </div>
      </div>

      {refreshError && (
        <div
          role="status"
          className="mt-4 flex items-start gap-2.5 rounded-xl border border-status-warn/25 bg-status-warn/[0.05] px-3.5 py-3 text-xs leading-5 text-status-warn"
        >
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {refreshError}
        </div>
      )}

      <div className="relative mt-6 overflow-hidden rounded-3xl border border-hairline bg-ink px-5 py-6 text-paper shadow-[0_20px_50px_hsl(var(--ink)_/_0.12)] sm:px-7 sm:py-7">
        <div
          className="pointer-events-none absolute -right-20 -top-36 h-80 w-80 rounded-full bg-[radial-gradient(circle,hsl(var(--accent-bright)_/_0.42),transparent_68%)]"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute bottom-[-9rem] left-[28%] h-64 w-96 rounded-full bg-[radial-gradient(circle,hsl(var(--status-ok)_/_0.18),transparent_70%)]"
          aria-hidden
        />
        <div className="relative grid gap-7 lg:grid-cols-[minmax(0,1.6fr)_minmax(17rem,0.75fr)] lg:items-end">
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-paper/55">
              <Sparkles className="h-3.5 w-3.5 text-paper/75" aria-hidden />
              Best shared window
            </div>
            {bestWindow ? (
              <>
                <p className="mt-4 font-serif-display text-3xl leading-tight tracking-tight sm:text-4xl">
                  {relativeDayLabel(bestWindow.dateKey, availability.today)}
                  <span className="text-paper/48"> · </span>
                  {minutesToClock(bestWindow.start)}
                </p>
                <p className="mt-2 text-sm text-paper/62">
                  Open until {minutesToClock(bestWindow.end)} ·{" "}
                  {bestWindow.freeMemberKeys.length === data.members.length
                    ? `all ${data.members.length} members are free`
                    : `${bestWindow.freeMemberKeys.length} of ${data.members.length} members confirmed free`}
                </p>
                <MemberNameList
                  className="mt-5"
                  members={data.members.filter((member) =>
                    bestWindow.freeMemberKeys.includes(member.key),
                  )}
                  paletteMembers={data.members}
                />
              </>
            ) : (
              <>
                <p className="mt-4 font-serif-display text-3xl leading-tight tracking-tight sm:text-4xl">
                  No shared window yet
                </p>
                <p className="mt-2 max-w-xl text-sm leading-6 text-paper/62">
                  Try another week, or reconnect a calendar that is not
                  answering. We never treat missing calendar data as free.
                </p>
              </>
            )}
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <HeroStat
              label="Open starts"
              value={String(totalOpenings)}
              detail="this week"
            />
            <HeroStat
              label="Calendars live"
              value={`${readyMembers.length}/${data.members.length}`}
              detail={statusCopy(readyMembers.length, data.members.length)}
              warning={readyMembers.length !== data.members.length}
            />
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-hairline bg-paper-raise p-3 shadow-[0_1px_0_hsl(var(--ink)_/_0.025)] sm:p-4">
        <div className="flex items-center justify-between gap-3 px-1 pb-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => moveWeek(-1)}
              aria-label="Previous week"
              className="grid h-9 w-9 place-items-center rounded-xl text-ink-mute transition hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => moveWeek(1)}
              aria-label="Next week"
              className="grid h-9 w-9 place-items-center rounded-xl text-ink-mute transition hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
            <p className="ml-1 text-sm font-semibold text-ink">
              {formatWeekRange(dateKeys)}
            </p>
          </div>
          <button
            type="button"
            onClick={goToToday}
            className="rounded-lg px-3 py-2 text-xs font-medium text-ink-mute transition hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            Today
          </button>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {dateKeys.map((dateKey) => {
            const daySlots = availability.slots.filter(
              (slot) => slot.dateKey === dateKey,
            );
            const selected = selectedDate === dateKey;
            const bookable = data.bookableDates.includes(dateKey);
            const past = dateKey < availability.today;
            return (
              <DayButton
                key={dateKey}
                dateKey={dateKey}
                selected={selected}
                today={dateKey === availability.today}
                muted={past}
                bookable={bookable}
                openings={daySlots.length}
                onClick={() => setSelectedDate(dateKey)}
              />
            );
          })}
        </div>
      </div>

      <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <DayTimeline
          response={data}
          dateKey={selectedDate}
          today={availability.today}
          nowMinute={availability.nowMinute}
          teamWindows={availability.selectedWindows}
        />
        <BestWindowsCard
          windows={availability.upcomingWindows.slice(0, 5)}
          response={data}
          today={availability.today}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
        />
      </div>
    </section>
  );
}

function AvailabilityLoading() {
  return (
    <section aria-label="Loading team availability" aria-busy="true">
      <div className="h-4 w-32 motion-safe:animate-pulse rounded bg-hairline" />
      <div className="mt-3 h-9 w-80 max-w-full motion-safe:animate-pulse rounded-lg bg-hairline" />
      <div className="mt-6 h-52 motion-safe:animate-pulse rounded-3xl bg-hairline" />
      <div className="mt-6 grid grid-cols-7 gap-2">
        {Array.from({ length: 7 }, (_, index) => (
          <div
            key={index}
            className="h-24 motion-safe:animate-pulse rounded-xl bg-hairline"
          />
        ))}
      </div>
      <div className="mt-6 h-80 motion-safe:animate-pulse rounded-2xl bg-hairline" />
    </section>
  );
}

function AvailabilityError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[32rem] items-center justify-center rounded-3xl border border-hairline bg-paper-raise px-6">
      <div className="max-w-md text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-status-warn/10 text-status-warn">
          <WifiOff className="h-5 w-5" aria-hidden />
        </span>
        <h2 className="mt-5 font-serif-display text-2xl tracking-tight text-ink">
          The calendars didn’t answer
        </h2>
        <p className="mt-2 text-sm leading-6 text-ink-mute">
          We could not build a reliable availability picture. No one is shown as
          free until their calendar can be read safely.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl bg-ink px-5 text-sm font-medium text-paper transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function HeroStat({
  label,
  value,
  detail,
  warning = false,
}: {
  label: string;
  value: string;
  detail: string;
  warning?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-paper/12 bg-paper/[0.07] p-4 backdrop-blur-sm">
      <p className="text-[11px] font-medium text-paper/50">{label}</p>
      <p className="mt-1 font-serif-display text-3xl leading-none text-paper">
        {value}
      </p>
      <p
        className={`mt-2 line-clamp-1 text-[11px] ${warning ? "text-amber-300/80" : "text-paper/45"}`}
        title={detail}
      >
        {detail}
      </p>
    </div>
  );
}

function DayButton({
  dateKey,
  selected,
  today,
  muted,
  bookable,
  openings,
  onClick,
}: {
  dateKey: string;
  selected: boolean;
  today: boolean;
  muted: boolean;
  bookable: boolean;
  openings: number;
  onClick: () => void;
}) {
  const label = !bookable
    ? "Closed"
    : openings === 0
      ? "No overlap"
      : `${openings} opening${openings === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${formatDate(dateKey, { weekday: "long", month: "long", day: "numeric" })}: ${label}`}
      onClick={onClick}
      className={`relative min-w-[7.4rem] flex-1 rounded-xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-w-[6.5rem] ${
        selected
          ? "border-accent/35 bg-accent/[0.08] shadow-[0_8px_24px_hsl(var(--accent)_/_0.08)]"
          : "border-transparent bg-paper hover:border-hairline hover:bg-paper-raise"
      } ${muted && !selected ? "opacity-55" : ""}`}
    >
      {today && (
        <span className="absolute right-2.5 top-2.5 h-1.5 w-1.5 rounded-full bg-accent" />
      )}
      <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-faint">
        {formatDate(dateKey, { weekday: "short" })}
      </p>
      <p className="mt-1 font-serif-display text-2xl leading-none text-ink">
        {formatDate(dateKey, { day: "numeric" })}
      </p>
      <div className="mt-3 flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            openings > 0 && bookable ? "bg-status-ok" : "bg-ink-faint/45"
          }`}
          aria-hidden
        />
        <span className="truncate text-[10px] text-ink-mute">{label}</span>
      </div>
    </button>
  );
}

function DayTimeline({
  response,
  dateKey,
  today,
  nowMinute,
  teamWindows,
}: {
  response: TeamAvailabilityResponse;
  dateKey: string;
  today: string;
  nowMinute: number;
  teamWindows: TeamAvailabilityWindow[];
}) {
  const windowStart = clockToMinutes(response.window.start);
  const windowEnd = clockToMinutes(response.window.end);
  const span = windowEnd - windowStart;
  const bookable = response.bookableDates.includes(dateKey);
  const tickStep = span > 10 * 60 ? 120 : 60;
  const firstTick = Math.ceil(windowStart / tickStep) * tickStep;
  const ticks: number[] = [];
  for (let tick = firstTick; tick < windowEnd; tick += tickStep)
    ticks.push(tick);
  const currentVisible =
    dateKey === today && nowMinute >= windowStart && nowMinute <= windowEnd;
  const currentLeft = ((nowMinute - windowStart) / span) * 100;

  return (
    <div className="overflow-hidden rounded-2xl border border-hairline bg-paper-raise shadow-[0_1px_0_hsl(var(--ink)_/_0.025)]">
      <div className="flex flex-col gap-3 border-b border-hairline px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-serif-display text-xl tracking-tight text-ink">
              {formatDate(dateKey, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </h3>
            {dateKey === today && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
                Today
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-ink-mute">
            {response.hostTimezone.replaceAll("_", " ")} ·{" "}
            {response.window.start}–{response.window.end}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-ink-mute">
          <LegendSwatch tone="available">Shared opening</LegendSwatch>
          <LegendSwatch tone="busy">Busy</LegendSwatch>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full border border-status-warn bg-status-warn/15" />
            Unavailable
          </span>
        </div>
      </div>

      {!bookable ? (
        <div className="grid min-h-[22rem] place-items-center px-6 text-center">
          <div>
            <CalendarRange
              className="mx-auto h-7 w-7 text-ink-faint"
              strokeWidth={1.4}
            />
            <h4 className="mt-4 text-sm font-semibold text-ink">
              Not a booking day
            </h4>
            <p className="mt-1 text-sm text-ink-mute">
              Choose a weekday to compare the team’s calendars.
            </p>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[760px] p-4 sm:p-5">
            <div className="grid grid-cols-[10.5rem_minmax(34rem,1fr)] items-end">
              <div className="pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Host
              </div>
              <div className="relative h-8 border-b border-hairline">
                {ticks.map((tick) => (
                  <span
                    key={tick}
                    className="absolute bottom-2 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] text-ink-faint"
                    style={{ left: `${((tick - windowStart) / span) * 100}%` }}
                  >
                    {minutesToClock(tick).replace(":00", "")}
                  </span>
                ))}
              </div>
            </div>

            <TimelineRow
              label={
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 place-items-center rounded-xl bg-status-ok/10 text-status-ok">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <div>
                    <p className="text-xs font-semibold text-ink">
                      Team overlap
                    </p>
                    <p className="text-[10px] text-ink-faint">
                      {response.quorum}+ members
                    </p>
                  </div>
                </div>
              }
              ariaLabel={
                teamWindows.length > 0
                  ? `Shared openings: ${describeRanges(teamWindows)}`
                  : "No shared opening on this day"
              }
              ticks={ticks}
              windowStart={windowStart}
              span={span}
              currentVisible={currentVisible}
              currentLeft={currentLeft}
            >
              {teamWindows.map((window, index) => (
                <TimelineBlock
                  key={`${window.start}-${window.end}-${index}`}
                  range={window}
                  windowStart={windowStart}
                  span={span}
                  className="border-status-ok/30 bg-[linear-gradient(135deg,hsl(var(--status-ok)_/_0.18),hsl(var(--status-ok)_/_0.08))] text-status-ok"
                  label={`${window.freeMemberKeys.length} free`}
                  title={`${minutesToClock(window.start)}–${minutesToClock(window.end)} · ${window.freeMemberKeys.length} members free`}
                />
              ))}
              {teamWindows.length === 0 && (
                <span className="absolute inset-0 flex items-center pl-3 text-[10px] text-ink-faint">
                  No quorum-length opening on this day
                </span>
              )}
            </TimelineRow>

            {response.members.map((member, index) => {
              const color = MEMBER_COLORS[index % MEMBER_COLORS.length];
              const busy = busyRangesForDay(
                member.busy,
                dateKey,
                response.hostTimezone,
                windowStart,
                windowEnd,
              );
              const free = freeRangesForMember(member, dateKey, response);
              const outsideHours = outsideWorkingRangesForMember(
                member,
                dateKey,
                response,
              );
              const freeMinutes = free.reduce(
                (sum, range) => sum + range.end - range.start,
                0,
              );
              return (
                <TimelineRow
                  key={member.key}
                  label={
                    <MemberLabel
                      member={member}
                      color={color}
                      freeMinutes={freeMinutes}
                    />
                  }
                  ariaLabel={
                    member.status === "ready"
                      ? `${member.name}. Busy: ${busy.length > 0 ? describeRanges(busy) : "none"}. Free within working hours: ${free.length > 0 ? describeRanges(free) : "none"}.`
                      : `${member.name}: calendar unavailable`
                  }
                  ticks={ticks}
                  windowStart={windowStart}
                  span={span}
                  currentVisible={currentVisible}
                  currentLeft={currentLeft}
                >
                  {member.status === "ready" ? (
                    <>
                      {outsideHours.map((range, outsideIndex) => (
                        <TimelineBlock
                          key={`outside-${range.start}-${range.end}-${outsideIndex}`}
                          range={range}
                          windowStart={windowStart}
                          span={span}
                          label="Off hours"
                          title={`Outside working hours · ${minutesToClock(range.start)}–${minutesToClock(range.end)}`}
                          className="border-hairline-strong/70 bg-ink/[0.045] text-ink-faint"
                        />
                      ))}
                      {busy.map((range, busyIndex) => (
                        <TimelineBlock
                          key={`${range.start}-${range.end}-${busyIndex}`}
                          range={range}
                          windowStart={windowStart}
                          span={span}
                          label="Busy"
                          title={`Busy · ${minutesToClock(range.start)}–${minutesToClock(range.end)}`}
                          style={{
                            borderColor: `${color}55`,
                            color,
                            background: `repeating-linear-gradient(135deg, ${color}18 0, ${color}18 6px, ${color}2f 6px, ${color}2f 8px)`,
                          }}
                        />
                      ))}
                    </>
                  ) : (
                    <div className="absolute inset-y-2 inset-x-0 flex items-center rounded-lg border border-dashed border-status-warn/35 bg-status-warn/[0.04] px-3 text-[10px] text-status-warn">
                      Calendar could not be read — treated as unavailable
                    </div>
                  )}
                </TimelineRow>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TimelineRow({
  label,
  ariaLabel,
  ticks,
  windowStart,
  span,
  currentVisible,
  currentLeft,
  children,
}: {
  label: ReactNode;
  ariaLabel: string;
  ticks: number[];
  windowStart: number;
  span: number;
  currentVisible: boolean;
  currentLeft: number;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-[4.6rem] grid-cols-[10.5rem_minmax(34rem,1fr)] border-b border-hairline last:border-b-0">
      <div className="flex items-center pr-4">{label}</div>
      <div
        className="relative my-2.5 overflow-hidden rounded-xl bg-paper"
        role="img"
        aria-label={ariaLabel}
      >
        {ticks.map((tick) => (
          <span
            key={tick}
            className="pointer-events-none absolute inset-y-0 w-px bg-hairline"
            style={{ left: `${((tick - windowStart) / span) * 100}%` }}
            aria-hidden
          />
        ))}
        {children}
        {currentVisible && (
          <span
            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent"
            style={{ left: `${currentLeft}%` }}
            aria-hidden
          >
            <span className="absolute -left-[3px] top-1 h-[7px] w-[7px] rounded-full bg-accent ring-2 ring-paper" />
          </span>
        )}
      </div>
    </div>
  );
}

function TimelineBlock({
  range,
  windowStart,
  span,
  label,
  title,
  className = "",
  style,
}: {
  range: MinuteRange;
  windowStart: number;
  span: number;
  label: string;
  title: string;
  className?: string;
  style?: CSSProperties;
}) {
  const left = ((range.start - windowStart) / span) * 100;
  const width = ((range.end - range.start) / span) * 100;
  return (
    <span
      className={`absolute inset-y-2 z-10 flex min-w-[3px] items-center overflow-hidden rounded-lg border px-2 text-[9px] font-semibold ${className}`}
      style={{ left: `${left}%`, width: `${width}%`, ...style }}
      title={title}
      aria-hidden
    >
      {width >= 6 ? label : ""}
    </span>
  );
}

function MemberLabel({
  member,
  color,
  freeMinutes,
}: {
  member: TeamAvailabilityMember;
  color: string;
  freeMinutes: number;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        className="h-8 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-ink">{member.name}</p>
        {member.status === "ready" ? (
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-ink-faint">
            <Check className="h-2.5 w-2.5 text-status-ok" aria-hidden />
            {(freeMinutes / 60).toFixed(freeMinutes % 60 === 0 ? 0 : 1)}h free
          </p>
        ) : (
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-status-warn">
            <CircleAlert className="h-2.5 w-2.5" aria-hidden />
            Unavailable
          </p>
        )}
      </div>
    </div>
  );
}

function BestWindowsCard({
  windows,
  response,
  today,
  selectedDate,
  onSelectDate,
}: {
  windows: TeamAvailabilityWindow[];
  response: TeamAvailabilityResponse;
  today: string;
  selectedDate: string;
  onSelectDate: (dateKey: string) => void;
}) {
  return (
    <aside className="rounded-2xl border border-hairline bg-paper-raise p-4 shadow-[0_1px_0_hsl(var(--ink)_/_0.025)] xl:sticky xl:top-32">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
            <CalendarCheck2 className="h-3.5 w-3.5" aria-hidden />
            Best windows
          </div>
          <p className="mt-2 text-xs leading-5 text-ink-mute">
            Ranked by people free, then by uninterrupted time.
          </p>
        </div>
        <span className="rounded-full bg-status-ok/10 px-2 py-1 font-mono text-[10px] text-status-ok">
          {response.quorum}+ free
        </span>
      </div>

      {windows.length > 0 ? (
        <div className="mt-4 space-y-2">
          {windows.map((window, index) => {
            const freeMembers = response.members.filter((member) =>
              window.freeMemberKeys.includes(member.key),
            );
            return (
              <button
                key={`${window.dateKey}-${window.start}-${index}`}
                type="button"
                onClick={() => onSelectDate(window.dateKey)}
                className={`group w-full rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                  selectedDate === window.dateKey
                    ? "border-accent/30 bg-accent/[0.06]"
                    : "border-hairline bg-paper hover:border-hairline-strong hover:bg-paper-raise"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-ink">
                      {relativeDayLabel(window.dateKey, today)}
                    </p>
                    <p className="mt-1 font-mono text-[11px] text-ink-mute">
                      {minutesToClock(window.start)}–
                      {minutesToClock(window.end)}
                    </p>
                  </div>
                  <span className="rounded-lg bg-status-ok/10 px-2 py-1 text-[9px] font-semibold text-status-ok">
                    {window.freeMemberKeys.length === response.members.length
                      ? "Everyone"
                      : `${window.freeMemberKeys.length}/${response.members.length}`}
                  </span>
                </div>
                <MemberNameList
                  className="mt-3"
                  members={freeMembers}
                  paletteMembers={response.members}
                  small
                />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-dashed border-hairline-strong bg-paper px-4 py-8 text-center">
          <Clock3 className="mx-auto h-5 w-5 text-ink-faint" aria-hidden />
          <p className="mt-3 text-xs font-semibold text-ink">
            No future overlap
          </p>
          <p className="mt-1 text-[11px] leading-5 text-ink-mute">
            Move to the next week to keep looking.
          </p>
        </div>
      )}

      <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-paper px-3 py-3 text-[10px] leading-4 text-ink-faint">
        <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        Busy blocks never include event titles, guests, or calendar names.
      </div>
    </aside>
  );
}

function MemberNameList({
  members,
  paletteMembers = members,
  className = "",
  small = false,
}: {
  members: TeamAvailabilityMember[];
  paletteMembers?: TeamAvailabilityMember[];
  className?: string;
  small?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 ${className}`}
    >
      {members.map((member) => {
        const index = Math.max(
          0,
          paletteMembers.findIndex((candidate) => candidate.key === member.key),
        );
        return (
          <span
            key={member.key}
            className={`inline-flex min-w-0 items-center gap-1.5 ${small ? "text-[10px] text-ink-faint" : "text-xs text-paper/60"}`}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-[3px]"
              style={{
                backgroundColor: MEMBER_COLORS[index % MEMBER_COLORS.length],
              }}
              aria-hidden
            />
            <span className="max-w-32 truncate">{member.name}</span>
          </span>
        );
      })}
    </div>
  );
}

function LegendSwatch({
  tone,
  children,
}: {
  tone: "available" | "busy";
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`h-2 w-4 rounded-sm border ${
          tone === "available"
            ? "border-status-ok/35 bg-status-ok/15"
            : "border-ink-faint/35 bg-[repeating-linear-gradient(135deg,hsl(var(--ink-faint)_/_0.12)_0,hsl(var(--ink-faint)_/_0.12)_3px,hsl(var(--ink-faint)_/_0.24)_3px,hsl(var(--ink-faint)_/_0.24)_4px)]"
        }`}
        aria-hidden
      />
      {children}
    </span>
  );
}

function formatSyncTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return "just now";
  }
}

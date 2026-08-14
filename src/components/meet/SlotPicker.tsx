"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  addCivilDays,
  civilDayNumber,
  formatCivilDate,
  parseCivilDate,
  utcToWall,
} from "@/lib/meet/tz";
import type { AvailabilityResponse } from "@/lib/meet/types";
import { TimezoneSelect } from "@/components/meet/TimezoneSelect";

/**
 * Slot picker for the public booking page: one animated composition in up to three stages.
 *
 *   1. A month calendar, centered.
 *   2. Pick a date: the calendar slides to the left column, the day's times
 *      expand beside it.
 *   3. (only when the parent passes `formSlot`) Pick a time: the times
 *      compress into a slim middle column, calendar and chosen date stay in
 *      view, and the guest form opens on the right.
 *
 * Animation rules learned the hard way: panel movement is explicit and the
 * opening calendar renders at its real CSS size. Framer layout projection and
 * authored scale transforms must not share an element; a background timer can
 * otherwise replay a stale translation after the page has settled.
 *
 * Phones swap stages in place instead: calendar, then times behind a date
 * summary bar, then the form behind a date-plus-time summary bar.
 *
 * Availability is fetched once per mount; the server's minimum-notice window
 * is re-applied against a live clock so slots age out without a refetch.
 * `manageToken` constrains slots to an existing booking's attendees.
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

const WEEKDAY_HEADER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Mon=0 .. Sun=6 for a civil day number (epoch day 0 was a Thursday). */
function weekdayIndex(dayNumber: number): number {
  return (dayNumber + 3) % 7;
}

const MONTH_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

const CALENDAR_DAY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

function focusWhenVisible(selector: string, attempts = 0): void {
  const target = [...document.querySelectorAll<HTMLElement>(selector)].find(
    // Generating boxes is not enough to be the LIVE copy. It correctly rejects
    // the display:none responsive twin, but an exiting popLayout child also
    // has boxes: framer pins it position:absolute and splices it back at its
    // old index, so it precedes the entering panel in document order. Focusing
    // it puts the caret on a node framer unmounts half a second later, dropping
    // focus to <body> — and until then, Enter re-selects a time on the day the
    // visitor has just left.
    (element) => element.getClientRects().length > 0 && !element.closest("[data-motion-pop-id]")
  );
  if (target) {
    // preventScroll: focus() otherwise scrolls ancestors to reveal the target,
    // measured one frame into the entrance spring, so it lands short of where
    // the panel settles and nothing closes the gap.
    target.focus({ preventScroll: true });
    return;
  }
  if (attempts < 60) {
    window.requestAnimationFrame(() => focusWhenVisible(selector, attempts + 1));
  }
}

interface MonthCell {
  key: string; // "YYYY-MM-DD" in the visitor's timezone
  dayNum: number;
  inMonth: boolean;
  slotCount: number;
}

interface MonthModel {
  key: string; // "YYYY-MM"
  labelMs: number;
  weeks: MonthCell[][];
}

type AvailabilityLoadState =
  | { requestKey: string; status: "loading" }
  | { requestKey: string; status: "ready"; data: AvailabilityResponse }
  | { requestKey: string; status: "failed" | "not-found" };

function buildMonth(
  year: number,
  month: number,
  slotsByDay: Map<string, string[]>
): MonthModel {
  const firstNumber = civilDayNumber(year, month, 1);
  const start = addCivilDays(year, month, 1, -weekdayIndex(firstNumber));
  const weeks: MonthCell[][] = [];
  let cursor = start;
  do {
    const week: MonthCell[] = [];
    for (let i = 0; i < 7; i++) {
      const key = formatCivilDate(cursor.year, cursor.month, cursor.day);
      week.push({
        key,
        dayNum: cursor.day,
        inMonth: cursor.month === month,
        slotCount: slotsByDay.get(key)?.length ?? 0,
      });
      cursor = addCivilDays(cursor.year, cursor.month, cursor.day, 1);
    }
    weeks.push(week);
  } while (cursor.month === month && cursor.year === year);
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    labelMs: Date.UTC(year, month - 1, 1, 12),
    weeks,
  };
}

export function SlotPicker(props: {
  onSelect: (startIso: string, timezone: string, durationMinutes: number) => void;
  selecting?: boolean;
  manageToken?: string;
  timezone?: string;
  onTimezoneChange?: (timezone: string) => void;
  /** The chosen slot; drives stage 3 when `formSlot` is present. */
  selectedSlot?: string | null;
  /** Third-column content (the guest form); rendered once a slot is chosen. */
  formSlot?: ReactNode;
  /** Called when the visitor asks to change the chosen time (or date). */
  onClearSlot?: () => void;
}): ReactElement {
  const {
    onSelect,
    selecting = false,
    manageToken,
    timezone: timezoneProp,
    onTimezoneChange,
    selectedSlot = null,
    formSlot = null,
    onClearSlot,
  } = props;

  const [attempt, setAttempt] = useState(0);
  const requestKey = `${manageToken ?? "public"}:${attempt}`;
  const [loadState, setLoadState] = useState<AvailabilityLoadState>({
    requestKey,
    status: "loading",
  });
  const [internalTimezone, setInternalTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const timezone = timezoneProp ?? internalTimezone;
  const handleTimezoneChange = onTimezoneChange ?? setInternalTimezone;
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [monthKey, setMonthKey] = useState<string | null>(null);
  const [navDir, setNavDir] = useState(1);
  const reducedMotion = useReducedMotion() ?? false;

  // Live clock used to retire a slot at the exact minimum-notice boundary.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Which selection each time column has already been scrolled to reveal, so
  // the reveal is idempotent per selection rather than per render. Keyed BY
  // NODE: the mobile and desktop columns are both mounted and both call the
  // ref, so a single slot of memory would let them clobber each other's entry
  // and re-run the reveal on every render anyway.
  const revealedRef = useRef(new WeakMap<HTMLElement, string>());

  useEffect(() => {
    let cancelled = false;
    const url = manageToken
      ? `/api/meet/availability?token=${encodeURIComponent(manageToken)}`
      : "/api/meet/availability";
    fetch(url)
      .then((res) => {
        if (manageToken && res.status === 404) {
          if (!cancelled) setLoadState({ requestKey, status: "not-found" });
          return null;
        }
        if (!res.ok) throw new Error(`availability ${res.status}`);
        return res.json() as Promise<AvailabilityResponse>;
      })
      .then((json) => {
        if (!cancelled && json) setLoadState({ requestKey, status: "ready", data: json });
      })
      .catch(() => {
        if (!cancelled) setLoadState({ requestKey, status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [manageToken, requestKey]);

  const currentLoad = loadState.requestKey === requestKey ? loadState : null;
  const data = currentLoad?.status === "ready" ? currentLoad.data : null;
  const failed = currentLoad?.status === "failed";
  const notFound = currentLoad?.status === "not-found";

  useEffect(() => {
    if (!data) return;
    const noticeMs = data.minNoticeMinutes * 60_000 + 60_000;
    let nextExpiryMs = Number.POSITIVE_INFINITY;
    for (const iso of data.slots) {
      const expiryMs = Date.parse(iso) - noticeMs;
      if (expiryMs > nowMs && expiryMs < nextExpiryMs) nextExpiryMs = expiryMs;
    }
    if (!Number.isFinite(nextExpiryMs)) return;
    const delayMs = Math.max(50, Math.min(nextExpiryMs - Date.now() + 50, 2_147_483_647));
    const timer = window.setTimeout(() => setNowMs(Date.now()), delayMs);
    return () => window.clearTimeout(timer);
  }, [data, nowMs]);

  const slotsByDay = useMemo(() => {
    const map = new Map<string, string[]>();
    if (!data) return map;
    // One minute of slack so a slot never renders moments before the server
    // would reject it anyway.
    const minStartMs = nowMs + data.minNoticeMinutes * 60_000 + 60_000;
    for (const iso of data.slots) {
      const ms = Date.parse(iso);
      if (ms < minStartMs) continue;
      const w = utcToWall(timezone, ms);
      const key = formatCivilDate(w.year, w.month, w.day);
      const list = map.get(key);
      if (list) list.push(iso);
      else map.set(key, [iso]);
    }
    return map;
  }, [data, timezone, nowMs]);

  const months = useMemo<MonthModel[]>(() => {
    const keys = [...slotsByDay.keys()].sort();
    if (keys.length === 0) return [];
    const first = parseCivilDate(keys[0]);
    const last = parseCivilDate(keys[keys.length - 1]);
    if (!first || !last) return [];
    const out: MonthModel[] = [];
    let y = first.year;
    let m = first.month;
    while (y < last.year || (y === last.year && m <= last.month)) {
      out.push(buildMonth(y, m, slotsByDay));
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }, [slotsByDay]);

  // Derived, not synced: timezone changes can shift a chosen instant onto a
  // different civil day. Keep stage 3 attached to that instant's new day;
  // an expired/removed choice becomes inactive and cannot be submitted.
  const selectedDay = useMemo(() => {
    if (!selectedSlot) return null;
    for (const [day, slots] of slotsByDay) {
      if (slots.includes(selectedSlot)) return day;
    }
    return null;
  }, [selectedSlot, slotsByDay]);
  // Fall back to the picked day whenever the chosen instant no longer resolves,
  // rather than only when nothing was chosen. The live min-notice clock retires
  // slots as their boundary passes, and a day's earliest slot is the one that
  // timer is armed for: keying this off `selectedSlot` meant that when it aged
  // out mid-form, `selectedDay` went null and the day went with it, collapsing
  // the picker to its opening state and losing the visitor's half-filled form
  // with no explanation. Their day survives now; only the retired time goes.
  const candidateDay = selectedDay ?? pickedDay;
  const activeDay =
    candidateDay && (slotsByDay.get(candidateDay)?.length ?? 0) > 0 ? candidateDay : null;
  const activeSlots = activeDay ? (slotsByDay.get(activeDay) ?? []) : [];
  const monthIndex = Math.max(
    0,
    months.findIndex((mm) => mm.key === (monthKey ?? activeDay?.slice(0, 7)))
  );
  const month = months[monthIndex] ?? null;

  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
      }),
    [timezone]
  );
  const longDayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    [timezone]
  );
  const shortDayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    [timezone]
  );

  if (notFound) {
    return (
      <div className="rounded-lg border border-hairline bg-paper-raise p-4 sm:p-5">
        <p className="text-sm text-ink-mute">This booking can no longer be rescheduled.</p>
      </div>
    );
  }

  if (!data && !failed) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mx-auto w-full max-w-[390px] rounded-lg border border-hairline bg-paper-raise p-5"
        aria-busy="true"
      >
        <span className="sr-only">Loading available times</span>
        <div className="mb-4 h-6 w-40 animate-pulse rounded-md bg-ink/5" />
        <div className="grid grid-cols-7 gap-1.5">
          {Array.from({ length: 42 }, (_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-lg bg-ink/5" />
          ))}
        </div>
      </div>
    );
  }

  if (failed || !data) {
    return (
      <div className="rounded-lg border border-hairline bg-paper-raise p-4 sm:p-5">
        <p className="text-sm text-ink-mute">Could not load available times.</p>
        <button
          type="button"
          onClick={() => setAttempt((a) => a + 1)}
          className={`mt-3 rounded-md border border-hairline px-3 py-1.5 text-sm font-medium text-ink transition-colors duration-150 hover:border-hairline-strong ${FOCUS_RING}`}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!month) {
    return (
      <div className="rounded-lg border border-hairline bg-paper-raise p-4 sm:p-5">
        <p className="text-sm text-ink-mute">No times available right now.</p>
      </div>
    );
  }

  // `selectedDay`, not `selectedSlot`: selectedDay is null once the chosen
  // instant is no longer among the live slots, which is what happens when the
  // min-notice clock retires it mid-form. Closing the form then drops the
  // visitor back to that day's remaining times rather than leaving a form open
  // on a time the server would refuse.
  const formOpen = selectedDay !== null && formSlot !== null && activeDay !== null;
  const expanded = activeDay !== null;
  const spring = reducedMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 300, damping: 30 };
  const fade = reducedMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" as const };

  const handleDayClick = (key: string) => {
    setPickedDay(key);
    // A new date invalidates a chosen time; stage 3 folds back to stage 2.
    if (selectedSlot) onClearSlot?.();
    window.requestAnimationFrame(() => focusWhenVisible("[data-meet-time]"));
  };

  /**
   * The ink fill behind the selected day/time is a shared layout element, so
   * changing the selection GLIDES the fill between cells. The prefix keeps
   * the mobile and desktop copies of the tree from cross-animating (both are
   * mounted; one is display:none).
   */
  const renderCalendar = (prefix: string) => (
    <div className="select-none">
      <div className="mb-3 flex items-center justify-between">
        <AnimatePresence mode="popLayout" initial={false} custom={navDir}>
          <motion.p
            key={month.key}
            initial={reducedMotion ? false : { opacity: 0, x: navDir * 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? undefined : { opacity: 0, x: navDir * -16 }}
            transition={fade}
            className="font-serif-display text-base font-bold text-ink"
          >
            {MONTH_FMT.format(month.labelMs)}
          </motion.p>
        </AnimatePresence>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            disabled={monthIndex === 0}
            onClick={() => {
              setNavDir(-1);
              setMonthKey(months[monthIndex - 1]?.key ?? month.key);
            }}
            className={`rounded-md p-1.5 text-ink-mute transition-colors duration-150 hover:text-ink disabled:opacity-30 disabled:hover:text-ink-mute ${FOCUS_RING}`}
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            aria-label="Next month"
            disabled={monthIndex >= months.length - 1}
            onClick={() => {
              setNavDir(1);
              setMonthKey(months[monthIndex + 1]?.key ?? month.key);
            }}
            className={`rounded-md p-1.5 text-ink-mute transition-colors duration-150 hover:text-ink disabled:opacity-30 disabled:hover:text-ink-mute ${FOCUS_RING}`}
          >
            <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAY_HEADER.map((w) => (
          <p
            key={w}
            className="pb-1 text-center text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint"
          >
            {w}
          </p>
        ))}
      </div>
      <AnimatePresence mode="popLayout" initial={false} custom={navDir}>
        <motion.div
          key={month.key}
          initial={reducedMotion ? false : { opacity: 0, x: navDir * 28 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reducedMotion ? undefined : { opacity: 0, x: navDir * -28 }}
          transition={fade}
          className="grid grid-cols-7 gap-1.5"
        >
          {month.weeks.flat().map((cell, i) => {
            const isActive = cell.key === activeDay;
            const bookable = cell.inMonth && cell.slotCount > 0;
            if (!cell.inMonth) {
              return <span key={cell.key} aria-hidden className="aspect-square" />;
            }
            return (
              <motion.button
                key={cell.key}
                type="button"
                disabled={!bookable}
                aria-pressed={isActive}
                aria-label={`${CALENDAR_DAY_FMT.format(
                  new Date(`${cell.key}T12:00:00Z`)
                )}, ${cell.slotCount} ${cell.slotCount === 1 ? "time" : "times"} available`}
                onClick={() => handleDayClick(cell.key)}
                initial={reducedMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { delay: Math.min(i * 0.006, 0.18), duration: 0.16 }
                }
                className={`relative flex aspect-square items-center justify-center rounded-lg text-sm transition-colors duration-150 ${FOCUS_RING} ${
                  isActive
                    ? "font-semibold text-paper"
                    : bookable
                      ? "font-medium text-ink hover:bg-ink/[0.06]"
                      : "cursor-default text-ink-faint"
                }`}
              >
                {isActive ? (
                  <motion.span
                    layoutId={`${prefix}-selected-day`}
                    transition={spring}
                    className="absolute inset-0 rounded-lg bg-ink"
                    aria-hidden
                  />
                ) : null}
                <span className="relative z-10">{cell.dayNum}</span>
                {bookable && !isActive ? (
                  <span
                    aria-hidden
                    className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent/70"
                  />
                ) : null}
              </motion.button>
            );
          })}
        </motion.div>
      </AnimatePresence>
    </div>
  );

  // Quiet text buttons, no per-chip borders: the whole grid reads as one
  // typographic block. Keyed by day so switching dates re-runs the stagger
  // inside a panel frame that never moves.
  const renderTimesWide = () => (
    <div key={`wide-${activeDay}`}>
      <p className="mb-3 hidden text-sm font-medium text-ink sm:block">
        {activeSlots.length > 0 ? longDayFmt.format(Date.parse(activeSlots[0])) : ""}
      </p>
      <div className="grid grid-cols-3 gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {activeSlots.map((iso, i) => (
          <motion.button
            key={iso}
            type="button"
            disabled={selecting}
            data-meet-time
            onClick={() => onSelect(iso, timezone, data.durationMinutes)}
            aria-label={`${longDayFmt.format(Date.parse(iso))} at ${timeFmt.format(Date.parse(iso))}`}
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={
              reducedMotion ? { duration: 0 } : { delay: Math.min(i * 0.012, 0.2), duration: 0.16 }
            }
            className={`min-h-11 rounded-md px-2 py-2.5 text-sm font-medium text-ink-soft transition-colors duration-150 hover:bg-ink/[0.06] hover:text-ink disabled:opacity-60 ${FOCUS_RING}`}
          >
            {timeFmt.format(Date.parse(iso))}
          </motion.button>
        ))}
      </div>
    </div>
  );

  /**
   * Bring the chosen time into view inside the slim column.
   *
   * The column is a fresh scroll container that mounts at scrollTop 0, so a
   * time picked further down the day would sit below the fold and the visitor
   * would see no selection at all next to a form claiming one.
   *
   * A callback ref rather than an effect, deliberately: it runs during commit,
   * BEFORE framer measures for the layoutId ink pill, so the pill animates to
   * the chip's final on-screen position instead of chasing a scroll applied
   * afterwards, and it fires per mounted copy, which matters because the mobile
   * and desktop trees are both mounted.
   */
  const revealChosenTime = (list: HTMLDivElement | null): void => {
    if (!list || !selectedSlot) return;
    const chosen = list.querySelector<HTMLElement>('[data-meet-time][aria-pressed="true"]');
    // Nothing to reveal yet. Return WITHOUT recording, so a later attach still
    // gets its chance; recording here would mark the selection handled and the
    // reveal would never happen.
    if (!chosen) return;

    // React detaches and re-attaches a callback ref on EVERY render, because
    // this function is a new identity each time. Without this guard the reveal
    // re-runs on renders the visitor never caused — typing one character into
    // the guest form yanked a column they had deliberately scrolled.
    if (revealedRef.current.get(list) === selectedSlot) return;
    revealedRef.current.set(list, selectedSlot);

    const c = chosen.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    // Already whole: leave the list exactly where it is. This also covers the
    // hidden responsive twin, whose rects are all zero.
    if (c.top >= l.top - 1 && c.bottom <= l.bottom + 1) return;
    // Centre using rect deltas, never offsetTop. offsetTop is measured from the
    // nearest POSITIONED ancestor, which is not this scroll container, so the
    // two live in different coordinate spaces; they agree only until framer
    // re-parents the panel during a month transition, at which point the same
    // expression points a row away.
    const delta = c.top - l.top;
    list.scrollTop = Math.max(0, list.scrollTop + delta - (l.height - c.height) / 2);
  };

  const renderTimesSlim = (prefix: string) => (
    <div key={`slim-${activeDay}`}>
      <p className="mb-3 text-sm font-medium text-ink">
        {activeDay ? shortDayFmt.format(Date.parse(activeSlots[0] ?? selectedSlot ?? "")) : ""}
      </p>
      <div
        ref={revealChosenTime}
        className="flex max-h-[420px] flex-col gap-0.5 overflow-y-auto pr-1"
      >
        {activeSlots.map((iso) => {
          const isChosen = iso === selectedSlot;
          return (
            <button
              key={iso}
              type="button"
              disabled={selecting}
              data-meet-time
              onClick={() => onSelect(iso, timezone, data.durationMinutes)}
              aria-pressed={isChosen}
              className={`relative shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 disabled:opacity-60 ${FOCUS_RING} ${
                isChosen ? "text-paper" : "text-ink-soft hover:bg-ink/[0.06] hover:text-ink"
              }`}
            >
              {isChosen ? (
                <motion.span
                  layoutId={`${prefix}-selected-time`}
                  transition={spring}
                  className="absolute inset-0 rounded-md bg-ink"
                  aria-hidden
                />
              ) : null}
              <span className="relative z-10">{timeFmt.format(Date.parse(iso))}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const summaryLabel =
    activeDay && activeSlots.length > 0
      ? longDayFmt.format(Date.parse(activeSlots[0]))
      : (activeDay ?? "");

  return (
    <div>
      {/* Phones: one stage on screen at a time, summary bars walk back. */}
      <div className="lg:hidden">
        <AnimatePresence mode="wait" initial={false}>
          {!expanded ? (
            <motion.div
              key="m-cal"
              initial={reducedMotion ? false : { opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reducedMotion ? undefined : { opacity: 0, x: -16 }}
              transition={fade}
              className="mx-auto w-full max-w-[390px] rounded-lg border border-hairline bg-paper-raise p-4"
            >
              {renderCalendar("m")}
            </motion.div>
          ) : !formOpen ? (
            <motion.div
              key={`m-times-${activeDay}`}
              initial={reducedMotion ? false : { opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reducedMotion ? undefined : { opacity: 0, x: -16 }}
              transition={fade}
            >
              <button
                type="button"
                onClick={() => setPickedDay(null)}
                className={`mb-3 inline-flex w-full items-center justify-between rounded-lg border border-hairline bg-paper-raise px-4 py-3 text-left transition-colors duration-150 hover:border-hairline-strong ${FOCUS_RING}`}
              >
                <span className="text-sm font-medium text-ink">{summaryLabel}</span>
                <span className="text-xs font-medium text-accent">Change date</span>
              </button>
              <div className="rounded-lg border border-hairline bg-paper-raise p-4">
                {renderTimesWide()}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="m-form"
              initial={reducedMotion ? false : { opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reducedMotion ? undefined : { opacity: 0, x: 16 }}
              transition={fade}
            >
              <button
                type="button"
                onClick={() => onClearSlot?.()}
                className={`mb-3 inline-flex w-full items-center justify-between rounded-lg border border-hairline bg-paper-raise px-4 py-3 text-left transition-colors duration-150 hover:border-hairline-strong ${FOCUS_RING}`}
              >
                <span className="text-sm font-medium text-ink">
                  {summaryLabel}, {selectedSlot ? timeFmt.format(Date.parse(selectedSlot)) : ""}
                </span>
                <span className="text-xs font-medium text-accent">Change time</span>
              </button>
              <div className="rounded-lg border border-hairline bg-paper-raise p-4">{formSlot}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Desktop uses real, stable column sizes. A transformed calendar used
          to participate in Framer's layout projection here; the 30-second
          live-clock update could leave that projection translated upward and
          pull this entire composition over the heading. The larger opening
          calendar is now an actual 390px box, so ordinary data refreshes
          cannot create a post-load layout shift. */}
      <div className="hidden lg:block">
        <div
          className={
            expanded
              ? formOpen
                ? "grid grid-cols-[320px_190px_minmax(0,1fr)] items-start gap-5"
                : "grid grid-cols-[320px_minmax(0,1fr)] items-start gap-5"
              : ""
          }
        >
          <motion.div
            initial={false}
            animate={{ opacity: 1 }}
            transition={fade}
            className={`rounded-lg border border-hairline bg-paper-raise p-5 ${
              expanded ? "w-[320px]" : "mx-auto mt-6 w-[390px]"
            }`}
          >
            {renderCalendar("d")}
          </motion.div>

          <AnimatePresence mode="popLayout" initial={false}>
            {expanded && !formOpen ? (
              <motion.div
                key="times-wide"
                initial={reducedMotion ? false : { opacity: 0, x: 28, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={reducedMotion ? undefined : { opacity: 0, transition: { duration: 0.12 } }}
                transition={spring}
                className="min-w-0 flex-1 rounded-lg border border-hairline bg-paper-raise p-5"
              >
                {renderTimesWide()}
              </motion.div>
            ) : null}
            {formOpen ? (
              <motion.div
                key="times-slim"
                initial={reducedMotion ? false : { opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reducedMotion ? undefined : { opacity: 0 }}
                transition={spring}
                className="w-[190px] rounded-lg border border-hairline bg-paper-raise p-5"
              >
                {renderTimesSlim("d")}
              </motion.div>
            ) : null}
            {formOpen ? (
              <motion.div
                key="form-panel"
                initial={reducedMotion ? false : { opacity: 0, x: 28, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={reducedMotion ? undefined : { opacity: 0 }}
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: "spring" as const, stiffness: 300, damping: 30, delay: 0.06 }
                }
                className="min-w-0 rounded-lg border border-hairline bg-paper-raise p-5"
              >
                {formSlot}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <div
        className={`${expanded ? "mt-4" : "mt-7"} ${
          formOpen ? "hidden lg:flex" : "flex"
        } justify-center`}
      >
        <TimezoneSelect value={timezone} onChange={handleTimezoneChange} />
      </div>
    </div>
  );
}

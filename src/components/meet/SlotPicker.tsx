"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
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

/** Matches --ease-out-expo in globals.css. */
const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

/* Hydration probe for useSyncExternalStore. Module-level so the identities are
   stable across renders; the value never changes after the first client
   render, so the store never needs to notify anyone. */
const subscribeNoop = () => () => {};
const snapshotClient = () => true;
const snapshotServer = () => false;

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
    // it put the caret on a node that framer unmounted half a second later,
    // dropping focus to <body> — and until then, Enter re-selected a time on
    // the day the visitor had just left.
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

declare global {
  interface Window {
    /**
     * Set by the inline prime script (AvailabilityPrime) so the availability
     * request can start during HTML parsing instead of after hydration.
     * Deleted by whichever SlotPicker consumes it, so it is used at most once.
     */
    __clusyMeetAvail?: { url: string; p: Promise<AvailabilityResponse> };
  }
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
  // Six rows, always. A month needs five or six depending on where its first
  // day falls, and that made the calendar card 348px or 398px: it resized when
  // the visitor paged months, and no loading state could match both heights
  // without knowing which month it was about to draw. The extra row is
  // out-of-month cells, which are already inert.
  for (let w = 0; w < 6; w++) {
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
  }
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
  /** Personal page slug: availability comes from that one person's calendar. */
  host?: string;
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
    host,
  } = props;

  const [attempt, setAttempt] = useState(0);
  // The host belongs in the key: it gates which in-flight response is allowed
  // into state, and without it the four pages are indistinguishable to the
  // load-state machine, so a slow team response could land on a personal page.
  const requestKey = `${host ?? "team"}:${manageToken ?? "public"}:${attempt}`;
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

  // Dates are the one timezone-dependent thing in this tree, and the server
  // resolves Intl to the SERVER's zone. So the server frame draws the calendar
  // chrome with no day numbers, the first client render matches it exactly, and
  // the numbers fade in immediately afterwards. Rendering them server-side
  // instead would be a hydration mismatch for anyone outside the server's zone,
  // which surfaces as a console error and fails the invariant suite.
  // useSyncExternalStore rather than an effect: it is the sanctioned way to
  // read "am I on the client yet" without a synchronous setState in an effect,
  // and React uses the server snapshot for the hydration render, which is
  // exactly the frame that has to match the server's date-free output.
  //
  // Doubles as the "is this the first commit" signal, which is why no ref is
  // needed: framer reads `initial` only when an element mounts, and the day
  // cells mount during hydration, when this is still false. Cells that mount
  // later (a month switch) see true and get their stagger.
  const hydrated = useSyncExternalStore(subscribeNoop, snapshotClient, snapshotServer);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams();
    if (manageToken) query.set("token", manageToken);
    if (host) query.set("host", host);
    const url = query.size > 0
      ? `/api/meet/availability?${query.toString()}`
      : "/api/meet/availability";
    // Adopt the request the inline prime script started during HTML parsing,
    // if it is for exactly this URL. Three guards, all load-bearing: the URL
    // must match byte for byte (a personal page must never adopt the team
    // page's response, which is the same bug class the requestKey guards
    // against); a manage token is never primed, since its response depends on
    // a bearer credential; and it is consumed exactly once, so a retry or a
    // host change always issues a genuinely fresh request rather than
    // replaying a stale body.
    const primed = typeof window === "undefined" ? undefined : window.__clusyMeetAvail;
    let inflight: Promise<Response | AvailabilityResponse>;
    if (primed && primed.url === url && !manageToken) {
      delete window.__clusyMeetAvail;
      inflight = primed.p;
    } else {
      // Without a timeout a hung request waits forever behind the loading
      // state with no way out; the catch below already routes to the retry
      // card.
      inflight = fetch(url, { signal: AbortSignal.timeout(15_000) });
    }

    inflight
      .then((res) => {
        // An adopted promise is already parsed JSON; a fresh one is a Response.
        if (!(res instanceof Response)) return res;
        if ((manageToken || host) && res.status === 404) {
          if (!cancelled) setLoadState({ requestKey, status: "not-found" });
          return null;
        }
        if (!res.ok) throw new Error(`availability ${res.status}`);
        return res.json() as Promise<AvailabilityResponse>;
      })
      .then((json) => {
        if (!cancelled && json) setLoadState({ requestKey, status: "ready", data: json });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // The prime script rejects with the numeric status rather than a
        // Response, so the not-found branch has to be recognised here too or a
        // page disabled between render and fetch would report a generic
        // failure and offer a "Try again" that can never succeed.
        if ((manageToken || host) && error === 404) {
          setLoadState({ requestKey, status: "not-found" });
          return;
        }
        setLoadState({ requestKey, status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [host, manageToken, requestKey]);

  const currentLoad = loadState.requestKey === requestKey ? loadState : null;
  const data = currentLoad?.status === "ready" ? currentLoad.data : null;
  const failed = currentLoad?.status === "failed";
  const notFound = currentLoad?.status === "not-found";
  /** Calendar is drawn, availability has not arrived. */
  const pending = !data && !failed && !notFound;

  // A wait long enough to need explaining. The reserved caption row exists
  // whether or not it has text, so this costs no reflow when it appears.
  //
  // Stores WHICH request went slow rather than a bare boolean, so the reset is
  // derived instead of being a second setState in the effect: pressing "Try
  // again" bumps `attempt`, which changes requestKey, which clears this.
  const [slowRequestKey, setSlowRequestKey] = useState<string | null>(null);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setSlowRequestKey(requestKey), 3000);
    return () => window.clearTimeout(timer);
  }, [pending, requestKey]);
  const slow = slowRequestKey === requestKey;

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
    if (keys.length === 0) {
      // Before availability lands, and when there is none at all, the visitor's
      // own clock already fixes which month belongs on screen, and six-row
      // months fix its box. Drawing it now is what lets the response arrive
      // without swapping one subtree for another.
      const w = utcToWall(timezone, nowMs);
      return [buildMonth(w.year, w.month, slotsByDay)];
    }
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
  }, [slotsByDay, timezone, nowMs]);

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
  // slots as their boundary passes, and the earliest slot of the day is the one
  // that timer is armed for: keying this off `selectedSlot` meant that when it
  // aged out mid-form, `selectedDay` went null, the day went with it, and the
  // whole picker collapsed to its opening state — losing the visitor's place
  // and their half-filled form with no explanation. Their day survives now;
  // only the retired time goes.
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

  // No loading branch: the calendar below renders from the first frame and
  // fills in. Replacing a skeleton subtree with the real one is what used to
  // move the card 19px (a missing weekday header), resize it 31px between five
  // and six row months, and shift every cell 8px on mobile (p-5 against p-4).
  if (failed) {
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

  // `months` always holds at least the visitor's current month now, so `month`
  // is never null; "no times available" became the caption line below, which
  // keeps the calendar on screen instead of replacing it with a sentence.
  if (!month) return <></>;

  // Only reachable from a rendered time chip, and there are no chips while
  // pending, so the fallback is never the value handed to onSelect.
  const durationMinutes = data?.durationMinutes ?? 0;

  /**
   * Reserved caption row: same height whether or not it has something to say.
   *
   * `reducedMotion` is gated on `hydrated` for the same reason the dates are.
   * framer's useReducedMotion() calls matchMedia in the RENDER BODY, so it is
   * already true on the client's very first render while the server, having no
   * matchMedia, resolved it to false. Reading it ungated here changed whether a
   * <p> existed at all, which is a node-shape mismatch: React 19 discards the
   * whole subtree and client-renders from the root, taking the layoutId pills
   * and the time column's scroll container with it.
   */
  const captionMotionCue = hydrated && reducedMotion;
  const caption = pending
    ? slow || captionMotionCue
      ? "Still checking calendars"
      : ""
    : slotsByDay.size === 0
      ? "No times available right now."
      : "";

  // `selectedDay`, not `selectedSlot`: selectedDay is null once the chosen
  // instant is no longer among the live slots, which is what happens when the
  // min-notice clock retires it mid-form. Closing the form then drops the
  // visitor back to that day's remaining times — their day and their place are
  // kept — instead of leaving a form open on a time the server would refuse.
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
            {/* Which month this is depends on the visitor's timezone, which the
                server cannot know, so it arrives with the dates. The nbsp holds
                the line's height so nothing shifts when it does. */}
            <span
              className={`inline-block transition-opacity duration-200 ease-out motion-reduce:transition-none ${
                hydrated ? "opacity-100" : "opacity-0"
              }`}
            >
              {hydrated ? MONTH_FMT.format(month.labelMs) : " "}
            </span>
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
            const bookable = hydrated && cell.inMonth && cell.slotCount > 0;
            // One diagonal wave from the top-left rather than 42 independent
            // events, so the calendar reads as a single thing filling in.
            //
            // Gated on `hydrated` as well, because this reaches the DOM as an
            // inline transition-delay: ungated it emitted 0.036s from the
            // server and 0s on a reduced-motion client, 42 times over.
            const wave =
              hydrated && !reducedMotion
                ? Math.min(((i % 7) + Math.floor(i / 7)) * 0.018, 0.22)
                : 0;
            // Out-of-month cells are disabled buttons, not spans: keeping the
            // element type of all 42 cells constant from the server frame
            // through data arrival is what guarantees no remount and no
            // reparent, which is the class of change that has broken the
            // scroll invariants in this file before.
            return (
              <motion.button
                key={cell.key}
                type="button"
                disabled={!bookable}
                // Both gated on `hydrated`: which cells are in-month is a
                // function of the visitor's timezone, so emitting either of
                // these server-side would be a hydration mismatch for anyone
                // outside the server's zone.
                aria-hidden={hydrated && !cell.inMonth ? true : undefined}
                aria-pressed={hydrated && cell.inMonth ? isActive : undefined}
                aria-label={
                  hydrated && cell.inMonth
                    ? `${CALENDAR_DAY_FMT.format(
                        new Date(`${cell.key}T12:00:00Z`)
                      )}, ${cell.slotCount} ${cell.slotCount === 1 ? "time" : "times"} available`
                    : undefined
                }
                onClick={() => handleDayClick(cell.key)}
                // No entrance on the first commit: these cells are already in
                // the server HTML, so fading them up from 0 would flash away
                // something the visitor can see.
                initial={reducedMotion || !hydrated ? false : { opacity: 0, y: 4 }}
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
                <span
                  className={`relative z-10 transition-opacity duration-200 ease-out motion-reduce:transition-none ${
                    hydrated ? "opacity-100" : "opacity-0"
                  }`}
                  style={{ transitionDelay: `${wave}s` }}
                >
                  {hydrated && cell.inMonth ? cell.dayNum : ""}
                </span>
                {bookable && !isActive ? (
                  <motion.span
                    aria-hidden
                    // x rides the transform framer writes; a Tailwind
                    // -translate-x-1/2 would be overwritten by the scale.
                    initial={reducedMotion ? false : { opacity: 0, scale: 0.4, x: "-50%" }}
                    animate={{ opacity: 1, scale: 1, x: "-50%" }}
                    transition={
                      reducedMotion
                        ? { duration: 0 }
                        : { duration: 0.28, ease: EASE_OUT_EXPO, delay: wave }
                    }
                    className="absolute bottom-1 left-1/2 h-1 w-1 rounded-full bg-accent/70"
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
  /**
   * The slim column is a fresh scroll container that mounts at scrollTop 0,
   * so a time picked further down the day (7:30pm out of an 08:30-22:00 list)
   * would sit below the fold and the visitor would see no selection at all
   * next to a form that claims one.
   *
   * A callback ref rather than an effect, for two reasons: it runs during
   * commit, BEFORE framer measures for the layoutId ink pill, so the pill
   * animates to the chip's final on-screen position instead of chasing a
   * scroll that happens afterwards; and it fires per mounted copy, which
   * matters because the mobile and desktop trees are both mounted.
   * Assigning scrollTop (not scrollIntoView) keeps the jump instant and
   * contained: scrollIntoView can scroll ancestors and move the whole page.
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
    // re-ran on renders the visitor never caused — typing one character into
    // the guest form yanked a column they had deliberately scrolled
    // (measured: 400 -> 0).
    if (revealedRef.current.get(list) === selectedSlot) return;
    revealedRef.current.set(list, selectedSlot);

    const c = chosen.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    // Already whole: leave the list exactly where it is. This also covers the
    // hidden responsive twin, whose rects are all zero.
    if (c.top >= l.top - 1 && c.bottom <= l.bottom + 1) return;
    // Centre using rect deltas, never offsetTop. offsetTop is measured from the
    // nearest POSITIONED ancestor, which is not this scroll container, so the
    // two live in different coordinate spaces; they agreed only until framer
    // re-parented the panel during the month transition.
    const delta = c.top - l.top;
    list.scrollTop = Math.max(0, list.scrollTop + delta - (l.height - c.height) / 2);
  };

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
            onClick={() => onSelect(iso, timezone, durationMinutes)}
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
              onClick={() => onSelect(iso, timezone, durationMinutes)}
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
      {/*
        One persistent live region. It used to live inside the skeleton, so it
        mounted and unmounted with it, which is the least reliable live-region
        pattern there is. A region that already exists announces reliably; its
        pending text is what the server renders, so hydration matches.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {pending
          ? "Loading available times"
          : slotsByDay.size === 0
            ? "No times available right now"
            : `${slotsByDay.size} ${slotsByDay.size === 1 ? "day" : "days"} with available times. Select a date.`}
      </p>

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
              aria-busy={pending || undefined}
              className={`mx-auto w-full max-w-[390px] rounded-lg border border-hairline bg-paper-raise p-4 ${
                pending ? "meet-loading" : ""
              }`}
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
            aria-busy={pending || undefined}
            className={`rounded-lg border border-hairline bg-paper-raise p-5 ${
              expanded ? "w-[320px]" : "mx-auto mt-6 w-[390px]"
            } ${pending ? "meet-loading" : ""}`}
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

      {/*
        Reserved caption row: 20px tall in the opening stage whether or not it
        has anything to say, so the ">3s" message and the "fully booked" line
        both cost zero reflow. The timezone row's top margin drops from mt-7 to
        mt-3 to pay for it, so the composition is about 16px taller, not 48px.
      */}
      {!expanded ? (
        <div className="mt-3 flex h-5 items-center justify-center">
          <AnimatePresence mode="wait" initial={false}>
            {caption ? (
              <motion.p
                key={caption}
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reducedMotion ? undefined : { opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.24, ease: "easeOut" }}
                className="text-xs text-ink-mute"
              >
                {caption}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}

      {/*
        h-6 is the trigger button's exact height (16px line box + py-1), so the
        row holds its space from the server frame onward. The select itself
        only mounts once hydrated, because its label is the resolved timezone
        name and the server resolves that to the SERVER's zone.
      */}
      <div
        className={`${expanded ? "mt-4" : "mt-3"} ${
          formOpen ? "hidden lg:flex" : "flex"
        } h-6 justify-center`}
      >
        {hydrated ? <TimezoneSelect value={timezone} onChange={handleTimezoneChange} /> : null}
      </div>
    </div>
  );
}

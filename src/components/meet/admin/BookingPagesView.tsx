"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  ArchiveRestore,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Eye,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  Mail,
  MessageSquareText,
  RotateCcw,
  Save,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  UserPlus,
  UserRound,
  X,
} from "lucide-react";
import type { PersonalPage, PersonalPagesResponse } from "./types";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
const FIELD = `${FOCUS_RING} w-full rounded-lg border border-hairline bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint transition-colors hover:border-hairline-strong`;
const SECONDARY_BUTTON = `${FOCUS_RING} inline-flex items-center justify-center gap-2 rounded-lg border border-hairline bg-paper px-3 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50`;
const PRIMARY_BUTTON = `${FOCUS_RING} inline-flex items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45`;

const TIMEZONE_LIST_ID = "meet-admin-timezones";
const FALLBACK_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Istanbul",
  "Africa/Cairo",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function supportedTimezones(): string[] {
  const values =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : FALLBACK_TIMEZONES;
  return [...new Set(["UTC", ...values])];
}

function useMinuteClock(): void {
  const [, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = window.setInterval(
      () => setMinute(Math.floor(Date.now() / 60_000)),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, []);
}

const WEEKDAYS = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 7, short: "Sun", long: "Sunday" },
] as const;

interface PageDraft {
  /** Editable identity; the URL key remains immutable. */
  memberName: string;
  memberEmail: string;
  /** Text appended after the fixed public prefix “Book a call with”. */
  headline: string;
  blurb: string;
  /** Permanent/target zone; blank inherits the team zone. */
  timezone: string;
  /** Optional current zone used until moveDate. Both move fields live together. */
  moveFromTimezone: string;
  moveDate: string;
  durationMinutes: string;
  slotStepMinutes: string;
  windowStart: string;
  windowEnd: string;
  minNoticeMinutes: string;
  horizonDays: string;
  bookableWeekdays: number[] | null;
  eventTitle: string;
  eventDescription: string;
  /** Empty means “leave the existing secret alone.” */
  slackWebhookUrl: string;
}

interface DraftPreview {
  headline: string;
  blurb: string;
  timezone: string;
  timezoneToday: string;
  timezoneUntil: { beforeDate: string; timezone: string } | null;
  durationMinutes: number;
  slotStepMinutes: number;
  windowStart: string;
  windowEnd: string;
  minNoticeMinutes: number;
  horizonDays: number;
  bookableWeekdays: number[];
  eventTitle: string;
  eventDescription: string;
}

type Notice = { tone: "success" | "error"; text: string };

interface AddMemberDraft {
  name: string;
  email: string;
  key: string;
  timezone: string;
}

function slugForName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

function draftFor(page: PersonalPage): PageDraft {
  return {
    memberName: page.memberName,
    memberEmail: page.memberEmail,
    // Older rows stored the member name as a headline sentinel. Treat that as
    // inherited so opening the editor never turns legacy data into a custom
    // suffix.
    headline: page.headline === page.memberName ? "" : (page.headline ?? ""),
    blurb: page.blurb ?? "",
    timezone: page.overrides.timezone ?? "",
    moveFromTimezone: page.overrides.timezoneUntil?.timezone ?? "",
    moveDate: page.overrides.timezoneUntil?.beforeDate ?? "",
    durationMinutes:
      page.overrides.durationMinutes === null
        ? ""
        : String(page.overrides.durationMinutes),
    slotStepMinutes:
      page.overrides.slotStepMinutes === null
        ? ""
        : String(page.overrides.slotStepMinutes),
    windowStart:
      page.overrides.windowStartMin === null ? "" : page.effective.windowStart,
    windowEnd:
      page.overrides.windowEndMin === null ? "" : page.effective.windowEnd,
    minNoticeMinutes:
      page.overrides.minNoticeMinutes === null
        ? ""
        : String(page.overrides.minNoticeMinutes),
    horizonDays:
      page.overrides.horizonDays === null
        ? ""
        : String(page.overrides.horizonDays),
    bookableWeekdays: page.overrides.bookableWeekdays
      ? [...page.overrides.bookableWeekdays].sort((a, b) => a - b)
      : null,
    eventTitle: page.overrides.eventTitle ?? "",
    eventDescription: page.overrides.eventDescription ?? "",
    slackWebhookUrl: "",
  };
}

function draftsMatch(left: PageDraft, right: PageDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function urlPath(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
}

function integerOrDefault(value: string, fallback: number): number {
  if (!value.trim()) return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function timezoneIsValid(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function formatLocalTime(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return "—";
  }
}

function weekdaySummary(days: number[]): string {
  if (days.length === 7) return "Every day";
  if (
    days.length === 5 &&
    [1, 2, 3, 4, 5].every((weekday) => days.includes(weekday))
  ) {
    return "Monday–Friday";
  }
  return WEEKDAYS.filter((weekday) => days.includes(weekday.value))
    .map((weekday) => weekday.short)
    .join(", ");
}

function civilDateIsValid(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function civilToday(timezone: string): string | null {
  if (!timezoneIsValid(timezone)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function previewFor(
  draft: PageDraft,
  page: PersonalPage,
  defaults: PersonalPagesResponse["defaults"],
): DraftPreview {
  const timezone = draft.timezone.trim() || defaults.timezone;
  const hasCompleteMove =
    Boolean(draft.moveDate.trim()) && Boolean(draft.moveFromTimezone.trim());
  const timezoneUntil = hasCompleteMove
    ? {
        beforeDate: draft.moveDate.trim(),
        timezone: draft.moveFromTimezone.trim(),
      }
    : defaults.timezoneUntil;
  const today = civilToday(timezone);
  const timezoneToday =
    timezoneUntil && today && today < timezoneUntil.beforeDate
      ? timezoneUntil.timezone
      : timezoneIsValid(timezone)
        ? timezone
        : defaults.timezoneToday;
  return {
    headline: `Book a call with ${draft.headline.trim() || draft.memberName.trim() || page.memberName}`,
    blurb: draft.blurb.trim(),
    timezone,
    timezoneToday,
    timezoneUntil,
    durationMinutes: integerOrDefault(
      draft.durationMinutes,
      defaults.durationMinutes,
    ),
    slotStepMinutes: integerOrDefault(
      draft.slotStepMinutes,
      defaults.slotStepMinutes,
    ),
    windowStart: draft.windowStart.trim() || defaults.windowStart,
    windowEnd: draft.windowEnd.trim() || defaults.windowEnd,
    minNoticeMinutes: integerOrDefault(
      draft.minNoticeMinutes,
      defaults.minNoticeMinutes,
    ),
    horizonDays: integerOrDefault(draft.horizonDays, defaults.horizonDays),
    bookableWeekdays: draft.bookableWeekdays ?? defaults.bookableWeekdays,
    eventTitle: draft.eventTitle.trim() || defaults.eventTitle,
    eventDescription:
      draft.eventDescription.trim() || defaults.eventDescription,
  };
}

function clockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0))
    return null;
  return hours * 60 + minutes;
}

function slackWebhookIsValid(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "hooks.slack.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    /^\/services\/[A-Za-z0-9_-]{8,128}\/[A-Za-z0-9_-]{8,128}\/[A-Za-z0-9_-]{8,192}$/.test(
      url.pathname,
    )
  );
}

function validateDraft(
  draft: PageDraft,
  defaults: PersonalPagesResponse["defaults"],
): string[] {
  const errors: string[] = [];
  const memberName = draft.memberName.trim();
  const memberEmail = draft.memberEmail.trim();
  const headline = draft.headline.trim();
  const blurb = draft.blurb.trim();
  const eventTitle = draft.eventTitle.trim();
  const eventDescription = draft.eventDescription.trim();

  if (!memberName || memberName.length > 80) {
    errors.push("Member name must be between 1 and 80 characters.");
  }
  if (
    memberEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(memberEmail)
  ) {
    errors.push("Member email must be a valid email address.");
  }

  if (headline.length > 80)
    errors.push("Headline must be 80 characters or fewer.");
  if (blurb.length > 200)
    errors.push("Subheading must be 200 characters or fewer.");
  if (eventTitle.length > 200)
    errors.push("Event title must be 200 characters or fewer.");
  if (eventDescription.length > 2000) {
    errors.push("Event description must be 2,000 characters or fewer.");
  }

  const timezone = draft.timezone.trim();
  if (timezone && !timezoneIsValid(timezone)) {
    errors.push(
      "Host timezone must be a valid IANA timezone, such as Europe/London.",
    );
  }
  const moveFromTimezone = draft.moveFromTimezone.trim();
  const moveDate = draft.moveDate.trim();
  if (Boolean(moveFromTimezone) !== Boolean(moveDate)) {
    errors.push(
      "A scheduled timezone change needs both the current timezone and the change date.",
    );
  } else if (moveFromTimezone && !timezoneIsValid(moveFromTimezone)) {
    errors.push(
      "The current timezone for a scheduled change must be a valid IANA timezone.",
    );
  } else if (moveDate && !civilDateIsValid(moveDate)) {
    errors.push(
      "Timezone change date must be a real date in YYYY-MM-DD format.",
    );
  }

  const readInteger = (
    value: string,
    fallback: number,
    label: string,
    min: number,
    max: number,
  ): number => {
    if (!value.trim()) return fallback;
    if (!/^\d+$/.test(value.trim())) {
      errors.push(`${label} must be a whole number.`);
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      errors.push(
        `${label} must be between ${min.toLocaleString()} and ${max.toLocaleString()}.`,
      );
      return fallback;
    }
    return parsed;
  };

  const duration = readInteger(
    draft.durationMinutes,
    defaults.durationMinutes,
    "Meeting length",
    5,
    480,
  );
  const cadence = readInteger(
    draft.slotStepMinutes,
    defaults.slotStepMinutes,
    "Slot cadence",
    5,
    480,
  );
  readInteger(
    draft.minNoticeMinutes,
    defaults.minNoticeMinutes,
    "Minimum notice",
    0,
    43_200,
  );
  readInteger(
    draft.horizonDays,
    defaults.horizonDays,
    "Booking horizon",
    0,
    366,
  );

  if (cadence < duration) {
    errors.push("Slot cadence cannot be shorter than the meeting length.");
  }

  const startText = draft.windowStart.trim() || defaults.windowStart;
  const endText = draft.windowEnd.trim() || defaults.windowEnd;
  const start = clockMinutes(startText);
  const end = clockMinutes(endText);
  if (start === null || end === null) {
    errors.push("Booking hours must use a valid HH:MM time.");
  } else if (start >= end) {
    errors.push("Opening time must be before closing time.");
  } else if (duration > end - start) {
    errors.push("Meeting length must fit inside the booking hours.");
  }

  if (draft.bookableWeekdays && draft.bookableWeekdays.length === 0) {
    errors.push("Choose at least one bookable weekday.");
  }
  if (
    draft.slackWebhookUrl.trim() &&
    !slackWebhookIsValid(draft.slackWebhookUrl.trim())
  ) {
    errors.push(
      "Slack webhook must be a hooks.slack.com incoming-webhook URL.",
    );
  }
  return [...new Set(errors)];
}

function integerPatch(value: string): number | null {
  return value.trim() ? Number(value.trim()) : null;
}

async function responseMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const data: unknown = await response.json().catch(() => null);
  if (
    data &&
    typeof data === "object" &&
    "message" in data &&
    typeof (data as { message?: unknown }).message === "string"
  ) {
    return (data as { message: string }).message;
  }
  return fallback;
}

export function BookingPagesView({
  onUnauthorized,
  onRosterChange,
}: {
  onUnauthorized: () => void;
  onRosterChange: () => void;
}) {
  useMinuteClock();
  const unauthorizedRef = useRef(onUnauthorized);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [data, setData] = useState<PersonalPagesResponse | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorMutationPending, setEditorMutationPending] = useState(false);
  const [livePendingKey, setLivePendingKey] = useState<string | null>(null);
  const [pageErrors, setPageErrors] = useState<Record<string, string>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
  const [rosterNotice, setRosterNotice] = useState<Notice | null>(null);
  const editorAnchorRef = useRef<HTMLDivElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    unauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  const readPages =
    useCallback(async (): Promise<PersonalPagesResponse | null> => {
      const response = await fetch("/api/meet/admin/pages", {
        cache: "no-store",
      });
      if (response.status === 401) {
        unauthorizedRef.current();
        return null;
      }
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "Could not load booking pages."),
        );
      }
      return (await response.json()) as PersonalPagesResponse;
    }, []);

  const installData = useCallback((next: PersonalPagesResponse) => {
    setData(next);
    setSelectedKey((current) =>
      current && next.pages.some((page) => page.memberKey === current)
        ? current
        : (next.pages[0]?.memberKey ?? null),
    );
    setPhase("ready");
  }, []);

  const loadInitial = useCallback(async () => {
    setPhase("loading");
    try {
      const next = await readPages();
      if (next) installData(next);
    } catch {
      setPhase("failed");
    }
  }, [installData, readPages]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (!editorDirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [editorDirty]);

  const refetchPage = useCallback(
    async (memberKey: string): Promise<PersonalPage | null> => {
      const next = await readPages();
      if (!next) return null;
      installData(next);
      return next.pages.find((page) => page.memberKey === memberKey) ?? null;
    },
    [installData, readPages],
  );

  const patchPageLocally = useCallback(
    (memberKey: string, patch: Partial<PersonalPage>) => {
      setData((current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) =>
                page.memberKey === memberKey ? { ...page, ...patch } : page,
              ),
            }
          : current,
      );
    },
    [],
  );

  const toggleLive = useCallback(
    async (page: PersonalPage, enabled: boolean) => {
      if (livePendingKey || editorMutationPending) return;
      setLivePendingKey(page.memberKey);
      setPageErrors((current) => {
        const next = { ...current };
        delete next[page.memberKey];
        return next;
      });
      try {
        const response = await fetch(
          `/api/meet/admin/pages/${encodeURIComponent(page.memberKey)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            // This request is deliberately isolated from the editor draft.
            body: JSON.stringify({ enabled }),
          },
        );
        if (response.status === 401) {
          unauthorizedRef.current();
          return;
        }
        if (!response.ok) {
          throw new Error(
            await responseMessage(
              response,
              "Could not update the live status.",
            ),
          );
        }
        patchPageLocally(page.memberKey, { enabled });
      } catch (error) {
        setPageErrors((current) => ({
          ...current,
          [page.memberKey]:
            error instanceof Error
              ? error.message
              : "Could not update the live status.",
        }));
      } finally {
        setLivePendingKey(null);
      }
    },
    [editorMutationPending, livePendingKey, patchPageLocally],
  );

  const selectPage = (memberKey: string) => {
    if (editorMutationPending || livePendingKey) return;
    const revealEditor = () => {
      if (!window.matchMedia("(max-width: 1023px)").matches) return;
      window.requestAnimationFrame(() => {
        const reducedMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        editorAnchorRef.current?.scrollIntoView({
          block: "start",
          behavior: reducedMotion ? "auto" : "smooth",
        });
      });
    };
    if (memberKey === selectedKey) {
      revealEditor();
      return;
    }
    if (
      editorDirty &&
      !window.confirm(
        "Discard the unsaved changes and customize another booking page?",
      )
    ) {
      return;
    }
    setEditorDirty(false);
    setSelectedKey(memberKey);
    revealEditor();
  };

  const copyPageLink = async (page: PersonalPage) => {
    try {
      await navigator.clipboard.writeText(page.url);
      setCopiedKey(page.memberKey);
      window.setTimeout(() => {
        setCopiedKey((current) =>
          current === page.memberKey ? null : current,
        );
      }, 1600);
    } catch {
      setPageErrors((current) => ({
        ...current,
        [page.memberKey]:
          "Could not copy the link. Open the page and copy it from your browser.",
      }));
    }
  };

  const refreshRoster = useCallback(
    async (selectedMemberKey?: string) => {
      const next = await readPages();
      if (!next) return;
      installData(next);
      if (
        selectedMemberKey &&
        next.pages.some((page) => page.memberKey === selectedMemberKey)
      ) {
        setSelectedKey(selectedMemberKey);
      }
      onRosterChange();
    },
    [installData, onRosterChange, readPages],
  );

  const archiveMember = useCallback(
    async (page: PersonalPage) => {
      const response = await fetch(
        `/api/meet/admin/members/${encodeURIComponent(page.memberKey)}`,
        { method: "DELETE" },
      );
      if (response.status === 401) {
        unauthorizedRef.current();
        throw new Error("Your admin session expired.");
      }
      if (!response.ok) {
        const message = await responseMessage(
          response,
          `Could not remove ${page.memberName}.`,
        );
        // A 409 can be the result of a concurrent roster/booking change and
        // the server may have compensated a staged archive. Re-read before
        // surfacing the error so the editor never keeps a stale member state.
        // Preserve the archive error if that defensive refresh also fails.
        try {
          await refreshRoster(page.memberKey);
        } catch {
          // A later manual refresh can retry.
        }
        throw new Error(message);
      }
      await refreshRoster();
      setRosterNotice({
        tone: "success",
        text: `${page.memberName} was removed from new bookings. Their history and settings are still safe.`,
      });
    },
    [refreshRoster],
  );

  const restoreMember = useCallback(
    async (member: { key: string; name: string }) => {
      if (restoringKey) return;
      setRestoringKey(member.key);
      setRosterNotice(null);
      try {
        const response = await fetch(
          `/api/meet/admin/members/${encodeURIComponent(member.key)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: false }),
          },
        );
        if (response.status === 401) {
          unauthorizedRef.current();
          return;
        }
        if (!response.ok) {
          throw new Error(
            await responseMessage(
              response,
              `Could not restore ${member.name}.`,
            ),
          );
        }
        await refreshRoster(member.key);
        setRosterNotice({
          tone: "success",
          text: `${member.name} is back. Check calendar readiness, review their rules, then publish their personal page when ready.`,
        });
      } catch (error) {
        setRosterNotice({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : `Could not restore ${member.name}.`,
        });
      } finally {
        setRestoringKey(null);
      }
    },
    [refreshRoster, restoringKey],
  );

  const closeAddSheet = useCallback(() => {
    setAddOpen(false);
    window.requestAnimationFrame(() => addTriggerRef.current?.focus());
  }, []);

  if (phase === "loading") {
    return (
      <div className="flex min-h-[28rem] items-center justify-center rounded-2xl border border-hairline bg-paper-raise">
        <div className="text-center" role="status">
          <LoaderCircle
            className="mx-auto h-5 w-5 motion-safe:animate-spin text-ink-mute"
            strokeWidth={1.6}
          />
          <p className="mt-3 text-sm text-ink-mute">Loading booking pages…</p>
        </div>
      </div>
    );
  }

  if (phase === "failed" || !data) {
    return (
      <div className="flex min-h-[28rem] items-center justify-center rounded-2xl border border-hairline bg-paper-raise px-6">
        <div className="max-w-sm text-center">
          <CircleAlert
            className="mx-auto h-6 w-6 text-status-warn"
            strokeWidth={1.5}
          />
          <h2 className="mt-4 text-base font-semibold text-ink">
            Booking pages are unavailable
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-ink-mute">
            We could not load the page settings. Your existing pages are
            unaffected.
          </p>
          <button
            type="button"
            className={`${SECONDARY_BUTTON} mt-5`}
            onClick={() => void loadInitial()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (data.pages.length === 0) {
    return (
      <section aria-labelledby="empty-members-heading">
        <datalist id={TIMEZONE_LIST_ID}>
          {supportedTimezones().map((timezone) => (
            <option key={timezone} value={timezone} />
          ))}
        </datalist>
        {addOpen && (
          <AddMemberSheet
            defaultTimezone={data.defaults.timezone}
            onCancel={closeAddSheet}
            onUnauthorized={() => unauthorizedRef.current()}
            onAdded={async (member) => {
              setAddOpen(false);
              await refreshRoster(member.key);
            }}
          />
        )}
        <div className="flex min-h-[28rem] items-center justify-center rounded-2xl border border-dashed border-hairline-strong bg-paper-raise px-6">
          <div className="max-w-md text-center">
            <UserRound
              className="mx-auto h-7 w-7 text-ink-faint"
              strokeWidth={1.4}
            />
            <h2
              id="empty-members-heading"
              className="mt-4 font-serif-display text-2xl text-ink"
            >
              Build your Meet team
            </h2>
            <p className="mt-2 text-sm leading-6 text-ink-mute">
              Add the first member with their own timezone and booking rules, or
              restore someone previously removed.
            </p>
            <button
              ref={addTriggerRef}
              type="button"
              className={`${PRIMARY_BUTTON} mt-5`}
              onClick={() => setAddOpen(true)}
            >
              <UserPlus className="h-4 w-4" aria-hidden />
              Add first member
            </button>
            {(data.archivedMembers ?? []).length > 0 && (
              <div className="mt-7 border-t border-hairline pt-5 text-left">
                <p className="text-xs font-semibold text-ink">
                  Previously removed
                </p>
                <div className="mt-2 space-y-1">
                  {(data.archivedMembers ?? []).map((member) => (
                    <div
                      key={member.key}
                      className="flex items-center justify-between gap-3 py-2 text-xs"
                    >
                      <span className="truncate text-ink-mute">
                        {member.name}
                      </span>
                      <button
                        type="button"
                        disabled={restoringKey !== null}
                        onClick={() => void restoreMember(member)}
                        className={`${SECONDARY_BUTTON} !min-h-9 !px-2 !py-1 text-[11px]`}
                      >
                        {restoringKey === member.key ? (
                          <LoaderCircle className="h-3.5 w-3.5 motion-safe:animate-spin" />
                        ) : (
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        )}
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    );
  }

  const selectedPage =
    data.pages.find((page) => page.memberKey === selectedKey) ?? data.pages[0];
  const liveCount = data.pages.filter((page) => page.enabled).length;
  const attentionCount = data.pages.filter(
    (page) => !page.calendarReady,
  ).length;

  return (
    <section aria-labelledby="booking-pages-heading">
      <datalist id={TIMEZONE_LIST_ID}>
        {supportedTimezones().map((timezone) => (
          <option key={timezone} value={timezone} />
        ))}
      </datalist>
      {addOpen && (
        <AddMemberSheet
          defaultTimezone={data.defaults.timezone}
          onCancel={closeAddSheet}
          onUnauthorized={() => unauthorizedRef.current()}
          onAdded={async (member) => {
            setAddOpen(false);
            await refreshRoster(member.key);
            setRosterNotice({
              tone: "success",
              text: `${member.name} was added. Their personal page starts paused; connect a calendar so they can join team availability, review the rules, then publish the page.`,
            });
          }}
        />
      )}
      <div className="flex flex-col gap-5 border-b border-hairline pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2
            id="booking-pages-heading"
            className="font-serif-display text-4xl font-bold tracking-[-0.045em] text-ink sm:text-5xl"
          >
            Members
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-ink-mute">
            One place for every host’s timezone, working pattern, booking rules,
            page and notifications.
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          <button
            ref={addTriggerRef}
            type="button"
            className={PRIMARY_BUTTON}
            onClick={() => {
              setRosterNotice(null);
              setAddOpen(true);
            }}
          >
            <UserPlus className="h-4 w-4" aria-hidden />
            Add member
          </button>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-mute">
            <span>{data.pages.length} active</span>
            <span aria-hidden className="text-hairline-strong">
              /
            </span>
            <span>{liveCount} personal pages live</span>
            <span aria-hidden className="text-hairline-strong">
              /
            </span>
            <span
              className={attentionCount > 0 ? "text-status-warn" : undefined}
            >
              {attentionCount > 0
                ? `${attentionCount} needs a calendar`
                : "All calendars ready"}
            </span>
          </div>
        </div>
      </div>

      {rosterNotice && (
        <div
          className={`mt-5 flex items-start gap-2.5 border-l-2 px-4 py-3 text-sm ${
            rosterNotice.tone === "success"
              ? "border-status-ok bg-status-ok/[0.04] text-ink-soft"
              : "border-status-warn bg-status-warn/[0.05] text-ink-soft"
          }`}
          role={rosterNotice.tone === "success" ? "status" : "alert"}
        >
          {rosterNotice.tone === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-ok" />
          ) : (
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
          )}
          <p className="leading-6">{rosterNotice.text}</p>
        </div>
      )}

      <div className="mt-8 grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(13rem,0.52fr)_minmax(0,2.5fr)] lg:gap-8">
        <aside
          className="min-w-0 border-y border-hairline lg:sticky lg:top-32"
          aria-label="Members"
        >
          <div className="flex items-center justify-between border-b border-hairline py-3">
            <div>
              <p className="text-sm font-semibold text-ink">Active members</p>
              <p className="mt-0.5 text-xs text-ink-faint">Select a person</p>
            </div>
            <span className="font-mono text-[11px] text-ink-faint">
              {data.pages.length}
            </span>
          </div>
          <div className="flex snap-x overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:block">
            {data.pages.map((page) => (
              <PageListCard
                key={page.memberKey}
                page={page}
                selected={page.memberKey === selectedPage.memberKey}
                selectionDisabled={
                  editorMutationPending || livePendingKey !== null
                }
                error={pageErrors[page.memberKey]}
                copied={copiedKey === page.memberKey}
                onSelect={() => selectPage(page.memberKey)}
                onCopy={() => void copyPageLink(page)}
              />
            ))}
          </div>
          {(data.archivedMembers ?? []).length > 0 && (
            <div className="border-t border-hairline py-3">
              <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Removed
              </p>
              <div className="mt-2 space-y-1">
                {(data.archivedMembers ?? []).map((member) => (
                  <div
                    key={member.key}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink-mute">
                        {member.name}
                      </p>
                      <p className="truncate text-[11px] text-ink-faint">
                        /{member.key}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={restoringKey !== null}
                      onClick={() => void restoreMember(member)}
                      className={`${FOCUS_RING} inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-ink-mute hover:bg-paper-raise hover:text-ink disabled:opacity-50`}
                    >
                      {restoringKey === member.key ? (
                        <LoaderCircle className="h-3.5 w-3.5 motion-safe:animate-spin" />
                      ) : (
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      )}
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        <div ref={editorAnchorRef} className="min-w-0 scroll-mt-32">
          <BookingPageEditor
            key={selectedPage.memberKey}
            page={selectedPage}
            defaults={selectedPage.inherited}
            livePending={livePendingKey !== null}
            liveError={pageErrors[selectedPage.memberKey]}
            onToggleLive={(enabled) => void toggleLive(selectedPage, enabled)}
            onDirtyChange={setEditorDirty}
            onPendingChange={setEditorMutationPending}
            onUnauthorized={() => unauthorizedRef.current()}
            onRefetch={refetchPage}
            onPagePatch={patchPageLocally}
            onArchive={archiveMember}
            onRosterChange={onRosterChange}
          />
        </div>
      </div>
    </section>
  );
}

function AddMemberSheet({
  defaultTimezone,
  onCancel,
  onUnauthorized,
  onAdded,
}: {
  defaultTimezone: string;
  onCancel: () => void;
  onUnauthorized: () => void;
  onAdded: (member: {
    key: string;
    name: string;
    email: string;
  }) => Promise<void>;
}) {
  const browserTimezone = useMemo(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return detected && timezoneIsValid(detected) ? detected : defaultTimezone;
  }, [defaultTimezone]);
  const [draft, setDraft] = useState<AddMemberDraft>({
    name: "",
    email: "",
    key: "",
    timezone: browserTimezone,
  });
  const [keyEdited, setKeyEdited] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<
    "name" | "email" | "key" | "timezone" | null
  >(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const timezoneRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    nameRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) onCancel();
      if (event.key !== "Tab") return;
      const controls = panelRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      );
      if (!controls || controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel]);

  const updateName = (name: string) => {
    setError(null);
    setErrorField(null);
    setDraft((current) => ({
      ...current,
      name,
      key: keyEdited ? current.key : slugForName(name),
    }));
  };

  const showFieldError = (
    field: "name" | "email" | "key" | "timezone",
    message: string,
  ) => {
    setError(message);
    setErrorField(field);
    const refs = {
      name: nameRef,
      email: emailRef,
      key: keyRef,
      timezone: timezoneRef,
    };
    window.requestAnimationFrame(() => refs[field].current?.focus());
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const name = draft.name.trim();
    const email = draft.email.trim().toLowerCase();
    const key = draft.key.trim().toLowerCase();
    const timezone = draft.timezone.trim();
    if (!name) {
      showFieldError("name", "Enter the member’s name.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showFieldError("email", "Enter a valid notification email.");
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || key.length > 48) {
      showFieldError(
        "key",
        "The booking URL can use lowercase letters, numbers and single hyphens.",
      );
      return;
    }
    if (key === "admin" || key === "manage") {
      showFieldError(
        "key",
        `“${key}” is reserved. Choose a different booking URL.`,
      );
      return;
    }
    if (!timezoneIsValid(timezone)) {
      showFieldError(
        "timezone",
        "Choose a valid IANA timezone, such as Europe/London.",
      );
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/meet/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, name, email, timezone }),
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "Could not add this member."),
        );
      }
      const payload = (await response.json()) as {
        member?: { key: string; name: string; email: string };
      };
      await onAdded(payload.member ?? { key, name, email });
    } catch (reason) {
      setErrorField(null);
      setError(
        reason instanceof Error ? reason.message : "Could not add this member.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex justify-end bg-ink/25 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-member-title"
        aria-describedby="add-member-intro"
        className="flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-hairline bg-paper shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-hairline bg-paper/95 px-5 py-5 backdrop-blur sm:px-7">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              New host
            </p>
            <h3
              id="add-member-title"
              className="mt-1 font-serif-display text-3xl font-bold tracking-[-0.035em] text-ink"
            >
              Add a member
            </h3>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            className={`${FOCUS_RING} flex h-11 w-11 items-center justify-center rounded-full text-ink-mute hover:bg-paper-raise hover:text-ink disabled:opacity-50`}
            aria-label="Close add member"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex flex-1 flex-col"
        >
          <div className="flex-1 px-5 py-7 sm:px-7">
            <p
              id="add-member-intro"
              className="max-w-md text-sm leading-6 text-ink-mute"
            >
              Create their place in Meet now. The personal page starts paused,
              so you can connect a calendar and review every rule before it goes
              live.
            </p>

            <div className="mt-8 space-y-6">
              <label className="block" htmlFor="new-member-name">
                <FieldHeader
                  label="Name"
                  custom={Boolean(draft.name.trim())}
                  detail="Required"
                />
                <input
                  ref={nameRef}
                  id="new-member-name"
                  className={FIELD}
                  value={draft.name}
                  required
                  maxLength={80}
                  autoComplete="name"
                  placeholder="Ada Lovelace"
                  aria-invalid={errorField === "name"}
                  aria-describedby={
                    errorField === "name" ? "add-member-error" : undefined
                  }
                  onChange={(event) => updateName(event.target.value)}
                />
              </label>

              <label className="block" htmlFor="new-member-email">
                <FieldHeader
                  label="Notification email"
                  custom={Boolean(draft.email.trim())}
                  detail="Required"
                />
                <input
                  ref={emailRef}
                  id="new-member-email"
                  type="email"
                  className={FIELD}
                  value={draft.email}
                  required
                  maxLength={254}
                  autoComplete="email"
                  placeholder="ada@company.com"
                  aria-invalid={errorField === "email"}
                  aria-describedby={`new-member-email-hint${errorField === "email" ? " add-member-error" : ""}`}
                  onChange={(event) => {
                    setError(null);
                    setErrorField(null);
                    setDraft((current) => ({
                      ...current,
                      email: event.target.value,
                    }));
                  }}
                />
                <p
                  id="new-member-email-hint"
                  className="mt-1.5 text-[11px] leading-5 text-ink-faint"
                >
                  Booking updates and calendar invitations use this address.
                </p>
              </label>

              <label className="block" htmlFor="new-member-key">
                <FieldHeader
                  label="Booking URL"
                  custom={Boolean(draft.key.trim())}
                  detail="Permanent"
                />
                <span className="flex min-w-0 overflow-hidden rounded-lg border border-hairline bg-paper focus-within:ring-2 focus-within:ring-accent/60 focus-within:ring-offset-2 focus-within:ring-offset-paper">
                  <span className="flex shrink-0 items-center border-r border-hairline bg-paper-raise px-3 font-mono text-xs text-ink-faint">
                    /
                  </span>
                  <input
                    ref={keyRef}
                    id="new-member-key"
                    className="min-w-0 flex-1 border-0 bg-paper px-3 py-2.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:outline-none"
                    value={draft.key}
                    required
                    maxLength={48}
                    placeholder="ada-lovelace"
                    aria-invalid={errorField === "key"}
                    aria-describedby={`new-member-key-hint${errorField === "key" ? " add-member-error" : ""}`}
                    onChange={(event) => {
                      setError(null);
                      setErrorField(null);
                      setKeyEdited(true);
                      setDraft((current) => ({
                        ...current,
                        key: event.target.value.toLowerCase(),
                      }));
                    }}
                  />
                </span>
                <p
                  id="new-member-key-hint"
                  className="mt-1.5 text-[11px] leading-5 text-ink-faint"
                >
                  Choose carefully. The slug stays fixed so old booking links
                  and history remain trustworthy.
                </p>
              </label>

              <label className="block" htmlFor="new-member-timezone">
                <FieldHeader
                  label="Working timezone"
                  custom
                  detail="Per member"
                />
                <input
                  ref={timezoneRef}
                  id="new-member-timezone"
                  className={FIELD}
                  list={TIMEZONE_LIST_ID}
                  value={draft.timezone}
                  required
                  maxLength={64}
                  placeholder={defaultTimezone}
                  aria-invalid={errorField === "timezone"}
                  aria-describedby={`new-member-timezone-hint${errorField === "timezone" ? " add-member-error" : ""}`}
                  onChange={(event) => {
                    setError(null);
                    setErrorField(null);
                    setDraft((current) => ({
                      ...current,
                      timezone: event.target.value,
                    }));
                  }}
                />
                <p
                  id="new-member-timezone-hint"
                  className="mt-1.5 text-[11px] leading-5 text-ink-faint"
                >
                  Their hours and bookable days are interpreted in this
                  timezone, independently of every visitor.
                </p>
              </label>
            </div>

            {error && (
              <div
                id="add-member-error"
                className="mt-6 flex items-start gap-2.5 border-l-2 border-status-warn bg-status-warn/[0.05] px-4 py-3 text-sm text-ink-soft"
                role="alert"
              >
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
                <p>{error}</p>
              </div>
            )}

            <div className="mt-8 border-y border-hairline py-4">
              <p className="text-xs font-semibold text-ink">
                What happens next
              </p>
              <ol className="mt-2 grid gap-2 text-xs leading-5 text-ink-mute sm:grid-cols-2">
                <li>1. Connect their calendar</li>
                <li>2. Review timezone and hours</li>
                <li>3. Customize booking rules</li>
                <li>4. Publish their page</li>
              </ol>
            </div>
          </div>

          <div className="sticky bottom-0 flex gap-2 border-t border-hairline bg-paper/95 px-5 py-4 backdrop-blur sm:px-7">
            <button
              type="button"
              disabled={pending}
              onClick={onCancel}
              className={`${SECONDARY_BUTTON} flex-1`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className={`${PRIMARY_BUTTON} flex-1`}
            >
              {pending ? (
                <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
              {pending ? "Adding…" : "Add member"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PageListCard({
  page,
  selected,
  selectionDisabled,
  error,
  copied,
  onSelect,
  onCopy,
}: {
  page: PersonalPage;
  selected: boolean;
  selectionDisabled: boolean;
  error?: string;
  copied: boolean;
  onSelect: () => void;
  onCopy: () => void;
}) {
  const health = page.calendarReady
    ? {
        label: "Calendar ready",
        className: "text-status-ok",
        icon: <CheckCircle2 />,
      }
    : {
        label: "Calendar needed",
        className: "text-status-warn",
        icon: <CircleAlert />,
      };

  return (
    <article
      className={`relative min-w-[14.5rem] snap-start border-r border-hairline py-4 pl-3 pr-1 transition-colors last:border-r-0 lg:min-w-0 lg:border-b lg:border-r-0 lg:last:border-b-0 ${
        selected ? "bg-accent/[0.045]" : "hover:bg-paper-raise/70"
      }`}
    >
      {selected && (
        <span
          className="absolute inset-y-3 left-0 w-0.5 bg-accent"
          aria-hidden
        />
      )}
      <div className="flex items-start">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 pr-2">
            <p className="truncate text-sm font-semibold text-ink">
              {page.memberName}
            </p>
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${page.calendarReady ? "bg-status-ok" : "bg-status-warn"}`}
              aria-hidden
            />
          </div>
          <p
            className={`mt-1 flex items-center gap-1.5 text-[11px] font-medium ${health.className}`}
          >
            <span className="[&>svg]:h-3 [&>svg]:w-3 [&>svg]:stroke-[1.8]">
              {health.icon}
            </span>
            {health.label}
          </p>
          <p className="mt-1 text-[11px] text-ink-faint">
            Personal page {page.enabled ? "live" : "paused"}
          </p>
          <p className="mt-1 truncate text-[11px] text-ink-faint">
            {formatLocalTime(page.effective.timezoneToday)} ·{" "}
            {page.effective.timezoneToday.replaceAll("_", " ")}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5 pr-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-mute">
          {urlPath(page.url)}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className={`${FOCUS_RING} flex h-10 w-10 items-center justify-center rounded text-ink-faint hover:bg-paper-raise hover:text-ink`}
          aria-label={`Copy ${page.memberName} page link`}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-status-ok" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
        <a
          href={page.url}
          target="_blank"
          rel="noreferrer"
          className={`${FOCUS_RING} flex h-10 w-10 items-center justify-center rounded text-ink-faint hover:bg-paper-raise hover:text-ink`}
          aria-label={`Open ${page.memberName} booking page`}
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </a>
      </div>

      <button
        type="button"
        disabled={selectionDisabled}
        onClick={onSelect}
        aria-pressed={selected}
        className={`${FOCUS_RING} mt-2 flex w-full items-center justify-between py-1 pr-2 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-50 ${selected ? "text-accent" : "text-ink-mute hover:text-ink"}`}
      >
        {selected ? "Editing member" : "Edit member"}
        <ChevronRight
          className={`h-3.5 w-3.5 motion-safe:transition-transform ${selected ? "translate-x-0.5" : ""}`}
        />
      </button>
      {error && (
        <p
          className="mt-2 px-1 text-xs leading-5 text-status-warn"
          role="alert"
        >
          {error}
        </p>
      )}
    </article>
  );
}

function LiveSwitch({
  enabled,
  pending,
  label,
  onChange,
  compact = false,
}: {
  enabled: boolean;
  pending: boolean;
  label: string;
  onChange: (enabled: boolean) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${label}: ${enabled ? "live" : "paused"}`}
      disabled={pending}
      onClick={() => onChange(!enabled)}
      className={`${FOCUS_RING} relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl disabled:opacity-60`}
    >
      <span
        aria-hidden
        className={`relative inline-flex shrink-0 items-center rounded-full border motion-safe:transition-colors ${
          compact ? "h-5 w-9" : "h-6 w-11"
        } ${enabled ? "border-ink bg-ink" : "border-hairline-strong bg-paper"}`}
      >
        <span
          className={`absolute block rounded-full bg-paper-raise shadow-sm motion-safe:transition-transform ${
            compact ? "left-0.5 h-3.5 w-3.5" : "left-1 h-4 w-4"
          } ${enabled ? (compact ? "translate-x-4" : "translate-x-5") : "translate-x-0"}`}
        />
      </span>
    </button>
  );
}

function BookingPageEditor({
  page,
  defaults,
  livePending,
  liveError,
  onToggleLive,
  onDirtyChange,
  onPendingChange,
  onUnauthorized,
  onRefetch,
  onPagePatch,
  onArchive,
  onRosterChange,
}: {
  page: PersonalPage;
  defaults: PersonalPagesResponse["defaults"];
  livePending: boolean;
  liveError?: string;
  onToggleLive: (enabled: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onUnauthorized: () => void;
  onRefetch: (memberKey: string) => Promise<PersonalPage | null>;
  onPagePatch: (memberKey: string, patch: Partial<PersonalPage>) => void;
  onArchive: (page: PersonalPage) => Promise<void>;
  onRosterChange: () => void;
}) {
  const initialDraft = useMemo(() => draftFor(page), [page]);
  const [draft, setDraft] = useState<PageDraft>(initialDraft);
  const [baseline, setBaseline] = useState<PageDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [clearingWebhook, setClearingWebhook] = useState(false);
  const [webhookConfigured, setWebhookConfigured] = useState(
    page.slackWebhookConfigured,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [resetConfirming, setResetConfirming] = useState(false);
  const [webhookClearConfirming, setWebhookClearConfirming] = useState(false);
  const [archiveConfirming, setArchiveConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const validationRef = useRef<HTMLDivElement>(null);
  const webhookClearTriggerRef = useRef<HTMLButtonElement>(null);
  const webhookClearConfirmRef = useRef<HTMLButtonElement>(null);
  const archiveTriggerRef = useRef<HTMLButtonElement>(null);
  const archiveHeadingRef = useRef<HTMLHeadingElement>(null);

  const dirty = !draftsMatch(draft, baseline);
  const mutationPending = saving || clearingWebhook || archiving;
  const interactionPending = mutationPending || livePending;
  const preview = useMemo(
    () => previewFor(draft, page, defaults),
    [defaults, draft, page],
  );
  const customCount = [
    draft.timezone,
    draft.moveFromTimezone || draft.moveDate,
    draft.durationMinutes,
    draft.slotStepMinutes,
    draft.windowStart,
    draft.windowEnd,
    draft.minNoticeMinutes,
    draft.horizonDays,
    draft.bookableWeekdays,
    draft.eventTitle,
    draft.eventDescription,
    draft.headline,
    draft.blurb,
    draft.slackWebhookUrl,
    webhookConfigured ? "configured" : "",
  ].filter((value) => value !== "" && value !== null).length;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onPendingChange(mutationPending);
    return () => onPendingChange(false);
  }, [mutationPending, onPendingChange]);

  useEffect(() => {
    if (webhookClearConfirming) webhookClearConfirmRef.current?.focus();
  }, [webhookClearConfirming]);

  useEffect(() => {
    if (archiveConfirming) archiveHeadingRef.current?.focus();
  }, [archiveConfirming]);

  const update = <Key extends keyof PageDraft>(
    key: Key,
    value: PageDraft[Key],
  ) => {
    setNotice(null);
    setValidationErrors([]);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const installFreshPage = (fresh: PersonalPage) => {
    const next = draftFor(fresh);
    setDraft(next);
    setBaseline(next);
    setWebhookConfigured(fresh.slackWebhookConfigured);
    setValidationErrors([]);
    setResetConfirming(false);
    setWebhookClearConfirming(false);
  };

  const mutate = async (
    body: Record<string, unknown>,
  ): Promise<Response | null> => {
    const response = await fetch(
      `/api/meet/admin/pages/${encodeURIComponent(page.memberKey)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (response.status === 401) {
      onUnauthorized();
      return null;
    }
    return response;
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || interactionPending) return;
    const errors = validateDraft(draft, defaults);
    if (errors.length > 0) {
      setValidationErrors(errors);
      setNotice({
        tone: "error",
        text: "Review the settings below before saving.",
      });
      window.requestAnimationFrame(() => validationRef.current?.focus());
      return;
    }

    setSaving(true);
    setNotice(null);
    setValidationErrors([]);
    // Patch only controls changed in this draft. This avoids overwriting an
    // unrelated setting if another admin tab saved while this one was open.
    const memberBody: Record<string, unknown> = {};
    if (draft.memberName !== baseline.memberName) {
      memberBody.name = draft.memberName.trim();
    }
    if (draft.memberEmail !== baseline.memberEmail) {
      memberBody.email = draft.memberEmail.trim().toLowerCase();
    }
    const body: Record<string, unknown> = {};
    if (
      draft.headline !== baseline.headline ||
      (draft.memberName !== baseline.memberName &&
        page.headline === page.memberName &&
        !draft.headline.trim())
    ) {
      const headline = draft.headline.trim();
      body.headline =
        !headline || headline === draft.memberName.trim() ? null : headline;
    }
    if (draft.blurb !== baseline.blurb) body.blurb = draft.blurb.trim() || null;
    if (draft.timezone !== baseline.timezone) {
      body.timezone = draft.timezone.trim() || null;
    }
    if (
      draft.moveFromTimezone !== baseline.moveFromTimezone ||
      draft.moveDate !== baseline.moveDate
    ) {
      body.timezoneUntil =
        draft.moveFromTimezone.trim() && draft.moveDate.trim()
          ? {
              timezone: draft.moveFromTimezone.trim(),
              beforeDate: draft.moveDate.trim(),
            }
          : null;
    }
    if (draft.durationMinutes !== baseline.durationMinutes) {
      body.durationMinutes = integerPatch(draft.durationMinutes);
    }
    if (draft.slotStepMinutes !== baseline.slotStepMinutes) {
      body.slotStepMinutes = integerPatch(draft.slotStepMinutes);
    }
    if (draft.windowStart !== baseline.windowStart) {
      body.windowStart = draft.windowStart.trim() || null;
    }
    if (draft.windowEnd !== baseline.windowEnd) {
      body.windowEnd = draft.windowEnd.trim() || null;
    }
    if (draft.minNoticeMinutes !== baseline.minNoticeMinutes) {
      body.minNoticeMinutes = integerPatch(draft.minNoticeMinutes);
    }
    if (draft.horizonDays !== baseline.horizonDays) {
      body.horizonDays = integerPatch(draft.horizonDays);
    }
    if (
      JSON.stringify(draft.bookableWeekdays) !==
      JSON.stringify(baseline.bookableWeekdays)
    ) {
      body.bookableWeekdays = draft.bookableWeekdays;
    }
    if (draft.eventTitle !== baseline.eventTitle) {
      body.eventTitle = draft.eventTitle.trim() || null;
    }
    if (draft.eventDescription !== baseline.eventDescription) {
      body.eventDescription = draft.eventDescription.trim() || null;
    }
    if (draft.slackWebhookUrl.trim()) {
      body.slackWebhookUrl = draft.slackWebhookUrl.trim();
    }

    try {
      if (Object.keys(memberBody).length > 0) {
        const memberResponse = await fetch(
          `/api/meet/admin/members/${encodeURIComponent(page.memberKey)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(memberBody),
          },
        );
        if (memberResponse.status === 401) {
          onUnauthorized();
          return;
        }
        if (!memberResponse.ok) {
          throw new Error(
            await responseMessage(
              memberResponse,
              "Could not save this member’s identity.",
            ),
          );
        }
        onRosterChange();
      }
      if (Object.keys(body).length > 0) {
        const response = await mutate(body);
        if (!response) return;
        if (!response.ok) {
          throw new Error(
            await responseMessage(
              response,
              "Could not save these booking rules.",
            ),
          );
        }
      }
      const fresh = await onRefetch(page.memberKey);
      if (!fresh) return;
      installFreshPage(fresh);
      setNotice({
        tone: "success",
        text: "Member details and booking rules saved.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not save this booking page.",
      });
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = async () => {
    if (mutationPending) return;
    setSaving(true);
    setNotice(null);
    setValidationErrors([]);
    try {
      const response = await mutate({
        headline: null,
        blurb: null,
        timezone: null,
        timezoneUntil: null,
        durationMinutes: null,
        slotStepMinutes: null,
        windowStart: null,
        windowEnd: null,
        minNoticeMinutes: null,
        horizonDays: null,
        bookableWeekdays: null,
        eventTitle: null,
        eventDescription: null,
        slackWebhookUrl: null,
      });
      if (!response) return;
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "Could not reset this booking page."),
        );
      }
      const fresh = await onRefetch(page.memberKey);
      if (!fresh) return;
      installFreshPage(fresh);
      setNotice({
        tone: "success",
        text: "Custom settings cleared. Inherited defaults are active.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not reset this booking page.",
      });
    } finally {
      setSaving(false);
    }
  };

  const clearWebhook = async () => {
    if (mutationPending) return;
    setClearingWebhook(true);
    setNotice(null);
    try {
      // Clearing the secret is isolated so it cannot commit form drafts.
      const response = await mutate({ slackWebhookUrl: null });
      if (!response) return;
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "Could not clear the Slack webhook."),
        );
      }
      setWebhookConfigured(false);
      setWebhookClearConfirming(false);
      update("slackWebhookUrl", "");
      onPagePatch(page.memberKey, { slackWebhookConfigured: false });
      setNotice({
        tone: "success",
        text: "Personal Slack webhook cleared. Team routing will be used when Slack notifications are enabled.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not clear the Slack webhook.",
      });
    } finally {
      setClearingWebhook(false);
    }
  };

  const archive = async () => {
    if (mutationPending || dirty) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      await onArchive(page);
    } catch (error) {
      setArchiveError(
        error instanceof Error
          ? error.message
          : `Could not remove ${page.memberName}.`,
      );
    } finally {
      setArchiving(false);
    }
  };

  const discard = () => {
    setDraft(baseline);
    setValidationErrors([]);
    setNotice(null);
    setResetConfirming(false);
    setWebhookClearConfirming(false);
    setArchiveConfirming(false);
    setArchiveError(null);
  };

  const cancelWebhookClear = () => {
    setWebhookClearConfirming(false);
    window.requestAnimationFrame(() => webhookClearTriggerRef.current?.focus());
  };

  const closeArchiveConfirmation = () => {
    setArchiveConfirming(false);
    setArchiveError(null);
    window.requestAnimationFrame(() => archiveTriggerRef.current?.focus());
  };

  const inheritsWeekdays = draft.bookableWeekdays === null;
  const activeWeekdays = draft.bookableWeekdays ?? defaults.bookableWeekdays;
  const weekdayPattern = [1, 2, 3, 4, 5];
  const dailyPattern = [1, 2, 3, 4, 5, 6, 7];
  const patternMatches = (pattern: number[]) =>
    !inheritsWeekdays &&
    pattern.length === activeWeekdays.length &&
    pattern.every((weekday) => activeWeekdays.includes(weekday));
  const toggleWeekday = (weekday: number) => {
    const source = draft.bookableWeekdays ?? [...defaults.bookableWeekdays];
    const next = source.includes(weekday)
      ? source.filter((value) => value !== weekday)
      : [...source, weekday].sort((a, b) => a - b);
    update("bookableWeekdays", next);
  };

  return (
    <div className="min-w-0 border-y border-hairline bg-paper-raise/45">
      <div className="border-b border-hairline px-4 py-5 sm:px-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-serif-display text-2xl tracking-tight text-ink">
                {draft.memberName.trim() || page.memberName}
              </h3>
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${page.enabled ? "text-status-ok" : "text-ink-faint"}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${page.enabled ? "bg-status-ok" : "bg-ink-faint"}`}
                  aria-hidden
                />
                Personal page {page.enabled ? "live" : "paused"}
              </span>
              {!page.calendarReady && (
                <span className="text-[11px] font-medium text-status-warn">
                  No ready calendar
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-mute">
              <span className="inline-flex items-center gap-1.5">
                <Mail className="h-3 w-3" aria-hidden />
                {draft.memberEmail.trim() || page.memberEmail}
              </span>
              <span className="font-mono">{urlPath(page.url)}</span>
              <a
                href={page.url}
                target="_blank"
                rel="noreferrer"
                className={`${FOCUS_RING} inline-flex items-center gap-1 rounded font-medium text-ink-soft hover:text-ink`}
              >
                Open page <ArrowUpRight className="h-3 w-3" />
              </a>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-l border-hairline pl-4 sm:justify-start">
            <div>
              <p className="text-xs font-medium text-ink">
                Personal booking page
              </p>
              <p className="text-[11px] text-ink-faint">
                Team scheduling stays active
              </p>
            </div>
            <LiveSwitch
              enabled={page.enabled}
              pending={interactionPending}
              label={`${page.memberName} booking page`}
              onChange={onToggleLive}
            />
          </div>
        </div>
        {liveError && (
          <p className="mt-3 text-xs text-status-warn" role="alert">
            {liveError}
          </p>
        )}
      </div>

      <div className="grid border-b border-hairline bg-paper px-4 sm:grid-cols-3 sm:px-7">
        <RuleSummary
          label="Local time"
          value={formatLocalTime(preview.timezoneToday)}
          detail={preview.timezoneToday.replaceAll("_", " ")}
        />
        <RuleSummary
          label="Working pattern"
          value={`${preview.windowStart}–${preview.windowEnd}`}
          detail={`${weekdaySummary(preview.bookableWeekdays)} · ${inheritsWeekdays ? "inherited" : "member rule"}`}
        />
        <RuleSummary
          label="Booking rule"
          value={`${preview.durationMinutes} min · every ${preview.slotStepMinutes}`}
          detail={`${preview.minNoticeMinutes} min notice · ${preview.horizonDays} day horizon`}
        />
      </div>

      <div className="grid items-start gap-0 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <form
          onSubmit={(event) => void save(event)}
          className="min-w-0 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-7 lg:p-8"
        >
          <fieldset
            disabled={interactionPending}
            aria-busy={interactionPending}
            className="m-0 min-w-0 border-0 p-0"
          >
            <div className="mb-1 flex flex-wrap items-center justify-between gap-3 border-y border-hairline py-3">
              <div className="flex items-center gap-2">
                <Settings2
                  className="h-4 w-4 text-ink-mute"
                  strokeWidth={1.6}
                />
                <div>
                  <p className="text-xs font-semibold text-ink">
                    {customCount} custom setting{customCount === 1 ? "" : "s"}
                  </p>
                  <p className="text-[11px] text-ink-faint">
                    Blank controls inherit this host’s configured defaults
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setResetConfirming(true)}
                className={`${FOCUS_RING} rounded-md px-2 py-1 text-xs font-medium text-ink-mute hover:bg-ink/[0.04] hover:text-ink`}
              >
                Reset to inherited defaults
              </button>
            </div>

            {resetConfirming && (
              <div
                className="mb-5 rounded-xl border border-status-warn/30 bg-status-warn/[0.05] p-4"
                role="alert"
              >
                <div className="flex items-start gap-3">
                  <RotateCcw
                    className="mt-0.5 h-4 w-4 shrink-0 text-status-warn"
                    strokeWidth={1.7}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      Clear every custom setting for {page.memberName}?
                    </p>
                    <p className="mt-1 text-xs leading-5 text-ink-mute">
                      This clears page copy, timezone and availability
                      overrides, invite copy, and the personal Slack
                      destination. The live status will not change.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        disabled={mutationPending}
                        onClick={() => void resetToDefaults()}
                        className={`${PRIMARY_BUTTON} !px-3 !py-1.5`}
                      >
                        {saving ? (
                          <LoaderCircle className="h-3.5 w-3.5 motion-safe:animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        Reset page
                      </button>
                      <button
                        type="button"
                        disabled={mutationPending}
                        onClick={() => setResetConfirming(false)}
                        className={`${SECONDARY_BUTTON} !px-3 !py-1.5`}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setResetConfirming(false)}
                    className={`${FOCUS_RING} rounded p-1 text-ink-faint hover:text-ink`}
                    aria-label="Close reset confirmation"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            <nav
              aria-label="Member editor sections"
              className="sticky top-[6.75rem] z-10 -mx-1 mb-2 flex gap-1 overflow-x-auto border-y border-hairline bg-paper/95 px-1 py-2 backdrop-blur xl:hidden"
            >
              {[
                ["Basics", `basics-${page.memberKey}`],
                ["Availability", `availability-${page.memberKey}`],
                ["Notifications", `notifications-${page.memberKey}`],
                ["Preview", `preview-${page.memberKey}`],
              ].map(([label, id]) => (
                <button
                  key={id}
                  type="button"
                  className={`${FOCUS_RING} shrink-0 rounded-md px-3 py-2 text-xs font-medium text-ink-mute hover:bg-paper-raise hover:text-ink`}
                  onClick={() =>
                    document
                      .getElementById(id)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                >
                  {label}
                </button>
              ))}
            </nav>

            <div>
              <EditorSection
                id={`basics-${page.memberKey}`}
                icon={<Sparkles />}
                title="Basics"
                description="Member identity and the first thing visitors see on their page."
              >
                <div className="grid gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label
                      className="block"
                      htmlFor={`member-name-${page.memberKey}`}
                    >
                      <FieldHeader
                        label="Member name"
                        custom={draft.memberName !== baseline.memberName}
                        detail="Required"
                      />
                      <input
                        id={`member-name-${page.memberKey}`}
                        className={FIELD}
                        value={draft.memberName}
                        required
                        maxLength={80}
                        autoComplete="name"
                        onChange={(event) =>
                          update("memberName", event.target.value)
                        }
                      />
                    </label>
                    <label
                      className="block"
                      htmlFor={`member-email-${page.memberKey}`}
                    >
                      <FieldHeader
                        label="Notification email"
                        custom={draft.memberEmail !== baseline.memberEmail}
                        detail="Required"
                      />
                      <input
                        id={`member-email-${page.memberKey}`}
                        type="email"
                        className={FIELD}
                        value={draft.memberEmail}
                        required
                        maxLength={254}
                        autoComplete="email"
                        onChange={(event) =>
                          update("memberEmail", event.target.value)
                        }
                      />
                    </label>
                  </div>
                  <p className="border-l border-hairline pl-3 text-[11px] leading-5 text-ink-faint">
                    Booking URL{" "}
                    <span className="font-mono">{urlPath(page.url)}</span> stays
                    fixed so old links and history remain reliable.
                  </p>
                  <label
                    className="block"
                    htmlFor={`headline-${page.memberKey}`}
                  >
                    <FieldHeader
                      label="Headline"
                      custom={Boolean(draft.headline.trim())}
                      detail={`${draft.headline.length}/80 after prefix`}
                    />
                    <span className="flex min-w-0 overflow-hidden rounded-lg border border-hairline bg-paper transition-colors hover:border-hairline-strong focus-within:border-hairline-strong focus-within:ring-2 focus-within:ring-accent/60 focus-within:ring-offset-2 focus-within:ring-offset-paper">
                      <span className="flex shrink-0 items-center border-r border-hairline bg-paper-raise px-3 text-xs font-medium text-ink-mute">
                        Book a call with
                      </span>
                      <input
                        id={`headline-${page.memberKey}`}
                        className="min-w-0 flex-1 border-0 bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:cursor-wait disabled:opacity-60"
                        value={draft.headline}
                        maxLength={80}
                        placeholder={draft.memberName.trim() || page.memberName}
                        onChange={(event) =>
                          update("headline", event.target.value)
                        }
                      />
                    </span>
                    <p className="mt-1.5 text-xs text-ink-faint">
                      Customize only the words after the fixed prefix. Leave it
                      empty to use {draft.memberName.trim() || page.memberName}.
                    </p>
                  </label>
                  <label className="block" htmlFor={`blurb-${page.memberKey}`}>
                    <FieldHeader
                      label="Subheading"
                      custom={Boolean(draft.blurb.trim())}
                      detail={`${draft.blurb.length}/200`}
                    />
                    <textarea
                      id={`blurb-${page.memberKey}`}
                      className={`${FIELD} min-h-20 resize-y leading-5`}
                      value={draft.blurb}
                      maxLength={200}
                      placeholder="Add context, who this is for, or what to expect."
                      onChange={(event) => update("blurb", event.target.value)}
                    />
                  </label>
                </div>
              </EditorSection>

              <EditorSection
                id={`availability-${page.memberKey}`}
                icon={<CalendarDays />}
                title="Availability"
                description={`Working hours currently use ${preview.timezoneToday.replaceAll("_", " ")}.`}
              >
                <div className="mb-8 border-l-2 border-hairline-strong pl-4 sm:pl-5">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 text-ink-mute">
                      <Globe2 className="h-4 w-4" strokeWidth={1.6} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">
                        Host timezone
                      </p>
                      <p className="mt-0.5 text-xs leading-5 text-ink-faint">
                        Define this host’s working hours in their local
                        timezone, independently of the visitor’s display
                        timezone.
                      </p>
                    </div>
                  </div>

                  <div className="mt-4">
                    <InheritedField
                      id={`timezone-${page.memberKey}`}
                      label="Permanent timezone"
                      value={draft.timezone}
                      placeholder={defaults.timezone}
                      defaultText={defaults.timezone.replaceAll("_", " ")}
                      onChange={(value) => update("timezone", value)}
                      list={TIMEZONE_LIST_ID}
                    />
                  </div>

                  <div className="mt-4 border-t border-hairline pt-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-xs font-medium text-ink-soft">
                          Scheduled timezone change
                        </p>
                        <p className="mt-0.5 text-[11px] leading-5 text-ink-faint">
                          Optional. Keep the current zone until a move date,
                          then switch to the permanent zone above.
                        </p>
                      </div>
                      <span
                        className={`text-[10px] font-medium uppercase tracking-[0.08em] ${draft.moveDate || draft.moveFromTimezone ? "text-accent" : "text-ink-faint"}`}
                      >
                        {draft.moveDate || draft.moveFromTimezone
                          ? "Custom"
                          : "Inherited"}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <label
                        className="block"
                        htmlFor={`move-zone-${page.memberKey}`}
                      >
                        <span className="mb-1.5 block text-xs font-medium text-ink-mute">
                          Current timezone
                        </span>
                        <input
                          id={`move-zone-${page.memberKey}`}
                          className={FIELD}
                          value={draft.moveFromTimezone}
                          placeholder="Asia/Baku"
                          list={TIMEZONE_LIST_ID}
                          onChange={(event) =>
                            update("moveFromTimezone", event.target.value)
                          }
                        />
                      </label>
                      <label
                        className="block"
                        htmlFor={`move-date-${page.memberKey}`}
                      >
                        <span className="mb-1.5 block text-xs font-medium text-ink-mute">
                          Switch on
                        </span>
                        <input
                          id={`move-date-${page.memberKey}`}
                          type="date"
                          className={FIELD}
                          value={draft.moveDate}
                          onChange={(event) =>
                            update("moveDate", event.target.value)
                          }
                        />
                      </label>
                    </div>
                    <p className="mt-3 border-l border-hairline pl-3 text-[11px] leading-5 text-ink-mute">
                      {draft.moveFromTimezone.trim() && draft.moveDate.trim()
                        ? `${draft.moveFromTimezone.trim().replaceAll("_", " ")} remains active through the day before ${draft.moveDate.trim()}; ${preview.timezone.replaceAll("_", " ")} takes over on that date.`
                        : defaults.timezoneUntil
                          ? `Inheriting the team move: ${defaults.timezoneUntil.timezone.replaceAll("_", " ")} until ${defaults.timezoneUntil.beforeDate}, then ${preview.timezone.replaceAll("_", " ")}.`
                          : `No move scheduled. Hours use ${preview.timezone.replaceAll("_", " ")}.`}
                    </p>
                  </div>
                </div>

                <div>
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <FieldHeader
                        label="Days people can book"
                        custom={draft.bookableWeekdays !== null}
                        detail={
                          draft.bookableWeekdays === null
                            ? "Inherited"
                            : "Custom"
                        }
                      />
                      <p className="max-w-xl text-xs leading-5 text-ink-faint">
                        Inherited days follow the team-wide booking pattern.
                        Choosing a preset or day creates one member rule used
                        for this personal page and team scheduling.
                      </p>
                    </div>
                    <div
                      className="flex items-center gap-1 border-b border-hairline"
                      role="group"
                      aria-label="Availability presets"
                    >
                      {[
                        { label: "Weekdays", days: weekdayPattern },
                        { label: "Every day", days: dailyPattern },
                      ].map((preset) => {
                        const selected = patternMatches(preset.days);
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            aria-pressed={selected}
                            onClick={() =>
                              update("bookableWeekdays", preset.days)
                            }
                            className={`${FOCUS_RING} border-b px-2.5 py-1.5 text-xs font-medium transition-colors ${selected ? "border-accent text-ink" : "border-transparent text-ink-mute hover:text-ink"}`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div
                    className="grid grid-cols-7 overflow-hidden rounded-lg border border-hairline bg-hairline"
                    role="group"
                    aria-label="Bookable weekdays"
                  >
                    {WEEKDAYS.map((day) => {
                      const active = activeWeekdays.includes(day.value);
                      return (
                        <button
                          key={day.value}
                          type="button"
                          aria-pressed={active}
                          aria-label={day.long}
                          onClick={() => toggleWeekday(day.value)}
                          className={`${FOCUS_RING} min-h-16 bg-paper px-0.5 py-2 text-center transition-colors sm:min-h-20 ${active ? "bg-ink! text-paper" : "text-ink-faint hover:bg-paper-raise hover:text-ink"}`}
                        >
                          <span className="block text-xs font-semibold sm:text-sm">
                            <span className="sm:hidden">
                              {day.short.slice(0, 1)}
                            </span>
                            <span className="hidden sm:inline">
                              {day.short}
                            </span>
                          </span>
                          <span
                            className={`mt-1.5 block text-[9px] font-medium uppercase tracking-[0.08em] ${active ? "text-paper/55" : "text-ink-faint"}`}
                          >
                            {active ? "Open" : "Closed"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {draft.bookableWeekdays !== null && (
                    <button
                      type="button"
                      onClick={() => update("bookableWeekdays", null)}
                      className={`${FOCUS_RING} mt-2 rounded text-xs font-medium text-ink-mute underline decoration-hairline-strong underline-offset-4 hover:text-ink`}
                    >
                      Use inherited days (
                      {defaults.bookableWeekdays
                        .map(
                          (day) =>
                            WEEKDAYS.find((item) => item.value === day)?.short,
                        )
                        .join(", ")}
                      )
                    </button>
                  )}
                  <p
                    className={`mt-3 text-xs leading-5 ${activeWeekdays.includes(6) || activeWeekdays.includes(7) ? "text-status-ok" : "text-ink-mute"}`}
                  >
                    {inheritsWeekdays
                      ? "Inherited pattern — "
                      : "Member rule — "}
                    {activeWeekdays.includes(6) && activeWeekdays.includes(7)
                      ? "weekend booking is open on Saturday and Sunday."
                      : activeWeekdays.includes(6)
                        ? "weekend booking is open on Saturday."
                        : activeWeekdays.includes(7)
                          ? "weekend booking is open on Sunday."
                          : "weekend booking is closed."}
                    {dirty ? " Save changes to publish this pattern." : ""}
                  </p>
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <InheritedField
                    id={`duration-${page.memberKey}`}
                    label="Meeting length"
                    value={draft.durationMinutes}
                    placeholder={String(defaults.durationMinutes)}
                    defaultText={`${defaults.durationMinutes} minutes`}
                    suffix="min"
                    inputMode="numeric"
                    onChange={(value) => update("durationMinutes", value)}
                  />
                  <InheritedField
                    id={`cadence-${page.memberKey}`}
                    label="Slot cadence"
                    value={draft.slotStepMinutes}
                    placeholder={String(defaults.slotStepMinutes)}
                    defaultText={`Every ${defaults.slotStepMinutes} minutes`}
                    suffix="min"
                    inputMode="numeric"
                    onChange={(value) => update("slotStepMinutes", value)}
                  />
                  <InheritedField
                    id={`start-${page.memberKey}`}
                    label="Bookings open"
                    value={draft.windowStart}
                    placeholder={defaults.windowStart}
                    defaultText={defaults.windowStart}
                    type="time"
                    onChange={(value) => update("windowStart", value)}
                  />
                  <InheritedField
                    id={`end-${page.memberKey}`}
                    label="Bookings close"
                    value={draft.windowEnd}
                    placeholder={defaults.windowEnd}
                    defaultText={defaults.windowEnd}
                    type="time"
                    onChange={(value) => update("windowEnd", value)}
                  />
                  <InheritedField
                    id={`notice-${page.memberKey}`}
                    label="Minimum notice"
                    value={draft.minNoticeMinutes}
                    placeholder={String(defaults.minNoticeMinutes)}
                    defaultText={`${defaults.minNoticeMinutes} minutes`}
                    suffix="min"
                    inputMode="numeric"
                    onChange={(value) => update("minNoticeMinutes", value)}
                  />
                  <InheritedField
                    id={`horizon-${page.memberKey}`}
                    label="Booking horizon"
                    value={draft.horizonDays}
                    placeholder={String(defaults.horizonDays)}
                    defaultText={`${defaults.horizonDays} days`}
                    suffix="days"
                    inputMode="numeric"
                    onChange={(value) => update("horizonDays", value)}
                  />
                </div>
              </EditorSection>

              <EditorSection
                id={`notifications-${page.memberKey}`}
                icon={<Send />}
                title="Invitation & notifications"
                description="Control calendar copy and where new bookings are announced."
              >
                <div className="grid gap-4">
                  <label
                    className="block"
                    htmlFor={`event-title-${page.memberKey}`}
                  >
                    <FieldHeader
                      label="Calendar event title"
                      custom={Boolean(draft.eventTitle.trim())}
                      detail={draft.eventTitle.trim() ? "Custom" : "Inherited"}
                    />
                    <input
                      id={`event-title-${page.memberKey}`}
                      className={FIELD}
                      value={draft.eventTitle}
                      maxLength={200}
                      placeholder={defaults.eventTitle}
                      onChange={(event) =>
                        update("eventTitle", event.target.value)
                      }
                    />
                    <p className="mt-1.5 text-xs text-ink-faint">
                      <span className="font-mono">{"{name}"}</span> becomes the
                      booker’s name.
                    </p>
                  </label>
                  <label
                    className="block"
                    htmlFor={`event-description-${page.memberKey}`}
                  >
                    <FieldHeader
                      label="Calendar event description"
                      custom={Boolean(draft.eventDescription.trim())}
                      detail={
                        draft.eventDescription.trim() ? "Custom" : "Inherited"
                      }
                    />
                    <textarea
                      id={`event-description-${page.memberKey}`}
                      className={`${FIELD} min-h-28 resize-y leading-5`}
                      value={draft.eventDescription}
                      maxLength={2000}
                      placeholder={defaults.eventDescription}
                      onChange={(event) =>
                        update("eventDescription", event.target.value)
                      }
                    />
                  </label>

                  <div className="rounded-xl border border-hairline bg-paper p-3.5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <MessageSquareText
                            className="h-4 w-4 text-ink-mute"
                            strokeWidth={1.6}
                          />
                          <p className="text-sm font-medium text-ink">
                            Personal Slack webhook
                          </p>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-ink-faint">
                          {webhookConfigured
                            ? "A personal destination is saved. Leave the field empty to keep it, or paste a new URL to replace it. Delivery begins when team Slack notifications are enabled."
                            : "When Slack notifications are enabled, bookings use the team destination. Add a personal webhook to route this host separately."}
                        </p>
                      </div>
                      {webhookConfigured && (
                        <button
                          ref={webhookClearTriggerRef}
                          type="button"
                          disabled={mutationPending || webhookClearConfirming}
                          onClick={() => setWebhookClearConfirming(true)}
                          className={`${FOCUS_RING} inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-status-warn hover:bg-status-warn/[0.06] disabled:opacity-50`}
                        >
                          {clearingWebhook ? (
                            <LoaderCircle className="h-3.5 w-3.5 motion-safe:animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                          Clear
                        </button>
                      )}
                    </div>

                    {webhookConfigured && (
                      <div className="mt-3 flex items-center gap-2 rounded-lg border border-hairline bg-paper-raise px-3 py-2 text-xs text-ink-mute">
                        <LockKeyhole
                          className="h-3.5 w-3.5 shrink-0"
                          strokeWidth={1.6}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono tracking-[0.18em]">
                          ••••••••••••••••••••••••
                        </span>
                        <span className="shrink-0 font-sans tracking-normal text-status-ok">
                          Configured
                        </span>
                      </div>
                    )}
                    {webhookConfigured && webhookClearConfirming && (
                      <div
                        className="mt-3 rounded-lg border border-status-warn/30 bg-status-warn/[0.05] p-3"
                        role="alert"
                      >
                        <p className="text-xs font-medium text-ink">
                          Remove this saved Slack credential?
                        </p>
                        <p className="mt-1 text-[11px] leading-5 text-ink-mute">
                          The URL cannot be recovered. Future bookings will use
                          team routing only when Slack notifications are
                          enabled.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            ref={webhookClearConfirmRef}
                            type="button"
                            onClick={() => void clearWebhook()}
                            className={`${PRIMARY_BUTTON} !bg-status-warn !px-3 !py-1.5`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove webhook
                          </button>
                          <button
                            type="button"
                            onClick={cancelWebhookClear}
                            className={`${SECONDARY_BUTTON} !px-3 !py-1.5`}
                          >
                            Keep webhook
                          </button>
                        </div>
                      </div>
                    )}
                    <label
                      className="mt-3 block"
                      htmlFor={`slack-${page.memberKey}`}
                    >
                      <span className="mb-1.5 block text-xs font-medium text-ink-mute">
                        {webhookConfigured ? "Replace webhook" : "Webhook URL"}
                      </span>
                      <input
                        id={`slack-${page.memberKey}`}
                        type="password"
                        autoComplete="off"
                        className={FIELD}
                        value={draft.slackWebhookUrl}
                        placeholder="https://hooks.slack.com/services/…"
                        onChange={(event) =>
                          update("slackWebhookUrl", event.target.value)
                        }
                      />
                    </label>
                  </div>
                </div>
              </EditorSection>
            </div>

            <section className="mt-3 border-t border-hairline pt-7">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="max-w-xl">
                  <h4 className="text-sm font-semibold text-ink">
                    Remove member
                  </h4>
                  <p className="mt-1 text-xs leading-5 text-ink-mute">
                    Stops new team and personal bookings for {page.memberName}.
                    Booking history, rules and calendar connections stay
                    recoverable.
                  </p>
                  {dirty && (
                    <p className="mt-1.5 text-xs text-status-warn">
                      Save or discard the changes above before removing this
                      member.
                    </p>
                  )}
                </div>
                <button
                  ref={archiveTriggerRef}
                  type="button"
                  disabled={mutationPending || dirty}
                  onClick={() => {
                    setArchiveError(null);
                    setArchiveConfirming(true);
                  }}
                  className={`${FOCUS_RING} inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-status-warn/35 px-3 text-sm font-medium text-status-warn transition hover:bg-status-warn/[0.06] disabled:cursor-not-allowed disabled:opacity-45`}
                >
                  <Trash2 className="h-4 w-4" />
                  Remove member…
                </button>
              </div>

              {archiveConfirming && (
                <div
                  className="mt-4 border-l-2 border-status-warn bg-status-warn/[0.045] px-4 py-4"
                  role="region"
                  aria-labelledby={`archive-title-${page.memberKey}`}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && !archiving) {
                      closeArchiveConfirmation();
                    }
                  }}
                >
                  <h5
                    ref={archiveHeadingRef}
                    tabIndex={-1}
                    id={`archive-title-${page.memberKey}`}
                    className="text-sm font-semibold text-ink focus:outline-none"
                  >
                    Remove {page.memberName} from new bookings?
                  </h5>
                  <ul className="mt-2 space-y-1 text-xs leading-5 text-ink-mute">
                    <li>• Their personal page is taken offline.</li>
                    <li>• They stop counting toward team availability.</li>
                    <li>• Existing history and saved setup are retained.</li>
                  </ul>
                  <p className="mt-2 text-xs leading-5 text-ink-mute">
                    Removal is blocked if they still have a future meeting or if
                    it would break the team quorum.
                  </p>
                  {archiveError && (
                    <p
                      className="mt-3 text-xs font-medium text-status-warn"
                      role="alert"
                    >
                      {archiveError}
                    </p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={archiving}
                      onClick={() => void archive()}
                      className={`${PRIMARY_BUTTON} !bg-status-warn !px-3 !py-2`}
                    >
                      {archiving ? (
                        <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                      {archiving ? "Removing…" : "Remove member"}
                    </button>
                    <button
                      type="button"
                      disabled={archiving}
                      onClick={closeArchiveConfirmation}
                      className={SECONDARY_BUTTON}
                    >
                      Keep member
                    </button>
                  </div>
                </div>
              )}
            </section>

            {(notice || validationErrors.length > 0) && (
              <div
                ref={validationRef}
                tabIndex={validationErrors.length > 0 ? -1 : undefined}
                className={`mt-5 rounded-xl border p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${notice?.tone === "success" ? "border-status-ok/30 bg-status-ok/[0.05]" : "border-status-warn/30 bg-status-warn/[0.05]"}`}
                role={notice?.tone === "success" ? "status" : "alert"}
                aria-live="polite"
              >
                <div className="flex items-start gap-2.5">
                  {notice?.tone === "success" ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-ok" />
                  ) : (
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
                  )}
                  <div>
                    {notice && (
                      <p className="text-sm font-medium text-ink">
                        {notice.text}
                      </p>
                    )}
                    {validationErrors.length > 0 && (
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-ink-mute">
                        {validationErrors.map((error) => (
                          <li key={error}>{error}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div
              className={`z-10 mt-6 flex flex-col gap-3 rounded-lg border border-hairline bg-paper-raise/95 p-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between ${dirty || mutationPending ? "sticky bottom-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_12px_35px_hsl(var(--ink)_/_0.10)]" : ""}`}
            >
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={`h-2 w-2 rounded-full ${dirty ? "bg-status-warn" : "bg-status-ok"}`}
                />
                <span
                  className={dirty ? "font-medium text-ink" : "text-ink-mute"}
                >
                  {dirty ? "Unsaved changes" : "Everything is saved"}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!dirty || mutationPending}
                  onClick={discard}
                  className={`${SECONDARY_BUTTON} flex-1 sm:flex-none`}
                >
                  Discard
                </button>
                <button
                  type="submit"
                  disabled={!dirty || mutationPending}
                  className={`${PRIMARY_BUTTON} flex-1 sm:flex-none`}
                >
                  {saving ? (
                    <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </fieldset>
        </form>

        <div
          id={`preview-${page.memberKey}`}
          className="scroll-mt-32 border-t border-hairline bg-paper p-4 sm:p-6 xl:sticky xl:top-32 xl:border-l xl:border-t-0"
        >
          <BookingPagePreview page={page} preview={preview} />
        </div>
      </div>
    </div>
  );
}

function EditorSection({
  id,
  icon,
  title,
  description,
  children,
}: {
  id?: string;
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-32 border-t border-hairline py-7 first:border-t-0 sm:py-8"
    >
      <div className="flex items-start gap-3 pb-5">
        <span className="mt-0.5 text-ink-faint [&>svg]:h-4 [&>svg]:w-4 [&>svg]:stroke-[1.6]">
          {icon}
        </span>
        <div>
          <h4 className="font-serif-display text-lg font-bold tracking-tight text-ink">
            {title}
          </h4>
          <p className="mt-0.5 text-xs leading-5 text-ink-faint">
            {description}
          </p>
        </div>
      </div>
      <div className="pt-4">{children}</div>
    </section>
  );
}

function RuleSummary({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="border-b border-hairline py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:px-5 sm:first:pl-0 sm:last:border-r-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
        {label}
      </p>
      <p className="mt-1.5 text-sm font-semibold text-ink">{value}</p>
      <p className="mt-0.5 text-[11px] text-ink-mute sm:truncate">{detail}</p>
    </div>
  );
}

function FieldHeader({
  label,
  custom,
  detail,
}: {
  label: string;
  custom: boolean;
  detail?: string;
}) {
  return (
    <span className="mb-1.5 flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-ink-mute">{label}</span>
      <span
        className={`text-[10px] font-medium uppercase tracking-[0.08em] ${custom ? "text-accent" : "text-ink-faint"}`}
      >
        {detail ?? (custom ? "Custom" : "Inherited")}
      </span>
    </span>
  );
}

function InheritedField({
  id,
  label,
  value,
  placeholder,
  defaultText,
  onChange,
  suffix,
  type = "text",
  inputMode,
  list,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  defaultText: string;
  onChange: (value: string) => void;
  suffix?: string;
  type?: "text" | "time";
  inputMode?: "numeric";
  list?: string;
}) {
  const custom = Boolean(value.trim());
  return (
    <label className="block" htmlFor={id}>
      <FieldHeader label={label} custom={custom} />
      <span className="relative block">
        <input
          id={id}
          type={type}
          inputMode={inputMode}
          list={list}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={`${FIELD} ${suffix ? "pr-14" : ""}`}
        />
        {suffix && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-ink-faint">
            {suffix}
          </span>
        )}
      </span>
      <span className="mt-1.5 block text-[11px] text-ink-faint">
        {custom
          ? "Overrides the inherited default"
          : `Inheriting ${defaultText}`}
      </span>
    </label>
  );
}

function BookingPagePreview({
  page,
  preview,
}: {
  page: PersonalPage;
  preview: DraftPreview;
}) {
  const firstBookableIndex = WEEKDAYS.findIndex((day) =>
    preview.bookableWeekdays.includes(day.value),
  );
  const weekendOpen =
    preview.bookableWeekdays.includes(6) ||
    preview.bookableWeekdays.includes(7);
  return (
    <aside
      aria-label={`Non-interactive preview of ${page.memberName}'s booking page`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-ink">
          <Eye className="h-3.5 w-3.5 text-ink-mute" strokeWidth={1.6} />
          Live preview
        </div>
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-faint">
          Preview
        </span>
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-hairline bg-paper-raise shadow-[0_16px_45px_hsl(var(--ink)_/_0.08)]">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <span className="font-serif-display text-sm font-bold tracking-tight text-ink">
            clusy
          </span>
          <span className="h-5 w-5 rounded-full border border-hairline bg-paper" />
        </div>
        <div className="px-4 pb-5 pt-6 text-center">
          <p className="mx-auto max-w-[17rem] font-serif-display text-xl font-bold leading-tight tracking-tight text-ink">
            {preview.headline}
          </p>
          {preview.blurb && (
            <p className="mx-auto mt-2 max-w-[17rem] text-[11px] leading-4 text-ink-mute">
              {preview.blurb}
            </p>
          )}
          <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-hairline bg-paper px-3 py-1.5 text-[10px] text-ink-mute">
            <Clock3 className="h-3 w-3" strokeWidth={1.7} />
            {preview.durationMinutes} min · {preview.windowStart}–
            {preview.windowEnd}
          </div>

          <div className="mt-5 rounded-xl border border-hairline bg-paper p-3 text-left">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold text-ink">Choose a day</p>
              <span className="text-[9px] text-ink-faint">September</span>
            </div>
            <div className="mt-3 grid grid-cols-7 gap-1">
              {preview.bookableWeekdays.length > 0 ? (
                WEEKDAYS.map((day, index) => {
                  const active = preview.bookableWeekdays.includes(day.value);
                  return (
                    <div key={day.value} className="text-center">
                      <p className="text-[8px] uppercase text-ink-faint">
                        {day.short.slice(0, 1)}
                      </p>
                      <span
                        className={`mt-1 flex aspect-square items-center justify-center rounded-md text-[9px] ${active ? (index === firstBookableIndex ? "bg-ink text-paper" : "border border-hairline bg-paper-raise text-ink-mute") : "border border-transparent text-ink-faint/45 line-through"}`}
                      >
                        {14 + index}
                      </span>
                    </div>
                  );
                })
              ) : (
                <p className="col-span-7 py-3 text-center text-[10px] text-status-warn">
                  Choose at least one day
                </p>
              )}
            </div>
            <p
              className={`mt-2 text-[9px] ${weekendOpen ? "text-status-ok" : "text-ink-faint"}`}
            >
              {weekendOpen
                ? "Weekend dates are bookable"
                : "Weekend dates are closed"}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-1.5">
              {[preview.windowStart, "11:30", "14:00", preview.windowEnd].map(
                (time, index) => (
                  <span
                    key={`${time}-${index}`}
                    className="rounded-md border border-hairline bg-paper-raise px-2 py-1.5 text-center text-[9px] text-ink-mute"
                  >
                    {time}
                  </span>
                ),
              )}
            </div>
          </div>
          <p className="mt-3 flex items-center justify-center gap-1 text-[9px] text-ink-faint">
            <Globe2 className="h-2.5 w-2.5" />{" "}
            {preview.timezoneToday.replaceAll("_", " ")} · up to{" "}
            {preview.horizonDays} days ahead
          </p>
          {preview.timezoneUntil && (
            <p className="mt-2 rounded-lg border border-hairline bg-paper px-2.5 py-2 text-[9px] leading-4 text-ink-mute">
              {preview.timezoneToday === preview.timezoneUntil.timezone
                ? `${preview.timezoneUntil.timezone.replaceAll("_", " ")} until ${preview.timezoneUntil.beforeDate}; ${preview.timezone.replaceAll("_", " ")} from that date.`
                : `${preview.timezone.replaceAll("_", " ")} since ${preview.timezoneUntil.beforeDate}.`}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-hairline bg-paper-raise p-4">
        <div className="flex items-center gap-2">
          <CalendarDays
            className="h-3.5 w-3.5 text-ink-mute"
            strokeWidth={1.6}
          />
          <p className="text-xs font-semibold text-ink">Calendar invite</p>
        </div>
        <p className="mt-2 break-words text-xs font-medium text-ink-soft">
          {preview.eventTitle.replaceAll("{name}", "Alex")}
        </p>
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[10px] leading-4 text-ink-faint">
          {preview.eventDescription}
        </p>
        <div className="mt-3 flex items-center justify-between border-t border-hairline pt-3 text-[10px] text-ink-faint">
          <span>Every {preview.slotStepMinutes} min</span>
          <span>{preview.minNoticeMinutes} min notice</span>
        </div>
      </div>
    </aside>
  );
}

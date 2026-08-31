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
  MessageSquareText,
  PauseCircle,
  RotateCcw,
  Save,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import type { PersonalPage, PersonalPagesResponse } from "./types";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
const FIELD = `${FOCUS_RING} w-full rounded-lg border border-hairline bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint transition-colors hover:border-hairline-strong`;
const SECONDARY_BUTTON = `${FOCUS_RING} inline-flex items-center justify-center gap-2 rounded-lg border border-hairline bg-paper px-3 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50`;
const PRIMARY_BUTTON = `${FOCUS_RING} inline-flex items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45`;

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
  headline: string;
  blurb: string;
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

function draftFor(page: PersonalPage): PageDraft {
  return {
    // Older rows stored only the member name. Treat that legacy value as the
    // inherited headline instead of showing a one-word heading in the editor.
    headline: page.headline === page.memberName ? "" : (page.headline ?? ""),
    blurb: page.blurb ?? "",
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

function previewFor(
  draft: PageDraft,
  page: PersonalPage,
  defaults: PersonalPagesResponse["defaults"],
): DraftPreview {
  return {
    // Stored headlines are deliberately suffixes: the public page has always
    // rendered `Book a call with ${headline}`. Keep that contract visible in
    // the editor so an existing custom value never changes meaning.
    headline: `Book a call with ${draft.headline.trim() || page.memberName}`,
    blurb: draft.blurb.trim(),
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
  const headline = draft.headline.trim();
  const blurb = draft.blurb.trim();
  const eventTitle = draft.eventTitle.trim();
  const eventDescription = draft.eventDescription.trim();

  if (headline.length > 80)
    errors.push("Headline must be 80 characters or fewer.");
  if (blurb.length > 200)
    errors.push("Subheading must be 200 characters or fewer.");
  if (eventTitle.length > 200)
    errors.push("Event title must be 200 characters or fewer.");
  if (eventDescription.length > 2000) {
    errors.push("Event description must be 2,000 characters or fewer.");
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
}: {
  onUnauthorized: () => void;
}) {
  const unauthorizedRef = useRef(onUnauthorized);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [data, setData] = useState<PersonalPagesResponse | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorMutationPending, setEditorMutationPending] = useState(false);
  const [livePendingKey, setLivePendingKey] = useState<string | null>(null);
  const [pageErrors, setPageErrors] = useState<Record<string, string>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const editorAnchorRef = useRef<HTMLDivElement>(null);

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
      <div className="flex min-h-[28rem] items-center justify-center rounded-2xl border border-dashed border-hairline-strong bg-paper-raise px-6">
        <div className="max-w-md text-center">
          <UserRound
            className="mx-auto h-7 w-7 text-ink-faint"
            strokeWidth={1.4}
          />
          <h2 className="mt-4 font-serif-display text-2xl text-ink">
            No booking pages yet
          </h2>
          <p className="mt-2 text-sm leading-6 text-ink-mute">
            Add a team member to the Meet configuration and their personal
            booking page will appear here.
          </p>
        </div>
      </div>
    );
  }

  const selectedPage =
    data.pages.find((page) => page.memberKey === selectedKey) ?? data.pages[0];
  const liveCount = data.pages.filter((page) => page.enabled).length;
  const attentionCount = data.pages.filter(
    (page) => page.enabled && !page.calendarReady,
  ).length;

  return (
    <section aria-labelledby="booking-pages-heading">
      <div className="flex flex-col gap-5 border-b border-hairline pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2
            id="booking-pages-heading"
            className="font-serif-display text-4xl font-bold tracking-[-0.045em] text-ink sm:text-5xl"
          >
            Booking pages
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-ink-mute">
            Shape what each host says, when they can be booked, and where the
            invitation goes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-mute">
          <span>{data.pages.length} hosts</span>
          <span aria-hidden className="text-hairline-strong">
            /
          </span>
          <span>{liveCount} live</span>
          <span aria-hidden className="text-hairline-strong">
            /
          </span>
          <span className={attentionCount > 0 ? "text-status-warn" : undefined}>
            {attentionCount > 0
              ? `${attentionCount} needs attention`
              : "All calendars ready"}
          </span>
        </div>
      </div>

      <div className="mt-8 grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(13rem,0.52fr)_minmax(0,2.5fr)] lg:gap-8">
        <aside
          className="min-w-0 border-y border-hairline lg:sticky lg:top-32"
          aria-label="Booking pages"
        >
          <div className="flex items-center justify-between border-b border-hairline py-3">
            <div>
              <p className="text-sm font-semibold text-ink">Your pages</p>
              <p className="mt-0.5 text-xs text-ink-faint">Select a host</p>
            </div>
            <span className="font-mono text-[11px] text-ink-faint">
              {data.pages.length}
            </span>
          </div>
          <div className="flex max-w-full snap-x overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:block">
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
        </aside>

        <div ref={editorAnchorRef} className="min-w-0 scroll-mt-32">
          <BookingPageEditor
            key={selectedPage.memberKey}
            page={selectedPage}
            defaults={selectedPage.inherited}
            hostTimezone={data.hostTimezone}
            livePending={livePendingKey !== null}
            liveError={pageErrors[selectedPage.memberKey]}
            onToggleLive={(enabled) => void toggleLive(selectedPage, enabled)}
            onDirtyChange={setEditorDirty}
            onPendingChange={setEditorMutationPending}
            onUnauthorized={() => unauthorizedRef.current()}
            onRefetch={refetchPage}
            onPagePatch={patchPageLocally}
          />
        </div>
      </div>
    </section>
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
  const health = !page.enabled
    ? { label: "Paused", className: "text-ink-faint", icon: <PauseCircle /> }
    : page.calendarReady
      ? {
          label: "Healthy",
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
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-hairline font-serif-display text-xs text-ink">
          {page.memberName.trim().charAt(0).toUpperCase() || "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 pr-2">
            <p className="truncate text-sm font-semibold text-ink">
              {page.memberName}
            </p>
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${page.enabled ? (page.calendarReady ? "bg-status-ok" : "bg-status-warn") : "bg-ink-faint"}`}
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
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5 pl-11 pr-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-mute">
          {urlPath(page.url)}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className={`${FOCUS_RING} rounded p-1 text-ink-faint hover:text-ink`}
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
          className={`${FOCUS_RING} rounded p-1 text-ink-faint hover:text-ink`}
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
        className={`${FOCUS_RING} mt-2 flex w-full items-center justify-between py-1 pl-11 pr-2 text-xs font-medium transition-colors disabled:cursor-wait disabled:opacity-50 ${selected ? "text-accent" : "text-ink-mute hover:text-ink"}`}
      >
        {selected ? "Customizing" : "Customize"}
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
  hostTimezone,
  livePending,
  liveError,
  onToggleLive,
  onDirtyChange,
  onPendingChange,
  onUnauthorized,
  onRefetch,
  onPagePatch,
}: {
  page: PersonalPage;
  defaults: PersonalPagesResponse["defaults"];
  hostTimezone: string;
  livePending: boolean;
  liveError?: string;
  onToggleLive: (enabled: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onUnauthorized: () => void;
  onRefetch: (memberKey: string) => Promise<PersonalPage | null>;
  onPagePatch: (memberKey: string, patch: Partial<PersonalPage>) => void;
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
  const validationRef = useRef<HTMLDivElement>(null);
  const webhookClearTriggerRef = useRef<HTMLButtonElement>(null);
  const webhookClearConfirmRef = useRef<HTMLButtonElement>(null);
  const restoreWebhookClearFocusRef = useRef(false);

  const dirty = !draftsMatch(draft, baseline);
  const mutationPending = saving || clearingWebhook;
  const interactionPending = mutationPending || livePending;
  const preview = useMemo(
    () => previewFor(draft, page, defaults),
    [defaults, draft, page],
  );
  const customCount = [
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
    if (webhookClearConfirming) {
      webhookClearConfirmRef.current?.focus();
      return;
    }
    if (restoreWebhookClearFocusRef.current) {
      restoreWebhookClearFocusRef.current = false;
      webhookClearTriggerRef.current?.focus();
    }
  }, [webhookClearConfirming]);

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
    const body: Record<string, unknown> = {};
    if (draft.headline !== baseline.headline) {
      const headline = draft.headline.trim();
      body.headline =
        !headline || headline === page.memberName ? null : headline;
    }
    if (draft.blurb !== baseline.blurb) body.blurb = draft.blurb.trim() || null;
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
      const response = await mutate(body);
      if (!response) return;
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "Could not save this booking page."),
        );
      }
      const fresh = await onRefetch(page.memberKey);
      if (!fresh) return;
      installFreshPage(fresh);
      setNotice({
        tone: "success",
        text: "Page settings saved and refreshed.",
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

  const discard = () => {
    setDraft(baseline);
    setValidationErrors([]);
    setNotice(null);
    setResetConfirming(false);
    setWebhookClearConfirming(false);
  };

  const cancelWebhookClear = () => {
    restoreWebhookClearFocusRef.current = true;
    setWebhookClearConfirming(false);
  };

  const activeWeekdays = draft.bookableWeekdays ?? defaults.bookableWeekdays;
  const weekdayPattern = [1, 2, 3, 4, 5];
  const dailyPattern = [1, 2, 3, 4, 5, 6, 7];
  const patternMatches = (pattern: number[]) =>
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
                {page.memberName}
              </h3>
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${page.enabled ? "text-status-ok" : "text-ink-faint"}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${page.enabled ? "bg-status-ok" : "bg-ink-faint"}`}
                  aria-hidden
                />
                {page.enabled ? "Live" : "Paused"}
              </span>
              {!page.calendarReady && (
                <span className="text-[11px] font-medium text-status-warn">
                  No ready calendar
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-mute">
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
              <p className="text-xs font-medium text-ink">Accept bookings</p>
              <p className="text-[11px] text-ink-faint">Changes immediately</p>
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

      <div className="grid items-start gap-0 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <form
          onSubmit={(event) => void save(event)}
          className="min-w-0 p-4 sm:p-7 lg:p-8"
        >
          <fieldset
            disabled={interactionPending}
            aria-busy={interactionPending}
            className="m-0 min-w-0 border-0 p-0 disabled:cursor-wait"
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
                      This clears page copy, availability overrides, invite
                      copy, and the personal Slack destination. The live status
                      will not change.
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

            <div>
              <EditorSection
                icon={<Sparkles />}
                title="Basics"
                description="The first thing a visitor sees on this host’s page."
              >
                <div className="grid gap-4">
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
                        placeholder={page.memberName}
                        onChange={(event) =>
                          update("headline", event.target.value)
                        }
                      />
                    </span>
                    <p className="mt-1.5 text-xs text-ink-faint">
                      Customize only the words after the fixed prefix. Leave it
                      empty to use {page.memberName}.
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
                icon={<CalendarDays />}
                title="Availability"
                description={`Bookable times use ${hostTimezone.replaceAll("_", " ")}.`}
              >
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
                        Controls this host’s personal booking page. Choose a
                        preset or set individual days.
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
                    {activeWeekdays.includes(6) && activeWeekdays.includes(7)
                      ? "Weekend booking is open on Saturday and Sunday."
                      : activeWeekdays.includes(6)
                        ? "Weekend booking is open on Saturday."
                        : activeWeekdays.includes(7)
                          ? "Weekend booking is open on Sunday."
                          : "Weekend booking is currently closed."}
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
                    formatHint="HH:MM · 24:00 is supported"
                    onChange={(value) => update("windowStart", value)}
                  />
                  <InheritedField
                    id={`end-${page.memberKey}`}
                    label="Bookings close"
                    value={draft.windowEnd}
                    placeholder={defaults.windowEnd}
                    defaultText={defaults.windowEnd}
                    formatHint="HH:MM · 24:00 is supported"
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
                        onKeyDown={(event) => {
                          if (event.key === "Escape" && !clearingWebhook) {
                            event.preventDefault();
                            cancelWebhookClear();
                          }
                        }}
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

            <div className="sticky bottom-3 z-10 mt-6 flex flex-col gap-3 rounded-xl border border-hairline bg-paper-raise/95 p-3 shadow-[0_8px_30px_hsl(var(--ink)_/_0.10)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
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

        <div className="border-t border-hairline bg-paper p-4 sm:p-6 xl:sticky xl:top-32 xl:border-l xl:border-t-0">
          <BookingPagePreview
            page={page}
            preview={preview}
            hostTimezone={hostTimezone}
          />
        </div>
      </div>
    </div>
  );
}

function EditorSection({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-hairline py-7 first:border-t-0 sm:py-8">
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
  inputMode,
  formatHint,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  defaultText: string;
  onChange: (value: string) => void;
  suffix?: string;
  inputMode?: "numeric";
  formatHint?: string;
}) {
  const custom = Boolean(value.trim());
  return (
    <label className="block" htmlFor={id}>
      <FieldHeader label={label} custom={custom} />
      <span className="relative block">
        <input
          id={id}
          type="text"
          inputMode={inputMode}
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
        {formatHint ? ` · ${formatHint}` : ""}
      </span>
    </label>
  );
}

function BookingPagePreview({
  page,
  preview,
  hostTimezone,
}: {
  page: PersonalPage;
  preview: DraftPreview;
  hostTimezone: string;
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
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-hairline bg-paper font-serif-display text-base text-ink">
            {page.memberName.trim().charAt(0).toUpperCase() || "?"}
          </div>
          <p className="mx-auto mt-3 max-w-[17rem] font-serif-display text-xl font-bold leading-tight tracking-tight text-ink">
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
            {hostTimezone.replaceAll("_", " ")} · up to {preview.horizonDays}{" "}
            days ahead
          </p>
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

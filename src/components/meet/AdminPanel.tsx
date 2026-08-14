"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ChevronDown, X } from "lucide-react";
import type { CalendarProviderId, Member, SelectedCalendar } from "@/lib/meet/types";

/**
 * /admin surface: connect Google and Outlook accounts per member, pick
 * which calendars count as busy, disconnect accounts, and read the bookings
 * that config produced. Talks to /api/meet/* only; server-only modules stay
 * out of the client bundle.
 *
 * Calendar config is a set-up-once thing, so it opens folded (its header
 * still carries the counts and any reconnect warning); the day-to-day view
 * is the meetings list underneath it.
 */

interface AdminAccount {
  id: string;
  memberKey: string;
  provider: CalendarProviderId;
  email: string;
  selectedCalendars: SelectedCalendar[];
  status: "ok" | "reauth_required";
  createdAt: string;
}

interface AdminOverview {
  members: Member[];
  quorum: number;
  hostTimezone: string;
  window: { start: string; end: string };
  accounts: AdminAccount[];
  /** True when the server runs on fake in-memory calendars (MEET_MOCK_MODE). */
  mockMode: boolean;
}

interface CalendarEntry {
  id: string;
  name: string;
  primary: boolean;
}

/** One row of GET /api/meet/admin/bookings. */
interface AdminBooking {
  id: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  name: string;
  email: string;
  /** Extra addresses the booker invited; they get the calendar invite. */
  guests: string[];
  notes: string | null;
  timezone: string;
  attendeeMemberKeys: string[];
  meetingUrl: string | null;
  status: "confirmed" | "cancelled";
  syncStatus: "synced" | "partial" | "failed";
  rescheduleCount: number;
  remindersSent: string[];
  manageUrl: string;
  createdAt: string;
  cancelledAt: string | null;
}

interface BookingsResponse {
  hostTimezone: string;
  members: Member[];
  bookings: AdminBooking[];
}

type Phase = "loading" | "unauthed" | "ready" | "failed";

const PRIMARY_BUTTON =
  "rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-50";
const SUBTLE_BUTTON =
  "rounded-md border border-hairline px-3 py-1.5 text-sm text-ink-soft transition-colors hover:border-hairline-strong";

const MAX_SELECTED_CALENDARS = 20;

/** ?error= codes from the OAuth start and callback routes, mapped to copy. */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  state_expired: "The connect link expired. Start the connection again.",
  no_refresh_token:
    "The provider did not return a refresh token. Remove this app from the account's authorized apps, then reconnect.",
  mock_mode: "Connect flows are disabled in mock mode.",
  unauthorized: "The admin session expired. Sign in and try connecting again.",
  bad_provider: "That connect link points at an unknown calendar provider.",
  bad_member: "That connect link points at an unknown team member.",
  config_missing: "The provider's OAuth credentials are not configured on the server.",
};

export function AdminPanel() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [banner, setBanner] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  // The OAuth callback lands here with ?connected= or ?error=; read once and
  // clean the URL so a refresh does not resurrect the banner.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = new URLSearchParams(window.location.search);
      const connected = search.get("connected");
      const error = search.get("error");
      if (connected) {
        setBanner({ tone: "ok", text: `Connected ${connected}.` });
      } else if (error) {
        setBanner({
          tone: "warn",
          text: OAUTH_ERROR_MESSAGES[error] ?? "Connecting the account failed. Try again.",
        });
      }
      if (connected || error) {
        // Coming back from a connect attempt, successful or not, means the
        // visitor is mid-setup: unfold the config they were working in.
        setConfigOpen(true);
        window.history.replaceState(null, "", window.location.pathname);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch("/api/meet/admin/accounts", { cache: "no-store" });
      if (res.status === 401) {
        setPhase("unauthed");
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as AdminOverview;
      setOverview(data);
      setPhase("ready");
    } catch {
      setPhase("failed");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchOverview(), 0);
    return () => window.clearTimeout(timer);
  }, [fetchOverview]);

  const handleAccountUpdate = useCallback((id: string, patch: Partial<AdminAccount>) => {
    setOverview((prev) =>
      prev
        ? { ...prev, accounts: prev.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }
        : prev
    );
  }, []);

  const handleAccountDelete = useCallback((id: string) => {
    setOverview((prev) =>
      prev ? { ...prev, accounts: prev.accounts.filter((a) => a.id !== id) } : prev
    );
  }, []);

  if (phase === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-paper text-ink">
        <p className="text-sm text-ink-mute">Loading...</p>
      </main>
    );
  }

  if (phase === "unauthed") {
    return (
      <LoginCard
        onAuthed={() => {
          setPhase("loading");
          void fetchOverview();
        }}
      />
    );
  }

  if (phase === "failed" || !overview) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-paper px-5 text-ink">
        <div className="w-full max-w-sm rounded-lg border border-hairline bg-paper-raise p-6 text-center">
          <p className="text-sm text-ink-mute">Could not load the admin data.</p>
          <button
            type="button"
            className={`${SUBTLE_BUTTON} mt-4`}
            onClick={() => {
              setPhase("loading");
              void fetchOverview();
            }}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-paper text-ink">
      <div className="mx-auto max-w-2xl px-5 py-16 sm:py-20">
        {banner && (
          <div className="mb-6 flex items-start justify-between gap-3 rounded-lg border border-hairline bg-paper-raise px-4 py-3">
            <p
              className={`text-sm ${banner.tone === "ok" ? "text-status-ok" : "text-status-warn"}`}
            >
              {banner.text}
            </p>
            <button
              type="button"
              aria-label="Dismiss"
              className="mt-0.5 shrink-0 text-ink-faint transition-colors hover:text-ink-soft"
              onClick={() => setBanner(null)}
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>
        )}

        <header>
          <h1 className="font-serif-display text-3xl tracking-tight">Meet admin</h1>
          <p className="mt-2 text-sm text-ink-mute">
            Quorum {overview.quorum} of {overview.members.length}, Mon to Fri{" "}
            {overview.window.start} to {overview.window.end}{" "}
            {overview.hostTimezone.replaceAll("_", " ")}
          </p>
        </header>

        <CalendarConfigSection
          overview={overview}
          open={configOpen}
          onToggle={() => setConfigOpen((prev) => !prev)}
          onAccountUpdate={handleAccountUpdate}
          onAccountDelete={handleAccountDelete}
        />

        <PersonalPagesSection />

        <MeetingsSection />
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Personal booking pages                                              */
/* ------------------------------------------------------------------ */

interface PersonalPage {
  memberKey: string;
  memberName: string;
  url: string;
  enabled: boolean;
  headline: string | null;
  blurb: string | null;
  effective: {
    durationMinutes: number;
    slotStepMinutes: number;
    windowStart: string;
    windowEnd: string;
    minNoticeMinutes: number;
    horizonDays: number;
    bookableWeekdays: number[];
    eventTitle: string;
  };
  overrides: {
    durationMinutes: number | null;
    slotStepMinutes: number | null;
    windowStartMin: number | null;
    windowEndMin: number | null;
    minNoticeMinutes: number | null;
    horizonDays: number | null;
    bookableWeekdays: number[] | null;
    eventTitle: string | null;
  };
  slackWebhookConfigured: boolean;
  calendarReady: boolean;
}

interface PersonalPagesResponse {
  hostTimezone: string;
  defaults: {
    durationMinutes: number;
    slotStepMinutes: number;
    windowStart: string;
    windowEnd: string;
    minNoticeMinutes: number;
    horizonDays: number;
    eventTitle: string;
  };
  pages: PersonalPage[];
}

const FIELD_INPUT =
  "mt-1.5 w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-hairline-strong";
const FIELD_LABEL = "text-xs font-medium text-ink-mute";

/**
 * One booking page per person (/meet/ju, ...), folded away like the calendar
 * wiring because it is set-up-once configuration rather than daily traffic.
 * Placed after the calendar section on purpose: connect a calendar, then turn
 * the page on.
 */
function PersonalPagesSection() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [data, setData] = useState<PersonalPagesResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/meet/admin/pages", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<PersonalPagesResponse>) : null))
      .then((json) => {
        if (cancelled) return;
        if (json) {
          setData(json);
          setPhase("ready");
        } else {
          setPhase("failed");
        }
      })
      .catch(() => {
        if (!cancelled) setPhase("failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Patch in place rather than refetching, matching how account edits settle.
  const applyPatch = (memberKey: string, patch: Partial<PersonalPage>) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            pages: prev.pages.map((p) => (p.memberKey === memberKey ? { ...p, ...patch } : p)),
          }
        : prev
    );
  };

  const live = data?.pages.filter((p) => p.enabled) ?? [];
  const blind = live.filter((p) => !p.calendarReady);

  return (
    <section className="mt-8 rounded-lg border border-hairline bg-paper-raise">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-5 py-4 text-left"
      >
        <ChevronDown
          size={16}
          strokeWidth={1.5}
          className={`shrink-0 text-ink-faint transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="text-base font-medium">Personal pages</span>
        <span className="ml-auto truncate pl-3 text-sm text-ink-mute">
          {phase === "ready" && data
            ? `${live.length} of ${data.pages.length} live`
            : phase === "failed"
              ? "unavailable"
              : "loading"}
          {blind.length > 0 && (
            <span className="text-status-warn">
              {" "}
              · no calendar for {blind.map((p) => p.memberName).join(", ")}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="space-y-5 rounded-b-lg border-t border-hairline bg-paper p-5">
          {phase === "failed" && (
            <p className="text-sm text-status-warn">Could not load the personal pages.</p>
          )}
          {phase === "loading" && <p className="text-sm text-ink-mute">Loading…</p>}
          {phase === "ready" &&
            data?.pages.map((page) => (
              <PersonalPageCard
                key={page.memberKey}
                page={page}
                defaults={data.defaults}
                hostTimezone={data.hostTimezone}
                onPatched={applyPatch}
              />
            ))}
        </div>
      )}
    </section>
  );
}

function PersonalPageCard({
  page,
  defaults,
  hostTimezone,
  onPatched,
}: {
  page: PersonalPage;
  defaults: PersonalPagesResponse["defaults"];
  hostTimezone: string;
  onPatched: (memberKey: string, patch: Partial<PersonalPage>) => void;
}) {
  const [headline, setHeadline] = useState(page.headline ?? "");
  const [blurb, setBlurb] = useState(page.blurb ?? "");
  const [duration, setDuration] = useState(
    page.overrides.durationMinutes === null ? "" : String(page.overrides.durationMinutes)
  );
  const [windowStart, setWindowStart] = useState(
    page.overrides.windowStartMin === null ? "" : page.effective.windowStart
  );
  const [windowEnd, setWindowEnd] = useState(
    page.overrides.windowEndMin === null ? "" : page.effective.windowEnd
  );
  const [minNotice, setMinNotice] = useState(
    page.overrides.minNoticeMinutes === null ? "" : String(page.overrides.minNoticeMinutes)
  );
  const [eventTitle, setEventTitle] = useState(page.overrides.eventTitle ?? "");
  const [slackWebhook, setSlackWebhook] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** "" means "inherit"; the field is sent as null to clear the override. */
  const numberOrNull = (value: string): number | null | undefined => {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isInteger(n) ? n : undefined;
  };

  const save = async (extra: Record<string, unknown> = {}) => {
    setSaving(true);
    setError(null);
    setNote(null);
    const duration_ = numberOrNull(duration);
    const minNotice_ = numberOrNull(minNotice);
    if (duration_ === undefined || minNotice_ === undefined) {
      setSaving(false);
      setError("Length and notice must be whole numbers of minutes.");
      return;
    }
    const body: Record<string, unknown> = {
      headline: headline.trim() || null,
      blurb: blurb.trim() || null,
      durationMinutes: duration_,
      windowStart: windowStart.trim() || null,
      windowEnd: windowEnd.trim() || null,
      minNoticeMinutes: minNotice_,
      eventTitle: eventTitle.trim() || null,
      ...extra,
    };
    // Only send the webhook when the admin actually typed one: an empty box
    // must not silently clear a stored webhook on an unrelated save.
    if (slackWebhook.trim()) body.slackWebhookUrl = slackWebhook.trim();

    try {
      const res = await fetch(`/api/meet/admin/pages/${encodeURIComponent(page.memberKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) {
        setError(json?.message ?? "Could not save.");
        return;
      }
      const patch: Partial<PersonalPage> = {
        headline: headline.trim() || null,
        blurb: blurb.trim() || null,
      };
      if (typeof extra.enabled === "boolean") patch.enabled = extra.enabled;
      if (slackWebhook.trim()) patch.slackWebhookConfigured = true;
      if (extra.slackWebhookUrl === null) patch.slackWebhookConfigured = false;
      onPatched(page.memberKey, patch);
      setSlackWebhook("");
      setNote("Saved");
      window.setTimeout(() => setNote(null), 2000);
    } catch {
      setError("Could not save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-hairline bg-paper-raise p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-base font-medium">{page.memberName}</span>
        <a
          href={`/${page.memberKey}`}
          target="_blank"
          rel="noreferrer"
          className={ROW_LINK}
        >
          /{page.memberKey}
        </a>
        {!page.calendarReady && (
          <span className={`${CHIP} text-status-warn`}>no calendar connected</span>
        )}
        <label className="ml-auto flex items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            className="accent-accent"
            checked={page.enabled}
            disabled={saving}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          Live
        </label>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={FIELD_LABEL} htmlFor={`headline-${page.memberKey}`}>
            Heading
          </label>
          <input
            id={`headline-${page.memberKey}`}
            className={FIELD_INPUT}
            value={headline}
            placeholder={page.memberName}
            onChange={(e) => setHeadline(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={FIELD_LABEL} htmlFor={`blurb-${page.memberKey}`}>
            Subheading
          </label>
          <input
            id={`blurb-${page.memberKey}`}
            className={FIELD_INPUT}
            value={blurb}
            placeholder="Optional line under the heading"
            onChange={(e) => setBlurb(e.target.value)}
          />
        </div>
        <div>
          <label className={FIELD_LABEL} htmlFor={`duration-${page.memberKey}`}>
            Length (minutes)
          </label>
          <input
            id={`duration-${page.memberKey}`}
            className={FIELD_INPUT}
            inputMode="numeric"
            value={duration}
            placeholder={String(defaults.durationMinutes)}
            onChange={(e) => setDuration(e.target.value)}
          />
        </div>
        <div>
          <label className={FIELD_LABEL} htmlFor={`notice-${page.memberKey}`}>
            Minimum notice (minutes)
          </label>
          <input
            id={`notice-${page.memberKey}`}
            className={FIELD_INPUT}
            inputMode="numeric"
            value={minNotice}
            placeholder={String(defaults.minNoticeMinutes)}
            onChange={(e) => setMinNotice(e.target.value)}
          />
        </div>
        <div>
          <label className={FIELD_LABEL} htmlFor={`start-${page.memberKey}`}>
            Opens ({hostTimezone.replaceAll("_", " ")})
          </label>
          <input
            id={`start-${page.memberKey}`}
            className={FIELD_INPUT}
            value={windowStart}
            placeholder={defaults.windowStart}
            onChange={(e) => setWindowStart(e.target.value)}
          />
        </div>
        <div>
          <label className={FIELD_LABEL} htmlFor={`end-${page.memberKey}`}>
            Closes
          </label>
          <input
            id={`end-${page.memberKey}`}
            className={FIELD_INPUT}
            value={windowEnd}
            placeholder={defaults.windowEnd}
            onChange={(e) => setWindowEnd(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={FIELD_LABEL} htmlFor={`title-${page.memberKey}`}>
            Calendar event title
          </label>
          <input
            id={`title-${page.memberKey}`}
            className={FIELD_INPUT}
            value={eventTitle}
            placeholder={defaults.eventTitle}
            onChange={(e) => setEventTitle(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-faint">
            {"{name}"} is replaced with the booker&apos;s name.
          </p>
        </div>
        <div className="sm:col-span-2">
          <label className={FIELD_LABEL} htmlFor={`slack-${page.memberKey}`}>
            Slack webhook
          </label>
          <input
            id={`slack-${page.memberKey}`}
            className={FIELD_INPUT}
            type="password"
            autoComplete="off"
            value={slackWebhook}
            placeholder={
              page.slackWebhookConfigured
                ? "configured — type a new URL to replace it"
                : "https://hooks.slack.com/services/…"
            }
            onChange={(e) => setSlackWebhook(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-faint">
            Where this page&apos;s bookings are posted. Empty uses the team channel.
            {page.slackWebhookConfigured && (
              <>
                {" "}
                <button
                  type="button"
                  className="underline decoration-hairline-strong underline-offset-2"
                  disabled={saving}
                  onClick={() => void save({ slackWebhookUrl: null })}
                >
                  Clear
                </button>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {note && <span className="text-sm text-status-ok">{note}</span>}
        {error && <span className="text-sm text-status-warn">{error}</span>}
      </div>
    </div>
  );
}

/**
 * The calendar wiring, folded away by default. The header doubles as the
 * status line so a folded section can still say "one account needs
 * reconnecting" or "Ava has no calendar connected", which would otherwise
 * be invisible until someone thought to expand it.
 */
function CalendarConfigSection({
  overview,
  open,
  onToggle,
  onAccountUpdate,
  onAccountDelete,
}: {
  overview: AdminOverview;
  open: boolean;
  onToggle: () => void;
  onAccountUpdate: (id: string, patch: Partial<AdminAccount>) => void;
  onAccountDelete: (id: string) => void;
}) {
  const accountCount = overview.accounts.length;
  const reauthCount = overview.accounts.filter((a) => a.status === "reauth_required").length;
  const unconnected = overview.members.filter(
    (m) => !overview.accounts.some((a) => a.memberKey === m.key)
  );

  const warnings: string[] = [];
  if (reauthCount > 0) {
    warnings.push(`${reauthCount} need${reauthCount === 1 ? "s" : ""} reconnecting`);
  }
  if (unconnected.length > 0) {
    warnings.push(`no calendar for ${unconnected.map((m) => m.name).join(", ")}`);
  }

  return (
    <section className="mt-8 rounded-lg border border-hairline bg-paper-raise">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-5 py-4 text-left"
      >
        <ChevronDown
          size={16}
          strokeWidth={1.5}
          className={`shrink-0 text-ink-faint transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="text-base font-medium">Calendar config</span>
        <span className="ml-auto truncate pl-3 text-sm text-ink-mute">
          {accountCount} account{accountCount === 1 ? "" : "s"}, {overview.members.length} members
          {warnings.length > 0 && (
            <span className="text-status-warn"> · {warnings.join(", ")}</span>
          )}
        </span>
      </button>
      {open && (
        // Recessed body so the member cards keep the raised look they have
        // when they sit directly on the page.
        <div className="space-y-5 rounded-b-lg border-t border-hairline bg-paper p-5">
          {overview.members.map((member) => (
            <MemberCard
              key={member.key}
              member={member}
              accounts={overview.accounts.filter((a) => a.memberKey === member.key)}
              mockMode={overview.mockMode}
              onAccountUpdate={onAccountUpdate}
              onAccountDelete={onAccountDelete}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * What the config actually produced: upcoming calls first, past ones behind
 * a toggle. Cancelled bookings stay in the list so a hole in the calendar
 * has an explanation.
 */
function MeetingsSection() {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [data, setData] = useState<BookingsResponse | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [nowMs, setNowMs] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const res = await fetch("/api/meet/admin/bookings", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setData((await res.json()) as BookingsResponse);
      setNowMs(Date.now());
      setPhase("ready");
    } catch {
      setPhase("failed");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // A call that has started but not ended still belongs to "upcoming": it is
  // happening now, which is exactly when someone opens this page.
  const bookings = data?.bookings ?? [];
  const upcoming = bookings.filter((b) => Date.parse(b.endAt) >= nowMs);
  const past = bookings.filter((b) => Date.parse(b.endAt) < nowMs).reverse();

  return (
    <section className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium">Scheduled meetings</h2>
        <button
          type="button"
          onClick={() => void load()}
          className="text-sm text-ink-mute transition-colors hover:text-ink-soft"
        >
          {phase === "loading" ? "Loading..." : "Refresh"}
        </button>
      </div>

      {phase === "failed" && (
        <p className="mt-3 text-sm text-ink-mute">Could not load the bookings.</p>
      )}

      {data && (
        <>
          <div className="mt-3 rounded-lg border border-hairline bg-paper-raise px-5">
            {upcoming.length === 0 ? (
              <p className="py-4 text-sm text-ink-mute">
                {past.length === 0 ? "No meetings booked yet." : "Nothing upcoming."}
              </p>
            ) : (
              <ul className="divide-y divide-hairline">
                {upcoming.map((booking) => (
                  <BookingRow
                    key={booking.id}
                    booking={booking}
                    hostTimezone={data.hostTimezone}
                    members={data.members}
                  />
                ))}
              </ul>
            )}
          </div>

          {past.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                aria-expanded={showPast}
                onClick={() => setShowPast((prev) => !prev)}
                className="flex items-center gap-2 text-sm text-ink-mute transition-colors hover:text-ink-soft"
              >
                <ChevronDown
                  size={14}
                  strokeWidth={1.5}
                  className={`transition-transform ${showPast ? "" : "-rotate-90"}`}
                />
                Past 30 days ({past.length})
              </button>
              {showPast && (
                <div className="mt-2 rounded-lg border border-hairline bg-paper-raise px-5">
                  <ul className="divide-y divide-hairline">
                    {past.map((booking) => (
                      <BookingRow
                        key={booking.id}
                        booking={booking}
                        hostTimezone={data.hostTimezone}
                        members={data.members}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Booker-supplied zones come straight from the request, so a junk zone must
 * degrade to UTC rather than blank the admin console.
 */
function formatWhen(iso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  };
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat("en-US", options).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
  }
}

const CHIP = "shrink-0 rounded-full border border-hairline px-2 py-0.5 text-xs";
const ROW_LINK = "text-ink-soft underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink";

function BookingRow({
  booking,
  hostTimezone,
  members,
}: {
  booking: AdminBooking;
  hostTimezone: string;
  members: Member[];
}) {
  const cancelled = booking.status === "cancelled";
  const attending = booking.attendeeMemberKeys
    .map((key) => members.find((m) => m.key === key)?.name ?? key)
    .join(", ");

  return (
    <li className="py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={`text-sm ${cancelled ? "text-ink-mute line-through" : "text-ink"}`}
        >
          {formatWhen(booking.startAt, hostTimezone)}
        </span>
        <span className="text-xs text-ink-faint">{booking.durationMinutes} min</span>
        {cancelled && <span className={`${CHIP} text-status-warn`}>cancelled</span>}
        {!cancelled && booking.syncStatus !== "synced" && (
          <span className={`${CHIP} text-status-warn`}>sync {booking.syncStatus}</span>
        )}
        {booking.rescheduleCount > 0 && (
          <span className={`${CHIP} text-ink-mute`}>
            moved {booking.rescheduleCount}
            {booking.rescheduleCount === 1 ? " time" : " times"}
          </span>
        )}
      </div>
      <p className="mt-1 break-words text-sm text-ink-soft">
        {booking.name} <span className="text-ink-mute">{booking.email}</span>
        {booking.guests.length > 0 && (
          <span className="text-ink-mute">
            {" "}
            + {booking.guests.length} guest{booking.guests.length === 1 ? "" : "s"}:{" "}
            {booking.guests.join(", ")}
          </span>
        )}
      </p>
      <p className="mt-0.5 text-xs text-ink-mute">
        {attending ? `With ${attending}` : "No attendees recorded"}
        {/* The booker's own time only earns a line when it differs from ours. */}
        {booking.timezone !== hostTimezone && (
          <>
            {" "}
            &middot; {formatWhen(booking.startAt, booking.timezone)} for the booker (
            {booking.timezone.replaceAll("_", " ")})
          </>
        )}
      </p>
      {booking.notes && (
        <p className="mt-1.5 whitespace-pre-wrap text-xs text-ink-mute">{booking.notes}</p>
      )}
      <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {/* A cancelled booking has no live call and cannot be moved; linking
            to either would be a dead end. Its manage page still offers a
            rebooking link, so it stays reachable under an honest label. */}
        {!cancelled && booking.meetingUrl && (
          <a href={booking.meetingUrl} target="_blank" rel="noreferrer" className={ROW_LINK}>
            Video link
          </a>
        )}
        <a href={booking.manageUrl} target="_blank" rel="noreferrer" className={ROW_LINK}>
          {cancelled ? "Manage page" : "Reschedule or cancel"}
        </a>
      </p>
    </li>
  );
}

function LoginCard({ onAuthed }: { onAuthed: () => void }) {
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/meet/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      if (!res.ok) {
        setError(
          res.status === 401 ? "That secret does not match." : "Sign-in failed. Try again."
        );
        return;
      }
      onAuthed();
    } catch {
      setError("Sign-in failed. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-5 text-ink">
      <form
        className="w-full max-w-sm rounded-lg border border-hairline bg-paper-raise p-6"
        onSubmit={(event) => void submit(event)}
      >
        <h1 className="font-serif-display text-xl">Meet admin</h1>
        <label className="mt-4 block text-sm text-ink-soft" htmlFor="meet-admin-secret">
          Admin secret
        </label>
        <input
          id="meet-admin-secret"
          type="password"
          autoComplete="current-password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          className="mt-1.5 w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-hairline-strong"
        />
        <button type="submit" disabled={pending || !secret} className={`${PRIMARY_BUTTON} mt-4 w-full`}>
          {pending ? "Signing in..." : "Sign in"}
        </button>
        {error && <p className="mt-3 text-sm text-status-down">{error}</p>}
      </form>
    </main>
  );
}

function MemberCard({
  member,
  accounts,
  mockMode,
  onAccountUpdate,
  onAccountDelete,
}: {
  member: Member;
  accounts: AdminAccount[];
  mockMode: boolean;
  onAccountUpdate: (id: string, patch: Partial<AdminAccount>) => void;
  onAccountDelete: (id: string) => void;
}) {
  return (
    <section className="rounded-lg border border-hairline bg-paper-raise p-5">
      <h2 className="text-base font-medium">{member.name}</h2>
      {accounts.length === 0 ? (
        <p className="mt-3 text-sm text-ink-mute">No calendars connected yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-hairline">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onUpdate={onAccountUpdate}
              onDelete={onAccountDelete}
            />
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-hairline pt-4">
        {mockMode ? (
          <>
            <button type="button" disabled className={`${SUBTLE_BUTTON} cursor-default opacity-50`}>
              Connect Google
            </button>
            <button type="button" disabled className={`${SUBTLE_BUTTON} cursor-default opacity-50`}>
              Connect Outlook
            </button>
            <p className="w-full text-xs text-ink-mute">
              Connect flows are disabled in mock mode
            </p>
          </>
        ) : (
          <>
            <a
              href={`/api/meet/oauth/google/start?member=${encodeURIComponent(member.key)}`}
              className={SUBTLE_BUTTON}
            >
              Connect Google
            </a>
            <a
              href={`/api/meet/oauth/microsoft/start?member=${encodeURIComponent(member.key)}`}
              className={SUBTLE_BUTTON}
            >
              Connect Outlook
            </a>
          </>
        )}
      </div>
    </section>
  );
}

function AccountRow({
  account,
  onUpdate,
  onDelete,
}: {
  account: AdminAccount;
  onUpdate: (id: string, patch: Partial<AdminAccount>) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [calendars, setCalendars] = useState<CalendarEntry[] | null>(null);
  const [calsLoading, setCalsLoading] = useState(false);
  const [calsError, setCalsError] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(account.selectedCalendars.map((c) => c.id))
  );
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadCalendars = async () => {
    setCalsLoading(true);
    setCalsError(null);
    try {
      const res = await fetch(`/api/meet/admin/accounts/${account.id}/calendars`, {
        cache: "no-store",
      });
      if (res.status === 409) {
        onUpdate(account.id, { status: "reauth_required" });
        setCalsError("This account needs to be reconnected before its calendars can be listed.");
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { calendars: CalendarEntry[] };
      setCalendars(data.calendars);
    } catch {
      setCalsError("Could not load calendars. Collapse and expand the row to retry.");
    } finally {
      setCalsLoading(false);
    }
  };

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && calendars === null && !calsLoading) void loadCalendars();
  };

  const toggleCalendar = (id: string) => {
    setSaveNote(null);
    setSaveError(null);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Only calendars visible in the picker can be saved; stale ids from a
  // previous selection fall away silently.
  const selection = (calendars ?? [])
    .filter((c) => checked.has(c.id))
    .map((c): SelectedCalendar => ({ id: c.id, name: c.name }));
  const tooMany = selection.length > MAX_SELECTED_CALENDARS;

  const save = async () => {
    if (!calendars || saving || tooMany) return;
    setSaving(true);
    setSaveError(null);
    setSaveNote(null);
    try {
      const res = await fetch(`/api/meet/admin/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedCalendars: selection }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      onUpdate(account.id, { selectedCalendars: selection });
      setSaveNote("Saved.");
    } catch {
      setSaveError("Saving the selection failed. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/meet/admin/accounts/${account.id}`, { method: "DELETE" });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          data && typeof data === "object" && "message" in data &&
          typeof (data as { message?: unknown }).message === "string"
            ? (data as { message: string }).message
            : "Disconnecting failed. Try again.";
        throw new Error(message);
      }
      onDelete(account.id);
    } catch (error) {
      setDeleting(false);
      setDeleteError(
        error instanceof Error ? error.message : "Disconnecting failed. Try again."
      );
    }
  };

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggleExpanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            size={16}
            strokeWidth={1.5}
            className={`shrink-0 text-ink-faint transition-transform ${expanded ? "" : "-rotate-90"}`}
          />
          <span className="font-mono text-xs uppercase tracking-wide text-ink-mute">
            {account.provider === "google" ? "google" : "outlook"}
          </span>
          <span className="truncate text-sm text-ink">{account.email}</span>
          {account.status === "reauth_required" && (
            <span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-xs text-status-warn">
              reconnect needed
            </span>
          )}
        </button>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-2 text-sm">
            <span className="text-ink-mute">Remove this account?</span>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void remove()}
              className="text-status-down transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {deleting ? "Removing..." : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-ink-mute transition-colors hover:text-ink-soft"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
              setDeleteError(null);
            }}
            className="shrink-0 text-sm text-ink-mute transition-colors hover:text-ink-soft"
          >
            Disconnect
          </button>
        )}
      </div>
      {deleteError && (
        <p role="alert" className="mt-1 text-sm text-ink-mute">
          {deleteError}
        </p>
      )}
      {expanded && (
        <div className="mt-3 rounded-md border border-hairline bg-paper p-3">
          {calsLoading && <p className="text-sm text-ink-mute">Loading calendars...</p>}
          {calsError && <p className="text-sm text-ink-mute">{calsError}</p>}
          {calendars && (
            <>
              {calendars.length === 0 ? (
                <p className="text-sm text-ink-mute">No calendars found on this account.</p>
              ) : (
                <ul className="space-y-1.5">
                  {calendars.map((cal) => (
                    <li key={cal.id}>
                      <label className="flex items-center gap-2 text-sm text-ink-soft">
                        <input
                          type="checkbox"
                          checked={checked.has(cal.id)}
                          disabled={saving}
                          onChange={() => toggleCalendar(cal.id)}
                          className="accent-accent"
                        />
                        <span className="truncate">{cal.name}</span>
                        {cal.primary && <span className="text-xs text-ink-faint">primary</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={saving || tooMany}
                  onClick={() => void save()}
                  className={PRIMARY_BUTTON}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                {tooMany && (
                  <span className="text-sm text-ink-mute">
                    Pick at most {MAX_SELECTED_CALENDARS} calendars.
                  </span>
                )}
                {saveNote && <span className="text-sm text-status-ok">{saveNote}</span>}
                {saveError && <span className="text-sm text-ink-mute">{saveError}</span>}
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

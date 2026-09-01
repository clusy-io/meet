"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import { BookingPagesView } from "./admin/BookingPagesView";
import { CalendarConnectionsView } from "./admin/CalendarConnectionsView";
import { ScheduleView } from "./admin/ScheduleView";
import { TeamAvailabilityView } from "./admin/TeamAvailabilityView";
import type { AdminOverview, AdminWorkspaceView } from "./admin/types";

type Phase = "loading" | "unauthed" | "ready" | "failed";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  state_expired: "The connect link expired. Start the connection again.",
  no_refresh_token:
    "The provider did not return a refresh token. Remove this app from the account's authorized apps, then reconnect.",
  mock_mode: "Connect flows are disabled in mock mode.",
  unauthorized: "The admin session expired. Sign in and try connecting again.",
  bad_provider: "That connect link points at an unknown calendar provider.",
  bad_member: "That connect link points at an unknown team member.",
  config_missing:
    "The provider's OAuth credentials are not configured on the server.",
};

const NAV_ITEMS: Array<{
  id: AdminWorkspaceView;
  label: string;
  description: string;
}> = [
  {
    id: "schedule",
    label: "Schedule",
    description: "Upcoming calls and history",
  },
  {
    id: "availability",
    label: "Availability",
    description: "Compare everyone's calendar",
  },
  {
    id: "members",
    label: "Members",
    description: "People, booking rules and pages",
  },
  {
    id: "calendars",
    label: "Calendars",
    description: "Connections and busy time",
  },
];

function viewFromHash(hash: string): AdminWorkspaceView {
  const value = hash.replace(/^#/, "");
  if (value === "pages") return "members";
  return value === "availability" ||
    value === "members" ||
    value === "calendars"
    ? value
    : "schedule";
}

export function AdminPanel() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [activeView, setActiveView] = useState<AdminWorkspaceView>("schedule");
  const [rosterRevision, setRosterRevision] = useState(0);
  const [banner, setBanner] = useState<{
    tone: "ok" | "warn";
    text: string;
  } | null>(null);

  useEffect(() => {
    const syncInitialView = window.requestAnimationFrame(() => {
      setActiveView(viewFromHash(window.location.hash));
    });
    const handleHashChange = () => {
      setActiveView(viewFromHash(window.location.hash));
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.cancelAnimationFrame(syncInitialView);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  useEffect(() => {
    const syncOAuthResult = window.requestAnimationFrame(() => {
      const search = new URLSearchParams(window.location.search);
      const connected = search.get("connected");
      const error = search.get("error");
      if (connected) {
        setBanner({ tone: "ok", text: `Connected ${connected}.` });
        setActiveView("calendars");
      } else if (error) {
        setBanner({
          tone: "warn",
          text:
            OAUTH_ERROR_MESSAGES[error] ??
            "Connecting the account failed. Try again.",
        });
        setActiveView("calendars");
      }
      if (connected || error) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}#calendars`,
        );
      }
    });
    return () => window.cancelAnimationFrame(syncOAuthResult);
  }, []);

  const fetchOverview = useCallback(async (preserveExisting = false) => {
    try {
      const response = await fetch("/api/meet/admin/accounts", {
        cache: "no-store",
      });
      if (response.status === 401) {
        setOverview(null);
        setPhase("unauthed");
        return;
      }
      if (!response.ok) throw new Error(`status ${response.status}`);
      setOverview((await response.json()) as AdminOverview);
      setPhase("ready");
    } catch {
      if (preserveExisting) {
        setBanner({
          tone: "warn",
          text: "The member change was saved, but calendar readiness could not refresh. Try the Calendars tab in a moment.",
        });
      } else {
        setPhase("failed");
      }
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.requestAnimationFrame(() => {
      void fetchOverview();
    });
    return () => window.cancelAnimationFrame(initialLoad);
  }, [fetchOverview]);

  const handleUnauthorized = useCallback(() => {
    setOverview(null);
    setPhase("unauthed");
    setBanner({
      tone: "warn",
      text: "Your admin session expired. Sign in to continue.",
    });
  }, []);

  const selectView = (view: AdminWorkspaceView) => {
    setActiveView(view);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}#${view}`,
    );
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  if (phase === "loading") return <AdminLoading />;

  if (phase === "unauthed") {
    return (
      <LoginCard
        banner={banner}
        onAuthed={() => {
          setBanner(null);
          setPhase("loading");
          void fetchOverview();
        }}
      />
    );
  }

  if (phase === "failed" || !overview) {
    return (
      <AdminLoadError
        onRetry={() => {
          setPhase("loading");
          void fetchOverview();
        }}
      />
    );
  }

  const healthyMembers = overview.members.filter((member) =>
    overview.accounts.some(
      (account) =>
        account.memberKey === member.key &&
        account.status === "ok" &&
        account.selectedCalendars.length > 0,
    ),
  ).length;

  return (
    <main className="meet-admin-canvas min-h-screen bg-paper text-ink">
      <header className="sticky top-0 z-40 border-b border-hairline bg-paper/92 backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex min-h-16 items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 items-baseline gap-3">
              <h1 className="font-serif-display text-[1.7rem] font-bold leading-none tracking-[-0.035em]">
                Meet
              </h1>
              <span className="border-l border-hairline pl-3 text-xs font-medium tracking-wide text-ink-mute">
                Operations
              </span>
            </div>

            <div className="flex items-center gap-2 sm:gap-5">
              <div className="hidden items-center gap-2 text-xs text-ink-mute md:flex">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    healthyMembers === overview.members.length
                      ? "bg-status-ok"
                      : "bg-status-warn"
                  }`}
                  aria-hidden
                />
                <span>
                  {healthyMembers}/{overview.members.length} calendars ready
                  <span className="mx-2 text-hairline-strong">/</span>
                  Booking hours {overview.window.start}–{overview.window.end}{" "}
                  {overview.hostTimezone.replaceAll("_", " ")}
                </span>
              </div>
              <a
                href="/"
                target="_blank"
                rel="noreferrer"
                aria-label="Open team booking page in a new tab"
                title="Open team booking page"
                className="link-draw inline-flex h-10 w-10 items-center justify-center gap-1.5 text-sm text-ink-mute transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:h-auto sm:w-auto"
              >
                <span className="hidden sm:inline">View live page</span>
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </a>
              <ThemeToggle className="h-10! w-10! rounded-full! hover:bg-paper-raise!" />
            </div>
          </div>

          <nav
            aria-label="Meeting admin"
            className="-mb-px flex gap-7 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {NAV_ITEMS.map((item) => {
              const selected = item.id === activeView;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  onClick={() => selectView(item.id)}
                  className={`group relative flex min-h-11 shrink-0 items-center text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 ${
                    selected ? "text-ink" : "text-ink-mute hover:text-ink-soft"
                  }`}
                >
                  <span className={selected ? "font-semibold" : "font-medium"}>
                    {item.label}
                  </span>
                  <span className="sr-only">— {item.description}</span>
                  {selected && (
                    <span
                      className="absolute inset-x-0 bottom-0 h-0.5 bg-accent"
                      aria-hidden
                    />
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8 lg:py-14">
        {banner && (
          <div
            role="status"
            className={`mb-6 flex items-start justify-between gap-4 rounded-2xl border px-4 py-3.5 text-sm ${
              banner.tone === "ok"
                ? "border-status-ok/25 bg-status-ok/5 text-status-ok"
                : "border-status-warn/30 bg-status-warn/5 text-status-warn"
            }`}
          >
            <div className="flex items-start gap-2.5">
              {banner.tone === "ok" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              ) : (
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden
                />
              )}
              <p>{banner.text}</p>
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              className="shrink-0 rounded-md p-1 opacity-65 transition hover:bg-current/10 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
              onClick={() => setBanner(null)}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}

        {/* Keep every workspace mounted so drafts survive switching tabs. */}
        <div hidden={activeView !== "schedule"}>
          <ScheduleView
            onUnauthorized={handleUnauthorized}
            rosterRevision={rosterRevision}
          />
        </div>
        <div hidden={activeView !== "availability"}>
          <TeamAvailabilityView
            active={activeView === "availability"}
            hostTimezone={overview.hostTimezone}
            onUnauthorized={handleUnauthorized}
          />
        </div>
        <div hidden={activeView !== "members"}>
          <BookingPagesView
            onUnauthorized={handleUnauthorized}
            onRosterChange={() => {
              setRosterRevision((revision) => revision + 1);
              void fetchOverview(true);
            }}
          />
        </div>
        <div hidden={activeView !== "calendars"}>
          <CalendarConnectionsView
            overview={overview}
            onUnauthorized={handleUnauthorized}
            onAccountUpdate={(id, patch) => {
              setOverview((previous) =>
                previous
                  ? {
                      ...previous,
                      accounts: previous.accounts.map((account) =>
                        account.id === id ? { ...account, ...patch } : account,
                      ),
                    }
                  : previous,
              );
            }}
            onAccountDelete={(id) => {
              setOverview((previous) =>
                previous
                  ? {
                      ...previous,
                      accounts: previous.accounts.filter(
                        (account) => account.id !== id,
                      ),
                    }
                  : previous,
              );
            }}
          />
        </div>
      </div>
    </main>
  );
}

function AdminLoading() {
  return (
    <main
      className="min-h-screen bg-paper text-ink"
      aria-busy="true"
      aria-label="Loading meeting admin"
    >
      <div className="border-b border-hairline">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 motion-safe:animate-pulse rounded-xl bg-hairline" />
            <div className="h-4 w-28 motion-safe:animate-pulse rounded bg-hairline" />
          </div>
          <LoaderCircle
            className="h-5 w-5 motion-safe:animate-spin text-ink-faint"
            aria-hidden
          />
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((key) => (
            <div
              key={key}
              className="h-20 motion-safe:animate-pulse rounded-2xl bg-hairline"
            />
          ))}
        </div>
        <div className="mt-8 h-10 w-64 motion-safe:animate-pulse rounded-lg bg-hairline" />
        <div className="mt-4 h-72 motion-safe:animate-pulse rounded-3xl bg-hairline" />
      </div>
    </main>
  );
}

function AdminLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center bg-paper px-5 text-ink">
      <div className="w-full max-w-md rounded-3xl border border-hairline bg-paper-raise p-8 text-center shadow-[0_20px_60px_hsl(var(--ink)_/_0.08)]">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-status-warn/10 text-status-warn">
          <AlertTriangle className="h-5 w-5" aria-hidden />
        </span>
        <h1 className="mt-5 font-serif-display text-2xl tracking-tight">
          The workspace didn’t load
        </h1>
        <p className="mt-2 text-sm leading-6 text-ink-mute">
          Your meeting data is safe. Check the connection and try loading the
          admin workspace again.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl bg-ink px-5 text-sm font-medium text-paper transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          Try again
        </button>
      </div>
    </main>
  );
}

function LoginCard({
  onAuthed,
  banner,
}: {
  onAuthed: () => void;
  banner: { tone: "ok" | "warn"; text: string } | null;
}) {
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/meet/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? "That admin secret does not match."
            : "Sign-in failed. Try again.",
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
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-paper px-5 py-16 text-ink">
      <div
        className="pointer-events-none absolute left-1/2 top-[-18rem] h-[34rem] w-[54rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,hsl(var(--accent)_/_0.10),transparent_68%)]"
        aria-hidden
      />
      <div className="relative w-full max-w-md">
        <div className="mb-5 flex items-center justify-between px-1">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-ink text-paper shadow-[0_10px_30px_hsl(var(--ink)_/_0.16)]">
              <CalendarClock className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <p className="font-serif-display text-xl tracking-tight">
                Meet admin
              </p>
              <p className="text-[11px] text-ink-mute">
                Private scheduling workspace
              </p>
            </div>
          </div>
          <ThemeToggle />
        </div>

        <form
          className="rounded-3xl border border-hairline bg-paper-raise p-6 shadow-[0_24px_80px_hsl(var(--ink)_/_0.10)] sm:p-8"
          onSubmit={(event) => void submit(event)}
          aria-busy={pending}
        >
          <span className="grid h-11 w-11 place-items-center rounded-2xl border border-hairline bg-paper text-accent">
            <KeyRound className="h-4 w-4" aria-hidden />
          </span>
          <h1 className="mt-5 font-serif-display text-3xl tracking-tight">
            Welcome back
          </h1>
          <p className="mt-2 text-sm leading-6 text-ink-mute">
            Enter the private admin secret to manage meetings, booking pages and
            connected calendars.
          </p>

          {banner?.tone === "warn" && (
            <p className="mt-4 rounded-xl border border-status-warn/30 bg-status-warn/5 px-3 py-2.5 text-xs leading-5 text-status-warn">
              {banner.text}
            </p>
          )}

          <label
            className="mt-6 block text-xs font-semibold text-ink-soft"
            htmlFor="meet-admin-secret"
          >
            Admin secret
          </label>
          <div className="relative mt-2">
            <KeyRound
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
            <input
              id="meet-admin-secret"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              className="h-12 w-full rounded-xl border border-hairline bg-paper pl-10 pr-3 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-accent/55 focus:ring-2 focus:ring-accent/15"
              placeholder="Enter your secret"
            />
          </div>
          <button
            type="submit"
            disabled={pending || !secret}
            className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 text-sm font-semibold text-paper shadow-[0_8px_24px_hsl(var(--ink)_/_0.14)] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {pending && (
              <LoaderCircle
                className="h-4 w-4 motion-safe:animate-spin"
                aria-hidden
              />
            )}
            {pending ? "Signing in…" : "Open workspace"}
          </button>
          {error && (
            <p
              role="alert"
              className="mt-3 flex items-start gap-2 text-xs leading-5 text-status-down"
            >
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden
              />
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center gap-2 border-t border-hairline pt-5 text-[11px] leading-5 text-ink-faint">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
            The secret is exchanged for a secure, HTTP-only admin session.
          </div>
        </form>
      </div>
    </main>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { Member, SelectedCalendar } from "@/lib/meet/types";
import type { AdminAccount, AdminOverview, CalendarEntry } from "./types";

const MAX_SELECTED_CALENDARS = 20;

const BUTTON_SECONDARY =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-hairline bg-paper-raise px-3.5 py-2 text-sm font-medium text-ink-soft shadow-[0_1px_0_hsl(var(--ink)_/_0.03)] motion-safe:transition hover:border-hairline-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50";

function accountReady(account: AdminAccount): boolean {
  return account.status === "ok" && account.selectedCalendars.length > 0;
}
function providerName(provider: AdminAccount["provider"]): string {
  return provider === "google" ? "Google Calendar" : "Microsoft Outlook";
}

function providerInitial(provider: AdminAccount["provider"]): string {
  return provider === "google" ? "G" : "M";
}

function reconnectHref(account: AdminAccount): string {
  return `/api/meet/oauth/${account.provider}/start?member=${encodeURIComponent(account.memberKey)}`;
}

export function CalendarConnectionsView({
  overview,
  onAccountUpdate,
  onAccountDelete,
  onUnauthorized,
}: {
  overview: AdminOverview;
  onAccountUpdate: (id: string, patch: Partial<AdminAccount>) => void;
  onAccountDelete: (id: string) => void;
  onUnauthorized: () => void;
}) {
  const readyMembers = overview.members.filter((member) =>
    overview.accounts.some(
      (account) => account.memberKey === member.key && accountReady(account),
    ),
  );
  const attentionMembers = overview.members.filter(
    (member) => !readyMembers.some((ready) => ready.key === member.key),
  );
  const attentionAccounts = overview.accounts.filter(
    (account) => !accountReady(account),
  );
  const hasAttention =
    attentionMembers.length > 0 || attentionAccounts.length > 0;
  return (
    <div>
      <header className="flex flex-col gap-5 border-b border-hairline pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-serif-display text-4xl font-bold tracking-[-0.045em] sm:text-5xl">
            Calendars
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-ink-mute">
            Choose which calendars make each teammate busy and keep every host
            ready to take a booking.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-mute">
          <span>
            {readyMembers.length}/{overview.members.length} people ready
          </span>
          <span aria-hidden className="text-hairline-strong">
            /
          </span>
          <span>{overview.accounts.length} connected accounts</span>
        </div>
      </header>

      {hasAttention && (
        <div
          role="status"
          className="mt-7 flex items-start gap-3 border-l-2 border-status-warn bg-status-warn/[0.035] px-4 py-3.5 text-sm leading-6 text-ink-soft"
        >
          <AlertTriangle
            className="mt-1 h-4 w-4 shrink-0 text-status-warn"
            aria-hidden
          />
          <p>
            {attentionMembers.length > 0
              ? `${attentionMembers.length} teammate${attentionMembers.length === 1 ? " needs" : "s need"} a ready calendar. `
              : ""}
            {attentionAccounts.length > 0
              ? `${attentionAccounts.length} existing connection${attentionAccounts.length === 1 ? " needs" : "s need"} attention. `
              : ""}
            Reconnect expired accounts, connect missing ones, or select a
            busy-time calendar.
          </p>
        </div>
      )}

      <div className="mt-8 divide-y divide-hairline border-y border-hairline">
        {overview.members.map((member) => (
          <MemberCalendarCard
            key={member.key}
            member={member}
            accounts={overview.accounts.filter(
              (account) => account.memberKey === member.key,
            )}
            mockMode={overview.mockMode}
            onAccountUpdate={onAccountUpdate}
            onAccountDelete={onAccountDelete}
            onUnauthorized={onUnauthorized}
          />
        ))}
      </div>
      <p className="mt-5 flex items-center gap-2 text-xs leading-5 text-ink-faint">
        <ShieldCheck className="h-3.5 w-3.5 text-status-ok" aria-hidden />
        OAuth credentials stay encrypted and server-side.
      </p>
    </div>
  );
}

function MemberCalendarCard({
  member,
  accounts,
  mockMode,
  onAccountUpdate,
  onAccountDelete,
  onUnauthorized,
}: {
  member: Member;
  accounts: AdminAccount[];
  mockMode: boolean;
  onAccountUpdate: (id: string, patch: Partial<AdminAccount>) => void;
  onAccountDelete: (id: string) => void;
  onUnauthorized: () => void;
}) {
  const ready = accounts.some(accountReady);
  const watched = accounts.reduce(
    (total, account) =>
      total + (account.status === "ok" ? account.selectedCalendars.length : 0),
    0,
  );

  return (
    <section className="overflow-hidden bg-paper-raise/35">
      <div className="flex items-start justify-between gap-3 px-1 py-5 sm:gap-4 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-hairline bg-paper font-serif-display text-sm text-ink-soft"
          >
            {member.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-medium text-ink">{member.name}</h3>
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${ready ? "bg-status-ok" : "bg-status-warn"}`}
                aria-hidden
              />
            </div>
            <p className="mt-0.5 truncate text-xs text-ink-mute">
              {accounts.length === 0
                ? "No account connected"
                : `${accounts.length} account${accounts.length === 1 ? "" : "s"} · ${watched} calendar${watched === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${ready ? "text-status-ok" : "text-status-warn"}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-status-ok" : "bg-status-warn"}`}
            aria-hidden
          />
          {ready ? "Ready" : "Needs setup"}
        </span>
      </div>

      {accounts.length > 0 ? (
        <ul className="divide-y divide-hairline border-t border-hairline">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onUpdate={onAccountUpdate}
              onDelete={onAccountDelete}
              onUnauthorized={onUnauthorized}
            />
          ))}
        </ul>
      ) : (
        <div className="border-t border-hairline px-4 py-6 text-sm leading-6 text-ink-mute sm:px-5">
          Connect a work calendar so this teammate can appear in available
          meeting slots.
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-hairline px-4 py-4 sm:px-5">
        {mockMode ? (
          <p className="text-xs leading-5 text-ink-mute">
            Account connections are disabled while mock calendars are active.
          </p>
        ) : (
          <>
            <a
              href={`/api/meet/oauth/google/start?member=${encodeURIComponent(member.key)}`}
              className={BUTTON_SECONDARY}
              aria-label={`Connect Google Calendar for ${member.name}`}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Google
              <ExternalLink className="h-3 w-3 text-ink-faint" aria-hidden />
            </a>
            <a
              href={`/api/meet/oauth/microsoft/start?member=${encodeURIComponent(member.key)}`}
              className={BUTTON_SECONDARY}
              aria-label={`Connect Microsoft Outlook for ${member.name}`}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Outlook
              <ExternalLink className="h-3 w-3 text-ink-faint" aria-hidden />
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
  onUnauthorized,
}: {
  account: AdminAccount;
  onUpdate: (id: string, patch: Partial<AdminAccount>) => void;
  onDelete: (id: string) => void;
  onUnauthorized: () => void;
}) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [calendars, setCalendars] = useState<CalendarEntry[] | null>(null);
  const [calendarsLoading, setCalendarsLoading] = useState(false);
  const [calendarsError, setCalendarsError] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(account.selectedCalendars.map((calendar) => calendar.id)),
  );
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const disconnectButtonRef = useRef<HTMLButtonElement>(null);
  const confirmDeleteRef = useRef<HTMLButtonElement>(null);
  const restoreDisconnectFocusRef = useRef(false);

  useEffect(() => {
    if (confirming) {
      confirmDeleteRef.current?.focus();
      return;
    }
    if (restoreDisconnectFocusRef.current) {
      restoreDisconnectFocusRef.current = false;
      disconnectButtonRef.current?.focus();
    }
  }, [confirming]);

  const loadCalendars = async () => {
    setCalendarsLoading(true);
    setCalendarsError(null);
    try {
      const response = await fetch(
        `/api/meet/admin/accounts/${account.id}/calendars`,
        { cache: "no-store" },
      );
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (response.status === 409) {
        onUpdate(account.id, { status: "reauth_required" });
        setCalendarsError("Reconnect this account before choosing calendars.");
        return;
      }
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = (await response.json()) as { calendars: CalendarEntry[] };
      setCalendars(body.calendars);
    } catch {
      setCalendarsError("Calendars could not be loaded. Try again.");
    } finally {
      setCalendarsLoading(false);
    }
  };

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && calendars === null && !calendarsLoading) {
      void loadCalendars();
    }
  };

  const toggleCalendar = (id: string) => {
    setSaveMessage(null);
    setSaveError(null);
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Build the payload from the current provider response. This deliberately
  // drops calendars that no longer exist and refreshes names when a provider
  // has renamed a calendar.
  const selection = (calendars ?? [])
    .filter((calendar) => checked.has(calendar.id))
    .map(
      (calendar): SelectedCalendar => ({
        id: calendar.id,
        name: calendar.name,
      }),
    );
  const tooMany = selection.length > MAX_SELECTED_CALENDARS;
  const maxReached = selection.length >= MAX_SELECTED_CALENDARS;
  const changed =
    selection.length !== account.selectedCalendars.length ||
    selection.some(
      (calendar) =>
        !account.selectedCalendars.some(
          (selected) =>
            selected.id === calendar.id && selected.name === calendar.name,
        ),
    );

  const save = async () => {
    if (calendars === null || saving || tooMany || !changed) return;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const response = await fetch(`/api/meet/admin/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedCalendars: selection }),
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(`status ${response.status}`);
      onUpdate(account.id, { selectedCalendars: selection });
      setSaveMessage(
        selection.length === 0 ? "Saved selection cleared" : "Selection saved",
      );
    } catch {
      setSaveError("Could not save this selection.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/meet/admin/accounts/${account.id}`, {
        method: "DELETE",
      });
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          body &&
          typeof body === "object" &&
          "message" in body &&
          typeof (body as { message?: unknown }).message === "string"
            ? (body as { message: string }).message
            : "Could not disconnect this account.";
        throw new Error(message);
      }
      onDelete(account.id);
    } catch (error) {
      setDeleteError(
        error instanceof Error
          ? error.message
          : "Could not disconnect this account.",
      );
    } finally {
      setDeleting(false);
    }
  };

  const cancelDisconnect = () => {
    restoreDisconnectFocusRef.current = true;
    setConfirming(false);
    setDeleteError(null);
  };

  const ready = accountReady(account);
  const clearStaleSelection =
    calendars?.length === 0 && account.selectedCalendars.length > 0 && changed;

  return (
    <li className="px-4 py-4 sm:px-5">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={toggleExpanded}
        className="group -m-1 flex w-[calc(100%+0.5rem)] min-w-0 items-start gap-3 rounded-xl p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-hairline bg-paper font-mono text-[10px] uppercase text-ink-mute">
          {providerInitial(account.provider)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">
              {account.email}
            </span>
            {!ready && (
              <span className="shrink-0 rounded-full bg-status-warn/10 px-2 py-0.5 text-[10px] font-medium text-status-warn">
                {account.status === "reauth_required"
                  ? "Reconnect"
                  : "No calendars"}
              </span>
            )}
          </span>
          <span className="mt-1 block truncate text-xs text-ink-mute">
            {providerName(account.provider)} ·{" "}
            {account.selectedCalendars.length} selected
          </span>
        </span>
        <ChevronDown
          className={`mt-1 h-4 w-4 shrink-0 text-ink-faint motion-safe:transition-transform group-hover:text-ink-soft ${expanded ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {expanded && (
        <div
          id={panelId}
          className="mt-4 rounded-xl border border-hairline bg-paper/70 p-3 sm:p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">Busy calendars</p>
              <p className="mt-0.5 text-xs leading-5 text-ink-mute">
                Events here are removed from bookable time.
              </p>
            </div>
            {calendars !== null && (
              <span
                aria-live="polite"
                className="shrink-0 font-mono text-[11px] text-ink-faint"
              >
                {selection.length}/{MAX_SELECTED_CALENDARS}
              </span>
            )}
          </div>

          {account.status === "reauth_required" && (
            <div className="mt-4 flex flex-col items-start gap-3 rounded-lg border border-status-warn/25 bg-status-warn/5 px-3 py-3 text-xs leading-5 text-ink-soft sm:flex-row sm:items-center sm:justify-between">
              <span>
                The provider session expired. Reconnect to restore it.
              </span>
              <a
                href={reconnectHref(account)}
                className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg border border-status-warn/35 bg-paper-raise px-3 font-medium text-status-warn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-warn/40"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Reconnect
              </a>
            </div>
          )}

          {calendarsLoading && (
            <div
              className="mt-4 space-y-2"
              role="status"
              aria-live="polite"
              aria-label="Loading calendars"
            >
              <span className="sr-only">Loading calendars…</span>
              {[0, 1].map((key) => (
                <div
                  key={key}
                  className="h-10 rounded-lg bg-hairline motion-safe:animate-pulse"
                />
              ))}
            </div>
          )}

          {calendarsError && (
            <div
              role="alert"
              className="mt-4 flex flex-col items-start gap-2 rounded-lg bg-status-warn/5 px-3 py-2.5 text-xs leading-5 text-status-warn sm:flex-row sm:justify-between"
            >
              <span>{calendarsError}</span>
              {account.status === "ok" && (
                <button
                  type="button"
                  className="min-h-8 shrink-0 font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-warn/40"
                  onClick={() => void loadCalendars()}
                >
                  Retry
                </button>
              )}
            </div>
          )}

          {calendars && calendars.length === 0 && (
            <p className="mt-4 rounded-lg border border-dashed border-hairline px-3 py-3 text-sm leading-6 text-ink-mute">
              No calendars were found on this account.
              {account.selectedCalendars.length > 0
                ? " Save below to clear its stale calendar selection."
                : " Try reconnecting if you expected to see one."}
            </p>
          )}

          {calendars && calendars.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {calendars.map((calendar) => {
                const selected = checked.has(calendar.id);
                const disabled = saving || (!selected && maxReached);

                return (
                  <li key={calendar.id}>
                    <label
                      className={`flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-ink-soft motion-safe:transition ${
                        disabled
                          ? "cursor-not-allowed opacity-55"
                          : "cursor-pointer hover:bg-paper-raise"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={disabled}
                        onChange={() => toggleCalendar(calendar.id)}
                        className="h-4 w-4 shrink-0 rounded border-hairline accent-accent"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {calendar.name}
                      </span>
                      {calendar.primary && (
                        <span className="shrink-0 rounded-full border border-hairline px-2 py-0.5 text-[10px] text-ink-faint">
                          Primary
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {calendars !== null && (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
              <button
                type="button"
                disabled={saving || tooMany || !changed}
                onClick={() => void save()}
                className="inline-flex min-h-10 items-center rounded-xl bg-ink px-4 py-2 text-sm font-medium text-paper motion-safe:transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving
                  ? "Saving…"
                  : clearStaleSelection
                    ? "Clear saved selection"
                    : "Save calendars"}
              </button>
              {tooMany && (
                <span role="alert" className="text-xs text-status-warn">
                  Choose at most {MAX_SELECTED_CALENDARS}.
                </span>
              )}
              {maxReached && !tooMany && (
                <span className="text-xs text-ink-mute">
                  Selection limit reached.
                </span>
              )}
              {saveMessage && (
                <span
                  role="status"
                  aria-live="polite"
                  className="text-xs text-status-ok"
                >
                  {saveMessage}
                </span>
              )}
              {saveError && (
                <span role="alert" className="text-xs text-status-warn">
                  {saveError}
                </span>
              )}
            </div>
          )}

          <div className="mt-4 border-t border-hairline pt-4">
            {!confirming ? (
              <button
                ref={disconnectButtonRef}
                type="button"
                onClick={() => {
                  setConfirming(true);
                  setDeleteError(null);
                }}
                className="inline-flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs text-ink-mute motion-safe:transition hover:bg-status-down/5 hover:text-status-down focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-down/30"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Disconnect account
              </button>
            ) : (
              <div
                role="group"
                aria-label={`Confirm disconnecting ${account.email}`}
                className="flex flex-wrap items-center gap-2 text-xs"
                onKeyDown={(event) => {
                  if (event.key === "Escape" && !deleting) {
                    event.preventDefault();
                    cancelDisconnect();
                  }
                }}
              >
                <span className="w-full text-ink-soft sm:w-auto">
                  Disconnect {account.email}?
                </span>
                <button
                  ref={confirmDeleteRef}
                  type="button"
                  disabled={deleting}
                  onClick={() => void remove()}
                  className="min-h-9 rounded-lg bg-status-down px-3 font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-down/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:opacity-50"
                >
                  {deleting ? "Disconnecting…" : "Yes, disconnect"}
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={cancelDisconnect}
                  className="min-h-9 rounded-lg px-3 text-ink-mute hover:bg-paper-raise focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
                >
                  Keep it
                </button>
              </div>
            )}
            {deleteError && (
              <p
                role="alert"
                className="mt-2 text-xs leading-5 text-status-warn"
              >
                {deleteError}
              </p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

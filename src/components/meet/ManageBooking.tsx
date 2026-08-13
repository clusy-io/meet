"use client";

import { Video } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SlotPicker } from "@/components/meet/SlotPicker";
import type { BookingView } from "@/lib/meet/types";
import { SITE } from "@/meet.config";

/**
 * Self-serve booking management: cancel and reschedule via the manage token.
 * The server page loads the booking; from there everything goes through
 * /api/meet/bookings/[token]/* so this stays a plain client component.
 */

/** Weekday + date + time + zone name, e.g. "Friday, August 14, 2026 at 9:00 AM PDT". */
function formatInZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    // Unknown zone in the booking row; fall back rather than crash the page.
    return new Date(iso).toUTCString();
  }
}

/** The booking's stored zone when Intl accepts it, else the browser's guess. */
function initialTimezone(candidate: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

/** Loose structural check; the API owns the full shape. */
function isBookingView(value: unknown): value is BookingView {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    typeof b.startAt === "string" &&
    typeof b.endAt === "string" &&
    typeof b.status === "string" &&
    typeof b.manageToken === "string"
  );
}

function extractBooking(data: unknown): BookingView | null {
  if (typeof data !== "object" || data === null) return null;
  const candidate = (data as Record<string, unknown>).booking;
  return isBookingView(candidate) ? candidate : null;
}

function extractMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const message = (data as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

const SUBTLE_BUTTON =
  "rounded-md border border-hairline px-4 py-2 text-sm transition-colors hover:border-hairline-strong disabled:cursor-default disabled:opacity-50";

export default function ManageBooking({
  initial,
  hostTimezone,
}: {
  initial: BookingView;
  hostTimezone: string;
}) {
  const [booking, setBooking] = useState<BookingView>(initial);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Owned here, not in SlotPicker, so the post-409 picker remount preserves
  // the visitor's chosen timezone. Seeded from the booking's stored zone.
  const [timezone, setTimezone] = useState(() => initialTimezone(initial.timezone));
  // Remounting the picker forces a fresh availability fetch after a 409.
  const [pickerKey, setPickerKey] = useState(0);
  const noticeTimer = useRef<number | null>(null);
  const cancelHeadingRef = useRef<HTMLParagraphElement | null>(null);
  const cancelledHeadingRef = useRef<HTMLParagraphElement | null>(null);
  const rescheduleButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  function showNotice(text: string) {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }

  async function runCancel() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/meet/bookings/${booking.manageToken}/cancel`, {
        method: "POST",
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(extractMessage(data) ?? "Could not cancel the booking, please try again.");
        return;
      }
      setBooking(extractBooking(data) ?? { ...booking, status: "cancelled" });
      setConfirmingCancel(false);
      window.requestAnimationFrame(() => cancelledHeadingRef.current?.focus());
    } catch {
      setError("Could not reach the server, please try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleSelect(startIso: string) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/meet/bookings/${booking.manageToken}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: startIso, timezone }),
      });
      const data: unknown = await res.json().catch(() => null);
      if (res.status === 409) {
        setError("That time was just taken, pick another");
        setPickerKey((k) => k + 1);
        return;
      }
      if (!res.ok) {
        setError(extractMessage(data) ?? "Could not reschedule, please try again.");
        return;
      }
      const updated = extractBooking(data);
      if (updated) setBooking(updated);
      setRescheduling(false);
      showNotice("Rescheduled");
      window.requestAnimationFrame(() => rescheduleButtonRef.current?.focus());
    } catch {
      setError("Could not reach the server, please try again.");
    } finally {
      setPending(false);
    }
  }

  if (booking.status === "cancelled") {
    return (
      <section className="rounded-lg border border-hairline bg-paper-raise p-6 sm:p-8">
        <p ref={cancelledHeadingRef} tabIndex={-1} className="text-sm text-ink-mute">
          This booking was cancelled.
        </p>
        <Link
          href="/"
          className="mt-3 inline-block text-sm text-ink underline underline-offset-4 transition-opacity hover:opacity-80"
        >
          Book a new time
        </Link>
      </section>
    );
  }

  return (
    <section
      aria-busy={pending}
      className="rounded-lg border border-hairline bg-paper-raise p-6 sm:p-8"
    >
      <h1 className="font-serif-display text-xl tracking-[-0.02em] text-ink sm:text-2xl">
        Your call with the {SITE.name} team
      </h1>

      <div className="mt-5 space-y-1">
        <p className="text-sm text-ink">
          Your time: {formatInZone(booking.startAt, booking.timezone)}
        </p>
        {booking.timezone !== hostTimezone ? (
          <p className="text-sm text-ink-mute">
            {SITE.name} time: {formatInZone(booking.startAt, hostTimezone)}
          </p>
        ) : null}
        <p className="text-sm text-ink-mute">{booking.durationMinutes} minutes</p>
      </div>

      {notice ? (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-status-ok">
          {notice}
        </p>
      ) : null}

      {booking.meetingUrl ? (
        <a
          href={booking.meetingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-2 text-sm text-accent transition-colors hover:text-accent-bright"
        >
          <Video size={16} strokeWidth={1.5} aria-hidden />
          Join the video call
        </a>
      ) : null}

      <p className="mt-4 text-sm text-ink-mute">
        Booked by {booking.name} ({booking.email})
      </p>

      {confirmingCancel ? (
        <div className="mt-6 rounded-md border border-hairline p-4">
          <p ref={cancelHeadingRef} tabIndex={-1} className="text-sm text-ink">
            Cancel this booking? This notifies everyone.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setConfirmingCancel(false);
                setError(null);
                window.requestAnimationFrame(() => rescheduleButtonRef.current?.focus());
              }}
              disabled={pending}
              className={`${SUBTLE_BUTTON} text-ink`}
            >
              Keep it
            </button>
            <button
              type="button"
              onClick={runCancel}
              disabled={pending}
              className={`${SUBTLE_BUTTON} text-status-down`}
            >
              {pending ? "Cancelling..." : "Yes, cancel"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-6 flex items-center gap-3">
          <button
            ref={rescheduleButtonRef}
            type="button"
            onClick={() => {
              setRescheduling((open) => !open);
              setError(null);
            }}
            disabled={pending}
            className={`${SUBTLE_BUTTON} text-ink`}
          >
            {rescheduling ? "Keep current time" : "Reschedule"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmingCancel(true);
              setRescheduling(false);
              setError(null);
              window.requestAnimationFrame(() => cancelHeadingRef.current?.focus());
            }}
            disabled={pending}
            className={`${SUBTLE_BUTTON} text-status-down`}
          >
            Cancel booking
          </button>
        </div>
      )}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-ink-mute">
          {error}
        </p>
      ) : null}

      {rescheduling && !confirmingCancel ? (
        <div className="mt-6 border-t border-hairline pt-6">
          <p className="mb-4 text-sm text-ink-soft">Pick a new time</p>
          <SlotPicker
            key={pickerKey}
            onSelect={handleSelect}
            selecting={pending}
            manageToken={booking.manageToken}
            timezone={timezone}
            onTimezoneChange={setTimezone}
          />
        </div>
      ) : null}
    </section>
  );
}

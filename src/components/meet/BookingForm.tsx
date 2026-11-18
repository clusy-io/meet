"use client";

import {
  useId,
  type Dispatch,
  type FormEvent,
  type ReactElement,
  type SetStateAction,
} from "react";
import { ArrowRight } from "lucide-react";
import styles from "./BookingDetails.module.css";
import type { BookingView, CreateBookingRequest, MeetingType } from "@/lib/meet/types";

/**
 * Public booking details form. Owns the booking POST: 409 means the slot was
 * taken between render and submit (surfaced via onSlotTaken so the flow can
 * drop back to the picker); other failures show the server's message inline.
 */

function messageFrom(data: unknown): string | null {
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return null;
}

function bookingFrom(data: unknown): BookingView | null {
  if (data && typeof data === "object" && "booking" in data) {
    const booking = (data as { booking: unknown }).booking;
    if (booking && typeof booking === "object") return booking as BookingView;
  }
  return null;
}

export function BookingForm({
  startIso,
  timezone,
  meetingType,
  state,
  onDone,
  onSlotTaken,
  host,
}: {
  startIso: string;
  timezone: string;
  /** Event type; the server resolves its length from the page and type. */
  meetingType?: MeetingType;
  state: BookingFormState;
  onDone: (booking: BookingView) => void;
  onSlotTaken: () => void;
  /** Personal page slug; omitted books the team page. */
  host?: string;
}): ReactElement {
  const { name, email, notes, guests, guestInput, guestError, websiteUrl, pending, error } =
    state.values;
  const setName = state.setters.name;
  const setEmail = state.setters.email;
  const setNotes = state.setters.notes;
  const setGuests = state.setters.guests;
  const setGuestInput = state.setters.guestInput;
  const setGuestError = state.setters.guestError;
  const setWebsiteUrl = state.setters.websiteUrl;
  const setPending = state.setters.pending;
  const setError = state.setters.error;
  const fieldId = useId();
  const nameId = `${fieldId}-name`;
  const emailId = `${fieldId}-email`;
  const guestsId = `${fieldId}-guests`;
  const notesId = `${fieldId}-notes`;
  const honeypotId = `${fieldId}-website-url`;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const body: CreateBookingRequest = {
      start: startIso,
      name: name.trim(),
      email: email.trim(),
      timezone,
    };
    const trimmedNotes = notes.trim();
    if (trimmedNotes) body.notes = trimmedNotes;
    if (meetingType) body.meetingType = meetingType;
    if (host) body.host = host;
    if (guests.length > 0) body.guests = guests;
    if (websiteUrl) body.company = websiteUrl;

    try {
      const res = await fetch("/api/meet/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        onSlotTaken();
        return;
      }
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(messageFrom(data) ?? "Something went wrong. Please try again.");
        return;
      }
      const booking = bookingFrom(data);
      if (!booking) {
        // A 2xx without a booking is the server's silent honeypot drop. If
        // autofill tripped the honeypot, a real visitor is sitting here, so
        // surface an error instead of stranding them on a dead form.
        setError("Something went wrong. Please try again.");
        return;
      }
      onDone(booking);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };

  const GUEST_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const addGuest = (raw: string) => {
    const value = raw.trim().toLowerCase().replace(/,$/, "");
    if (!value) return;
    if (!GUEST_RE.test(value)) {
      setGuestError("That does not look like an email address.");
      return;
    }
    if (guests.includes(value) || value === email.trim().toLowerCase()) {
      setGuestInput("");
      return;
    }
    if (guests.length >= 10) {
      setGuestError("Up to 10 guests per booking.");
      return;
    }
    setGuests([...guests, value]);
    setGuestInput("");
    setGuestError(null);
  };

  return (
    <form onSubmit={handleSubmit} aria-busy={pending} className={`${styles.form} space-y-4`}>
      <div className={styles.fields}>
        <div>
          <label htmlFor={nameId} className={styles.label}>
            Name
          </label>
          <input
            id={nameId}
            name="name"
            type="text"
            autoComplete="name"
            disabled={pending}
            data-meet-name-input
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className={styles.input}
          />
        </div>

        <div>
          <label htmlFor={emailId} className={styles.label}>
            Email
          </label>
          <input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            disabled={pending}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className={styles.input}
          />
        </div>
      </div>

      <div>
        <label htmlFor={guestsId} className={styles.label}>
          Add guests <span className="font-normal text-ink-faint">(optional)</span>
        </label>
        {guests.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {guests.map((g) => (
              <li
                key={g}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-hairline bg-paper px-2.5 py-1 text-sm text-ink"
              >
                <span className="min-w-0 break-all">{g}</span>
                <button
                  type="button"
                  disabled={pending}
                  aria-label={`Remove ${g}`}
                  onClick={() => setGuests(guests.filter((x) => x !== g))}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-mute transition-colors duration-100 hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  &#215;
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          id={guestsId}
          name="guests"
          type="text"
          inputMode="email"
          autoComplete="off"
          disabled={pending}
          aria-invalid={!!guestError || undefined}
          aria-describedby={guestError ? `${guestsId}-error` : `${guestsId}-hint`}
          value={guestInput}
          onChange={(e) => {
            setGuestInput(e.target.value);
            setGuestError(null);
            if (e.target.value.endsWith(",")) addGuest(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addGuest(guestInput);
            } else if (e.key === "Backspace" && !guestInput && guests.length > 0) {
              setGuests(guests.slice(0, -1));
            }
          }}
          onBlur={() => addGuest(guestInput)}
          placeholder="guest@company.com"
          className={styles.input}
        />
        {guestError ? (
          <p id={`${guestsId}-error`} role="alert" className="mt-1 text-sm text-status-warn">
            {guestError}
          </p>
        ) : null}
        <p id={`${guestsId}-hint`} className="mt-1.5 text-xs leading-5 text-ink-mute">Press Enter to add a guest to the invite.</p>
      </div>

      <div>
        <label htmlFor={notesId} className={styles.label}>
          Anything we should know? <span className="font-normal text-ink-faint">(optional)</span>
        </label>
        <textarea
          id={notesId}
          name="notes"
          rows={3}
          disabled={pending}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Context, questions, or what you would like to cover"
          className={`${styles.input} resize-y`}
        />
      </div>

      {/* Honeypot: offscreen rather than display:none so bots still see and
          fill it, while autofill heuristics and real users never do. */}
      <div className="absolute left-[-9999px] h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor={honeypotId}>Leave this field empty</label>
        <input
          id={honeypotId}
          name="website_url"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          autoCapitalize="off"
          value={websiteUrl}
          onChange={(e) => setWebsiteUrl(e.target.value)}
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className={`${styles.primary} w-full`}
      >
        {pending ? "Booking..." : "Confirm booking"}
        {!pending && <ArrowRight size={16} aria-hidden />}
      </button>

      {error ? (
        <p role="alert" className="text-sm text-status-down">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export interface BookingFormValues {
  name: string;
  email: string;
  notes: string;
  guests: string[];
  guestInput: string;
  guestError: string | null;
  websiteUrl: string;
  pending: boolean;
  error: string | null;
}

type Setter<T> = Dispatch<SetStateAction<T>>;

export interface BookingFormState {
  values: BookingFormValues;
  setters: {
    [K in keyof BookingFormValues]: Setter<BookingFormValues[K]>;
  };
}

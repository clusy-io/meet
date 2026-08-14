"use client";

import {
  useId,
  type Dispatch,
  type FormEvent,
  type ReactElement,
  type SetStateAction,
} from "react";
import type { BookingView, CreateBookingRequest } from "@/lib/meet/types";

/**
 * Details form for /meet. Owns the booking POST: 409 means the slot was
 * taken between render and submit (surfaced via onSlotTaken so the flow can
 * drop back to the picker); other failures show the server's message inline.
 */

const INPUT_CLASS =
  "w-full rounded-md border border-hairline bg-paper-raise px-3 py-2 text-sm text-ink placeholder:text-ink-faint transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

const LABEL_CLASS = "mb-1.5 block text-sm font-medium text-ink-soft";

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
  state,
  onDone,
  onSlotTaken,
  host,
}: {
  startIso: string;
  timezone: string;
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
    if (host) body.host = host;
    const trimmedNotes = notes.trim();
    if (trimmedNotes) body.notes = trimmedNotes;
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
    <form onSubmit={handleSubmit} aria-busy={pending} className="space-y-4">
      <div>
        <label htmlFor={nameId} className={LABEL_CLASS}>
          Name
        </label>
        <input
          id={nameId}
          name="name"
          type="text"
          autoComplete="name"
          data-meet-name-input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label htmlFor={emailId} className={LABEL_CLASS}>
          Email
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className={INPUT_CLASS}
        />
      </div>

      <div>
        <label htmlFor={guestsId} className={LABEL_CLASS}>
          Add guests <span className="font-normal text-ink-faint">(optional)</span>
        </label>
        {guests.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {guests.map((g) => (
              <li
                key={g}
                className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-paper px-2.5 py-1 text-xs text-ink"
              >
                {g}
                <button
                  type="button"
                  aria-label={`Remove ${g}`}
                  onClick={() => setGuests(guests.filter((x) => x !== g))}
                  className="rounded-full text-ink-mute transition-colors duration-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
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
          placeholder="guest@company.com, press Enter to add"
          className={INPUT_CLASS}
        />
        {guestError ? (
          <p role="alert" className="mt-1 text-xs text-status-warn">
            {guestError}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-ink-faint">Guests receive the calendar invite.</p>
      </div>

      <div>
        <label htmlFor={notesId} className={LABEL_CLASS}>
          Anything we should know? <span className="font-normal text-ink-faint">(optional)</span>
        </label>
        <textarea
          id={notesId}
          name="notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Context, questions, or what you would like to cover"
          className={`${INPUT_CLASS} resize-none`}
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
        className="w-full rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        {pending ? "Booking..." : "Confirm booking"}
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

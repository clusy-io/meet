"use client";

import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { BookingView } from "@/lib/meet/types";
import { BookingForm } from "@/components/meet/BookingForm";
import { SlotPicker } from "@/components/meet/SlotPicker";
import { SITE } from "@/meet.config";

/**
 * The public booking flow: pick a slot, leave your details, get confirmed.
 * All server interaction lives in SlotPicker (availability) and BookingForm
 * (the booking POST); this component only sequences the three steps.
 */

type Step = "pick" | "done";

function formatDay(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

function formatTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function focusNameWhenVisible(attempts = 0): void {
  const visibleName = [...document.querySelectorAll<HTMLElement>("[data-meet-name-input]")].find(
    (element) => element.getClientRects().length > 0
  );
  if (visibleName) {
    visibleName.focus();
    return;
  }
  if (attempts < 60) {
    window.requestAnimationFrame(() => focusNameWhenVisible(attempts + 1));
  }
}

export default function MeetBooking() {
  const [step, setStep] = useState<Step>("pick");
  // Owned here, not in SlotPicker, so the Back-to-times step change and the
  // post-409 picker remount preserve the visitor's chosen timezone. The same
  // value is what BookingForm submits.
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [selectedStart, setSelectedStart] = useState<string | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<number | null>(null);
  const [booking, setBooking] = useState<BookingView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped to remount SlotPicker, which forces a fresh availability fetch.
  const [pickerKey, setPickerKey] = useState(0);
  const [copied, setCopied] = useState(false);
  // SlotPicker keeps a mobile and desktop presentation mounted so its stage
  // transitions stay smooth. Both form presentations use this one lifted
  // state object, so autofill and typed data survive breakpoint changes.
  const [formName, setFormName] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formGuests, setFormGuests] = useState<string[]>([]);
  const [formGuestInput, setFormGuestInput] = useState("");
  const [formGuestError, setFormGuestError] = useState<string | null>(null);
  const [formWebsiteUrl, setFormWebsiteUrl] = useState("");
  const [formPending, setFormPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const bookingFormState = useMemo(
    () => ({
      values: {
        name: formName,
        email: formEmail,
        notes: formNotes,
        guests: formGuests,
        guestInput: formGuestInput,
        guestError: formGuestError,
        websiteUrl: formWebsiteUrl,
        pending: formPending,
        error: formError,
      },
      setters: {
        name: setFormName,
        email: setFormEmail,
        notes: setFormNotes,
        guests: setFormGuests,
        guestInput: setFormGuestInput,
        guestError: setFormGuestError,
        websiteUrl: setFormWebsiteUrl,
        pending: setFormPending,
        error: setFormError,
      },
    }),
    [
      formEmail,
      formError,
      formGuestError,
      formGuestInput,
      formGuests,
      formName,
      formNotes,
      formPending,
      formWebsiteUrl,
    ]
  );

  const handleSelect = (startIso: string, _timezone: string, durationMinutes: number) => {
    setSelectedStart(startIso);
    setSelectedDuration(durationMinutes);
    setNotice(null);
    window.requestAnimationFrame(() => focusNameWhenVisible());
  };

  const handleSlotTaken = () => {
    setSelectedStart(null);
    setSelectedDuration(null);
    setNotice("That time was just taken, pick another");
    setPickerKey((k) => k + 1);
  };

  const handleDone = (b: BookingView) => {
    setBooking(b);
    setStep("done");
  };

  const copyManageLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied: the URL stays visible and selectable.
    }
  };

  if (step === "done" && booking) {
    // Only reachable after client-side interaction, so window is available;
    // the guard keeps any server prerender of this branch from crashing.
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const manageUrl = `${origin}/manage/${booking.manageToken}`;
    return (
      <section aria-live="polite" className="w-full max-w-lg">
        <div className="rounded-lg border border-hairline bg-paper-raise p-6 sm:p-8">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline">
            <Check className="h-4 w-4 text-status-ok" strokeWidth={1.5} />
          </div>

          <h1 className="font-serif-display mt-5 text-2xl font-bold tracking-tight text-ink">
            You&apos;re booked
          </h1>
          <p className="mt-2 text-sm text-ink-soft">
            {formatDay(booking.startAt, booking.timezone)} at{" "}
            {formatTime(booking.startAt, booking.timezone)} ({booking.timezone.replaceAll("_", " ")})
          </p>

          {booking.meetingUrl ? (
            <p className="mt-4 text-sm">
              <a
                href={booking.meetingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="link-draw rounded-md font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                Join the video call
              </a>
            </p>
          ) : (
            <p className="mt-4 text-sm text-ink-mute">
              The calendar invite with the video link is on its way to {booking.email}.
            </p>
          )}

          <div className="mt-6">
            <p className="text-xs font-medium text-ink-mute">
              Need to change it? Cancel or reschedule with this link:
            </p>
            <div className="mt-2 flex items-center gap-2 rounded-md border border-hairline bg-paper px-3 py-2">
              <a
                href={manageUrl}
                className="min-w-0 flex-1 truncate rounded-md font-mono text-xs text-ink-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                {manageUrl}
              </a>
              <button
                type="button"
                onClick={() => void copyManageLink(manageUrl)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-hairline px-2 py-1 text-xs font-medium text-ink transition-colors duration-150 hover:border-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-status-ok" strokeWidth={1.5} />
                ) : (
                  <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                )}
                <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
          </div>

          <p className="mt-6 text-sm text-ink-mute">A confirmation email is on its way.</p>
        </div>
      </section>
    );
  }

  const formSlot = selectedStart ? (
    <div>
      <p className="text-sm font-medium text-ink">Your details</p>
      <p className="mt-1 text-xs text-ink-mute">
        {formatDay(selectedStart, timezone)}, {formatTime(selectedStart, timezone)} (
        {timezone.replaceAll("_", " ")}), {selectedDuration ?? "—"} minutes
      </p>
      <div className="mt-4">
        <BookingForm
          startIso={selectedStart}
          timezone={timezone}
          state={bookingFormState}
          onDone={handleDone}
          onSlotTaken={handleSlotTaken}
        />
      </div>
    </div>
  ) : null;

  return (
    <section className="w-full max-w-5xl">
      <h1 className="text-center font-serif-display text-3xl font-bold tracking-tight text-ink sm:text-4xl">
        {SITE.bookingTitle}
      </h1>

      {notice ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-4 rounded-md border border-hairline bg-paper-raise px-3 py-2 text-sm text-status-warn"
        >
          {notice}
        </p>
      ) : null}

      <div className="mt-8">
        <SlotPicker
          key={pickerKey}
          onSelect={handleSelect}
          timezone={timezone}
          onTimezoneChange={setTimezone}
          selectedSlot={selectedStart}
          formSlot={formSlot}
          onClearSlot={() => {
            setSelectedStart(null);
            setSelectedDuration(null);
          }}
        />
      </div>
    </section>
  );
}

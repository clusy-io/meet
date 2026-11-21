"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Check, Clock3, Copy, Video } from "lucide-react";
import { productCta } from "@/lib/meet/cta";
import { DEFAULT_VIDEO_CHOICE, type BookingView, type MeetingType, type VideoChoice } from "@/lib/meet/types";
import { BookingForm } from "@/components/meet/BookingForm";
import { videoProviderLabels } from "./VideoCallChoice";
import shell from "./MeetShell.module.css";
import { SlotPicker } from "@/components/meet/SlotPicker";
import styles from "./BookingDetails.module.css";
import { SITE } from "@/meet.config";

/**
 * The /meet booking flow: pick a slot, leave your details, get confirmed.
 * All server interaction lives in SlotPicker (availability) and BookingForm
 * (the booking POST); this component only sequences the three steps.
 *
 * Passing `host` turns it into a personal page: availability and
 * the booking both carry that slug, so only that calendar decides and only
 * that person is invited. Without it, this is the team page.
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

function joinCallLabel(meetingUrl: string): string {
  try {
    switch (new URL(meetingUrl).origin) {
      case "https://meet.google.com":
        return "Join Google Meet";
      case "https://teams.microsoft.com":
      case "https://teams.cloud.microsoft":
      case "https://teams.live.com":
        return "Join Microsoft Teams";
    }
  } catch {
    // Older bookings can have a URL without a recognizable origin.
  }
  return "Join the video call";
}

function focusDetailsWhenVisible(selector: string, attempts = 0): void {
  const target = document.querySelector<HTMLElement>(selector);
  if (target && target.getClientRects().length > 0) {
    target.focus();
    return;
  }
  if (attempts < 60) {
    window.requestAnimationFrame(() => focusDetailsWhenVisible(selector, attempts + 1));
  }
}

export default function MeetBooking({
  host,
  headline,
  blurb,
  meetingType,
  initialDate,
  durationMinutes,
  videoProviders,
}: {
  /** Member key of the personal page; omitted renders the team page. */
  host?: string;
  headline?: string;
  blurb?: string | null;
  meetingType?: MeetingType;
  initialDate?: string;
  durationMinutes: number;
  videoProviders: VideoChoice[];
}) {
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
  const receiptTitle = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step === "done") receiptTitle.current?.focus();
  }, [step]);
  // The visitor can change the time and keep their details and video choice.
  const [selectedVideo, setSelectedVideo] = useState<VideoChoice>(DEFAULT_VIDEO_CHOICE);
  const video = videoProviders.includes(selectedVideo) ? selectedVideo : videoProviders[0];
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

  const handleSelect = (startIso: string, _timezone: string, durationMinutes: number, touchEntry = false) => {
    setSelectedStart(startIso);
    setSelectedDuration(durationMinutes);
    setNotice(null);
    const selector = touchEntry ? "[data-meet-details-heading]" : "[data-meet-name-input]";
    window.requestAnimationFrame(() => focusDetailsWhenVisible(selector));
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
    const cta = productCta();
    return (
      <section className={styles.receipt}>
        <div className={styles.card}>
          <div className="mb-4 grid h-11 w-11 place-items-center rounded-full bg-accent/10 text-accent">
            <Check size={22} strokeWidth={1.8} aria-hidden />
          </div>

          <h1 ref={receiptTitle} tabIndex={-1} className={styles.title}>
            You&apos;re booked
          </h1>
          <div className={styles.summary}>
            <p className="font-semibold text-ink">{formatDay(booking.startAt, booking.timezone)}</p>
            <p>{formatTime(booking.startAt, booking.timezone)} ({booking.timezone.replaceAll("_", " ")})</p>
            <p className="mt-1 text-ink-mute">{booking.durationMinutes} minutes</p>
          </div>

          {booking.meetingUrl ? (
            <p className="mt-4 text-sm">
              <a
                href={booking.meetingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.primary}
              >
                <Video size={16} aria-hidden />
                {joinCallLabel(booking.meetingUrl)}
              </a>
            </p>
          ) : (
            <p className="mt-4 text-sm text-ink-mute">
              Check {booking.email} for your confirmation and meeting details.
            </p>
          )}

          <div className="mt-6">
            <p className="text-xs font-medium text-ink-mute">
              Need to change it? Use this link to cancel or reschedule.
            </p>
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-hairline bg-paper py-1 pr-1 pl-3">
              <a
                href={manageUrl}
                className="min-w-0 flex-1 truncate rounded-md font-mono text-xs text-ink-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                {manageUrl}
              </a>
              <button
                type="button"
                onClick={() => void copyManageLink(manageUrl)}
                className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-ink transition-colors duration-150 hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
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

          {booking.meetingUrl && (
            <p className="mt-6 text-sm text-ink-mute">A confirmation email is on its way.</p>
          )}

          {/*
            Optional operator-configured nudge (SITE.cta). Below the card's real
            business (when, where, how to change it) and separated by a rule, so
            it reads as a footnote rather than as part of the confirmation.
          */}
          {cta ? (
            <div className="mt-6 border-t border-hairline pt-5">
              <p className="text-xs font-medium text-ink-mute">{cta.lead}</p>
              <p className="mt-1.5 text-sm text-ink-soft">{cta.body}</p>
              <a
                href={cta.href}
                target="_blank"
                rel="noopener noreferrer"
                className="link-draw mt-2.5 inline-block rounded-md text-sm font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                {cta.linkLabel}
              </a>
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  const formSlot = selectedStart && selectedDuration !== null ? (
    <div>
      <h2 data-meet-details-heading tabIndex={-1} className="font-serif-display text-2xl tracking-tight text-ink">
        Your details
      </h2>
      <div className="mt-5">
        <BookingForm
          startIso={selectedStart}
          timezone={timezone}
          meetingType={meetingType}
          state={bookingFormState}
          videoProviders={videoProviders}
          video={video}
          onVideoChange={setSelectedVideo}
          onDone={handleDone}
          onSlotTaken={handleSlotTaken}
          host={host}
        />
      </div>
    </div>
  ) : null;

  const duration = <span><Clock3 size={15} aria-hidden />{durationMinutes} min</span>;
  const renderEventHeader = (timezoneSelector: ReactNode) => (
    <header className={shell.calendarEvent}>
      <h1 className={shell.calendarTitle}>{headline ?? SITE.bookingTitle}</h1>
      {blurb && <p className={shell.calendarBlurb}>{blurb}</p>}
      {host && <div className={shell.personalDuration}>{duration}</div>}
      <div className={shell.calendarMeta}>
        {!host && duration}
        {video ? (
          <span><Video size={16} aria-hidden />{videoProviderLabels[video]}</span>
        ) : (
          <span><CalendarDays size={16} aria-hidden />Calendar invitation</span>
        )}
        {timezoneSelector}
      </div>
    </header>
  );

  return (
    <section className="w-full max-w-5xl">
      {notice ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-4 rounded-md border border-hairline bg-paper-raise px-3 py-2 text-sm text-status-warn"
        >
          {notice}
        </p>
      ) : null}

      <SlotPicker
        key={pickerKey}
        renderEventHeader={renderEventHeader}
        host={host}
        meetingType={meetingType}
        initialDate={initialDate}
        selecting={formPending}
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
    </section>
  );
}

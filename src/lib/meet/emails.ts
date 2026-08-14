import "server-only";
import { Resend } from "resend";
import { getMeetConfig, type MeetConfig } from "./config";
import { buildIcs } from "./ics";
import type { Booking, Member } from "./types";

/**
 * clusy/meet, transactional email via Resend.
 *
 * Every flow sends one email to the booker and one to the team (reply-to set
 * to the booker). Confirmation can additionally notify guests when no native
 * provider invite exists. Email is a side effect of a booking
 * that already exists. Delivery failures propagate to the lifecycle caller so
 * it can persist a degraded sync state or retry a reminder. Mock mode replaces
 * sends with one-line console summaries; production requires RESEND_API_KEY.
 * Server-only.
 */

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Booker-supplied zones come straight from the request; a junk zone must
 * degrade to UTC rather than crash the booking flow.
 */
function safeFormat(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
  }
}

/** "Thu, Aug 20, 2026, 9:00 AM GMT+2" */
function formatWhen(iso: string, timeZone: string): string {
  return safeFormat(iso, timeZone, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** "Thu, Aug 20", for subject lines. */
function formatShortDate(iso: string, timeZone: string): string {
  return safeFormat(iso, timeZone, { weekday: "short", month: "short", day: "numeric" });
}

/** Preserve the configured IANA zone in copy; do not assume a specific city. */
function hostTimeLabel(formatted: string, hostTimezone: string): string {
  return `${formatted} (${hostTimezone})`;
}

/* ------------------------------------------------------------------ */
/* Minimal single-column HTML (inline styles only; email clients        */
/* ignore <style> blocks, so the site tokens cannot be used here)      */
/* ------------------------------------------------------------------ */

const PAPER = "#faf8f5";
const INK = "#221c16";
const MUTED = "#6b6156";
const HAIRLINE = "#e6dfd6";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

function shell(inner: string): string {
  return (
    `<div style="margin:0;padding:32px 16px;background-color:${PAPER};">` +
    `<div style="max-width:560px;margin:0 auto;font-family:${FONT};font-size:14px;line-height:1.6;color:${INK};">` +
    inner +
    `</div></div>`
  );
}

function heading(text: string): string {
  return `<p style="margin:0 0 4px;font-size:19px;font-weight:600;color:${INK};">${text}</p>`;
}

function subline(text: string): string {
  return `<p style="margin:0 0 20px;font-size:14px;color:${MUTED};">${text}</p>`;
}

function hairline(): string {
  return `<hr style="border:none;border-top:1px solid ${HAIRLINE};margin:20px 0;"/>`;
}

function row(label: string, valueHtml: string): string {
  return (
    `<p style="margin:0 0 2px;font-size:12px;color:${MUTED};">${label}</p>` +
    `<div style="margin:0 0 18px;font-size:15px;color:${INK};">${valueHtml}</div>`
  );
}

function mutedLine(text: string): string {
  return `<span style="display:block;font-size:13px;color:${MUTED};">${text}</span>`;
}

function link(url: string, label?: string): string {
  return `<a href="${escapeHtml(url)}" style="color:${INK};">${escapeHtml(label ?? url)}</a>`;
}

function meetButton(url: string): string {
  return (
    `<a href="${escapeHtml(url)}" style="display:inline-block;margin-top:2px;` +
    `background-color:${INK};color:${PAPER};text-decoration:none;border-radius:6px;` +
    `padding:10px 16px;font-size:14px;font-weight:500;">Join the video call</a>`
  );
}

function manageBlock(manageUrl: string): string {
  return (
    hairline() +
    `<p style="margin:0;font-size:13px;color:${MUTED};">Need to change it? Reschedule or cancel:<br/>${link(manageUrl)}</p>`
  );
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

interface OutboundEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments: Array<{ filename: string; content: Buffer }>;
}

/**
 * Attending members resolved through the caller-supplied member list
 * (config.members). Empty or unresolvable attendee keys fall back to the
 * whole team so a booking never goes unannounced.
 */
function attendingMembers(booking: Booking, members: Member[]): Member[] {
  const attending = booking.attendeeMemberKeys
    .map((key) => members.find((m) => m.key === key))
    .filter((m): m is Member => m !== undefined);
  return attending.length > 0 ? attending : members;
}

/**
 * Who receives the team copy: every configured member, not only the ones
 * attending. A new booking, a move, a cancellation and an approaching call
 * are team news, so all configured addresses hear about them; the body's
 * "Attending" row still says who is expected in the room. Deduped and
 * lowercased so a member listed twice cannot double-send.
 */
export function teamRecipients(members: Member[]): string[] {
  const seen = new Set<string>();
  for (const member of members) {
    const email = member.email.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

/**
 * Who gets the internal copy for THIS booking.
 *
 * The team page tells every member. A personal page tells only its owner: a
 * call booked on one person's page is theirs, and fanning it out to everyone
 * is exactly the noise personal pages exist to avoid.
 *
 * Every lifecycle mail routes through here rather than calling
 * teamRecipients(config.members) directly, because that reads the GLOBAL
 * roster and ignores the `members` argument its callers pass — narrowing at
 * the call sites would change only the body's "Attending" row while still
 * mailing everyone, and every existing test would stay green.
 *
 * An unresolvable page key falls back to the whole team: a booking must never
 * go unannounced.
 */
function noticeRecipients(config: MeetConfig, booking: Booking): string[] {
  if (!booking.pageKey) return teamRecipients(config.members);
  const host = config.members.find((m) => m.key === booking.pageKey);
  return teamRecipients(host ? [host] : config.members);
}

/** The member whose personal page took this booking, if any. */
function pageHost(config: MeetConfig, booking: Booking): Member | undefined {
  if (!booking.pageKey) return undefined;
  return config.members.find((m) => m.key === booking.pageKey);
}

/**
 * Who the booker is meeting, in their confirmation: the team for the team
 * page, that person's name for a personal one.
 */
function withLabel(config: MeetConfig, booking: Booking, capitalized: boolean): string {
  const host = pageHost(config, booking);
  if (host) return host.name;
  return `${capitalized ? "The" : "the"} ${config.brandName} team`;
}

/** Where "book another time" sends them: back to the page they came from. */
function bookAgainUrl(config: MeetConfig, booking: Booking): string {
  return booking.pageKey ? `${config.siteOrigin}/${booking.pageKey}` : config.siteOrigin;
}

async function deliver(resend: Resend, from: string, mail: OutboundEmail): Promise<void> {
  const { error } = await resend.emails.send({
    from,
    to: mail.to,
    replyTo: mail.replyTo,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    attachments: mail.attachments,
  });
  if (error) {
    throw new Error(`meet email provider rejected "${mail.subject}"`);
  }
}

async function sendPair(
  booker: OutboundEmail,
  team: OutboundEmail,
  additional: OutboundEmail[] = []
): Promise<void> {
  const config = getMeetConfig();
  const apiKey = process.env.RESEND_API_KEY;
  const mails = [booker, team, ...additional];
  if (config.mockMode) {
    for (const mail of mails) {
      console.log(`meet email skipped (mock mode): "${mail.subject}" -> ${mail.to.join(", ")}`);
    }
    return;
  }
  if (!apiKey) throw new Error("meet: RESEND_API_KEY is not configured");
  const resend = new Resend(apiKey);
  await Promise.all(mails.map((mail) => deliver(resend, config.emailFrom, mail)));
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function sendBookingConfirmed(
  booking: Booking,
  members: Member[],
  options: { notifyGuestsDirectly?: boolean } = {}
): Promise<void> {
  try {
    const config = getMeetConfig();
    const attending = attendingMembers(booking, members);
    const manageUrl = `${config.siteOrigin}/manage/${booking.manageToken}`;
    const whenLocal = formatWhen(booking.startAt, booking.timezone);
    const whenHost = formatWhen(booking.startAt, config.hostTimezone);
    const attachments = [{ filename: "invite.ics", content: Buffer.from(buildIcs(booking, "REQUEST")) }];

    const whereHtml = booking.meetingUrl
      ? meetButton(booking.meetingUrl)
      : `No video link is available yet. Contact the ${escapeHtml(config.brandName)} team for joining details.`;
    const whereText =
      booking.meetingUrl ??
      `No video link is available yet. Contact ${withLabel(config, booking, false)} for joining details.`;

    const booker: OutboundEmail = {
      to: [booking.email],
      subject: `Confirmed: ${config.brandName} intro call, ${formatShortDate(booking.startAt, booking.timezone)}`,
      html: shell(
        heading("Your call is confirmed") +
          subline(`${escapeHtml(config.brandName)} intro call, ${booking.durationMinutes} minutes.`) +
          hairline() +
          row(
            "When",
            escapeHtml(whenLocal) +
              mutedLine(escapeHtml(hostTimeLabel(whenHost, config.hostTimezone)))
          ) +
          row("Where", whereHtml) +
          row("With", escapeHtml(withLabel(config, booking, true))) +
          (booking.guests.length > 0
            ? row("Guests", booking.guests.map(escapeHtml).join("<br/>"))
            : "") +
          manageBlock(manageUrl)
      ),
      text: [
        "Your call is confirmed",
        `${config.brandName} intro call, ${booking.durationMinutes} minutes.`,
        "",
        `When: ${whenLocal}`,
        hostTimeLabel(whenHost, config.hostTimezone),
        `Where: ${whereText}`,
        `With: ${withLabel(config, booking, false)}`,
        "",
        "Need to change it? Reschedule or cancel:",
        manageUrl,
      ].join("\n"),
      attachments,
    };

    const attendingNames = attending.map((m) => m.name).join(", ");
    const notesHtml = booking.notes ? escapeHtml(booking.notes).replace(/\n/g, "<br/>") : "None";
    const team: OutboundEmail = {
      to: noticeRecipients(config, booking),
      replyTo: booking.email,
      subject: `New booking: ${booking.name}, ${whenHost}`,
      html: shell(
        heading("New booking") +
          hairline() +
          row(
            "When",
            escapeHtml(whenHost) +
              mutedLine(`${escapeHtml(whenLocal)} for ${escapeHtml(booking.name)}`)
          ) +
          row("Who", escapeHtml(booking.name) + mutedLine(escapeHtml(booking.email))) +
          row("Notes", notesHtml) +
          row("Attending", escapeHtml(attendingNames)) +
          (booking.guests.length > 0
            ? row("Guests", booking.guests.map(escapeHtml).join("<br/>"))
            : "") +
          row("Where", booking.meetingUrl ? link(booking.meetingUrl) : "No video link yet")
      ),
      text: [
        "New booking",
        "",
        `When: ${whenHost}`,
        `${whenLocal} for ${booking.name}`,
        `Who: ${booking.name} <${booking.email}>`,
        `Notes: ${booking.notes ?? "None"}`,
        `Attending: ${attendingNames}`,
        `Where: ${booking.meetingUrl ?? "No video link yet"}`,
      ].join("\n"),
      attachments,
    };

    // Provider-created events already notify guests. When event creation
    // fails entirely, send each guest an individual fallback so addresses are
    // not disclosed to one another and the bearer manage URL stays booker-only.
    const guestFallbacks: OutboundEmail[] = options.notifyGuestsDirectly
      ? booking.guests.map((guest) => ({
          to: [guest],
          replyTo: booking.email,
          subject: `Invitation: ${config.brandName} intro call, ${formatShortDate(booking.startAt, config.hostTimezone)}`,
          html: shell(
            heading(`${escapeHtml(booking.name)} invited you to a call`) +
              subline(`${escapeHtml(config.brandName)} intro call, ${booking.durationMinutes} minutes.`) +
              hairline() +
              row("When", escapeHtml(hostTimeLabel(whenHost, config.hostTimezone))) +
              row("Where", whereHtml)
          ),
          text: [
            `${booking.name} invited you to a call`,
            `${config.brandName} intro call, ${booking.durationMinutes} minutes.`,
            "",
            `When: ${hostTimeLabel(whenHost, config.hostTimezone)}`,
            `Where: ${whereText}`,
          ].join("\n"),
          attachments,
        }))
      : [];

    await sendPair(booker, team, guestFallbacks);
  } catch (err) {
    console.error("meet email: confirmation send failed", err);
    throw err;
  }
}

export async function sendBookingCancelled(booking: Booking, members: Member[]): Promise<void> {
  try {
    const config = getMeetConfig();
    const attending = attendingMembers(booking, members);
    const whenLocal = formatWhen(booking.startAt, booking.timezone);
    const whenHost = formatWhen(booking.startAt, config.hostTimezone);
    const attachments = [{ filename: "invite.ics", content: Buffer.from(buildIcs(booking, "CANCEL")) }];
    const bookUrl = bookAgainUrl(config, booking);

    const booker: OutboundEmail = {
      to: [booking.email],
      subject: `Cancelled: ${config.brandName} intro call`,
      html: shell(
        heading("Your call is cancelled") +
          `<p style="margin:12px 0 0;">The ${escapeHtml(config.brandName)} intro call scheduled for ${escapeHtml(whenLocal)} is cancelled.</p>` +
          hairline() +
          `<p style="margin:0;font-size:13px;color:${MUTED};">Want to find another time? Book again:<br/>${link(bookUrl)}</p>`
      ),
      text: [
        "Your call is cancelled",
        "",
        `The ${config.brandName} intro call scheduled for ${whenLocal} is cancelled.`,
        "",
        "Want to find another time? Book again:",
        bookUrl,
      ].join("\n"),
      attachments,
    };

    const attendingNames = attending.map((m) => m.name).join(", ");
    const team: OutboundEmail = {
      to: noticeRecipients(config, booking),
      replyTo: booking.email,
      subject: `Cancelled: ${booking.name}, ${whenHost}`,
      html: shell(
        heading("Booking cancelled") +
          hairline() +
          row("When", escapeHtml(whenHost)) +
          row("Who", escapeHtml(booking.name) + mutedLine(escapeHtml(booking.email))) +
          row("Was attending", escapeHtml(attendingNames))
      ),
      text: [
        "Booking cancelled",
        "",
        `When: ${whenHost}`,
        `Who: ${booking.name} <${booking.email}>`,
        `Was attending: ${attendingNames}`,
      ].join("\n"),
      attachments,
    };

    await sendPair(booker, team);
  } catch (err) {
    console.error("meet email: cancellation send failed", err);
    throw err;
  }
}

export async function sendBookingRescheduled(
  booking: Booking,
  members: Member[],
  previousStartAt: string
): Promise<void> {
  try {
    const config = getMeetConfig();
    const attending = attendingMembers(booking, members);
    const manageUrl = `${config.siteOrigin}/manage/${booking.manageToken}`;
    const whenLocal = formatWhen(booking.startAt, booking.timezone);
    const whenHost = formatWhen(booking.startAt, config.hostTimezone);
    const prevLocal = formatWhen(previousStartAt, booking.timezone);
    const prevHost = formatWhen(previousStartAt, config.hostTimezone);
    const attachments = [{ filename: "invite.ics", content: Buffer.from(buildIcs(booking, "REQUEST")) }];

    const whereHtml = booking.meetingUrl
      ? meetButton(booking.meetingUrl)
      : `No video link is available yet. Contact the ${escapeHtml(config.brandName)} team for joining details.`;
    const whereText =
      booking.meetingUrl ??
      `No video link is available yet. Contact ${withLabel(config, booking, false)} for joining details.`;

    const booker: OutboundEmail = {
      to: [booking.email],
      subject: `Rescheduled: ${config.brandName} intro call, ${formatShortDate(booking.startAt, booking.timezone)}`,
      html: shell(
        heading("Your call is rescheduled") +
          subline(`${escapeHtml(config.brandName)} intro call, ${booking.durationMinutes} minutes.`) +
          hairline() +
          row(
            "When",
            escapeHtml(whenLocal) +
              mutedLine(escapeHtml(hostTimeLabel(whenHost, config.hostTimezone))) +
              mutedLine(`Previously ${escapeHtml(prevLocal)}`)
          ) +
          row("Where", whereHtml) +
          row("With", escapeHtml(withLabel(config, booking, true))) +
          manageBlock(manageUrl)
      ),
      text: [
        "Your call is rescheduled",
        `${config.brandName} intro call, ${booking.durationMinutes} minutes.`,
        "",
        `When: ${whenLocal}`,
        hostTimeLabel(whenHost, config.hostTimezone),
        `Previously ${prevLocal}`,
        `Where: ${whereText}`,
        `With: ${withLabel(config, booking, false)}`,
        "",
        "Need to change it? Reschedule or cancel:",
        manageUrl,
      ].join("\n"),
      attachments,
    };

    const attendingNames = attending.map((m) => m.name).join(", ");
    const team: OutboundEmail = {
      to: noticeRecipients(config, booking),
      replyTo: booking.email,
      subject: `Rescheduled: ${booking.name}, ${whenHost}`,
      html: shell(
        heading("Booking rescheduled") +
          hairline() +
          row("When", escapeHtml(whenHost) + mutedLine(`Previously ${escapeHtml(prevHost)}`)) +
          row("Who", escapeHtml(booking.name) + mutedLine(escapeHtml(booking.email))) +
          row("Attending", escapeHtml(attendingNames)) +
          row("Where", booking.meetingUrl ? link(booking.meetingUrl) : "No video link yet")
      ),
      text: [
        "Booking rescheduled",
        "",
        `When: ${whenHost}`,
        `Previously ${prevHost}`,
        `Who: ${booking.name} <${booking.email}>`,
        `Attending: ${attendingNames}`,
        `Where: ${booking.meetingUrl ?? "No video link yet"}`,
      ].join("\n"),
      attachments,
    };

    await sendPair(booker, team);
  } catch (err) {
    console.error("meet email: reschedule send failed", err);
    throw err;
  }
}

export async function sendBookingReminder(
  booking: Booking,
  members: Member[],
  kind: string,
  phrase: string
): Promise<void> {
  try {
    const config = getMeetConfig();
    const attending = attendingMembers(booking, members);
    const manageUrl = `${config.siteOrigin}/manage/${booking.manageToken}`;
    const whenLocal = formatWhen(booking.startAt, booking.timezone);
    const whenHost = formatWhen(booking.startAt, config.hostTimezone);

    const whereHtml = booking.meetingUrl
      ? meetButton(booking.meetingUrl)
      : `No video link is on file. Contact the ${escapeHtml(config.brandName)} team for joining details.`;
    const whereText =
      booking.meetingUrl ??
      `No video link is on file. Contact ${withLabel(config, booking, false)} for joining details.`;

    const booker: OutboundEmail = {
      to: [booking.email],
      subject: `Reminder: ${config.brandName} call ${phrase}`,
      html: shell(
        heading(`Your call is ${phrase}`) +
          subline(`${escapeHtml(config.brandName)} intro call, ${booking.durationMinutes} minutes.`) +
          hairline() +
          row(
            "When",
            escapeHtml(whenLocal) +
              mutedLine(escapeHtml(hostTimeLabel(whenHost, config.hostTimezone)))
          ) +
          row("Where", whereHtml) +
          manageBlock(manageUrl)
      ),
      text: [
        `Your call is ${phrase}`,
        `${config.brandName} intro call, ${booking.durationMinutes} minutes.`,
        "",
        `When: ${whenLocal}`,
        hostTimeLabel(whenHost, config.hostTimezone),
        `Where: ${whereText}`,
        "",
        "Need to change it? Reschedule or cancel:",
        manageUrl,
      ].join("\n"),
      attachments: [],
    };

    const attendingNames = attending.map((m) => m.name).join(", ");
    const team: OutboundEmail = {
      to: noticeRecipients(config, booking),
      replyTo: booking.email,
      subject: `Reminder: ${booking.name} ${phrase}, ${formatShortDate(booking.startAt, config.hostTimezone)}`,
      html: shell(
        heading(`Call with ${escapeHtml(booking.name)} ${phrase}`) +
          hairline() +
          row(
            "When",
            escapeHtml(whenHost) + mutedLine(`${escapeHtml(whenLocal)} for ${escapeHtml(booking.name)}`)
          ) +
          row("Who", escapeHtml(booking.name) + mutedLine(escapeHtml(booking.email))) +
          row("Attending", escapeHtml(attendingNames)) +
          row("Where", booking.meetingUrl ? link(booking.meetingUrl) : "No video link on file")
      ),
      text: [
        `Call with ${booking.name} ${phrase}`,
        "",
        `When: ${whenHost}`,
        `${whenLocal} for ${booking.name}`,
        `Who: ${booking.name} <${booking.email}>`,
        `Attending: ${attendingNames}`,
        `Where: ${booking.meetingUrl ?? "No video link on file"}`,
      ].join("\n"),
      attachments: [],
    };

    await sendPair(booker, team);
  } catch (err) {
    console.error(`meet email: ${kind} reminder send failed`, err);
    throw err;
  }
}

import { getMeetConfig } from "./config";
import type { Booking } from "./types";

/**
 * clusy/meet: RFC 5545 ICS payloads for booking emails.
 *
 * Hand-rolled on purpose (no dependency): we emit exactly one VEVENT with a
 * stable UID, so mail clients thread REQUEST and CANCEL onto the same event.
 * SEQUENCE tracks reschedules via the booking's history length.
 */

/** Escape TEXT values per RFC 5545 3.3.11: backslash, newline, semicolon, comma. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** Epoch ms -> UTC basic format, e.g. 20260812T173000Z. */
function utcBasic(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Fold a content line to 75 octets per line (RFC 5545 3.1), continuation
 * lines prefixed with a single space. Splits on UTF-8 byte boundaries so a
 * multi-byte character is never cut in half.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let start = 0;
  // First line carries 75 octets; continuations lose one to the leading space.
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;
  }
  return chunks.join("\r\n ");
}

export function buildIcs(booking: Booking, method: "REQUEST" | "CANCEL"): string {
  const config = getMeetConfig();
  const uidHost = new URL(config.siteOrigin).hostname;
  const summary = config.eventTitle.split("{name}").join(booking.name);
  // ICS attachments are sent to both the booker and the team. The management
  // URL is a bearer capability, so it belongs only in the booker's email body.
  const description = [config.eventDescription, booking.meetingUrl ? `Join: ${booking.meetingUrl}` : null]
    .filter((line): line is string => line !== null)
    .join("\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${escapeText(config.brandName)}//Meet//EN`,
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${booking.id}@${uidHost}`,
    `SEQUENCE:${booking.history.length}`,
    `DTSTAMP:${utcBasic(Date.now())}`,
    `DTSTART:${utcBasic(Date.parse(booking.startAt))}`,
    `DTEND:${utcBasic(Date.parse(booking.endAt))}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `LOCATION:${escapeText(booking.meetingUrl ?? "")}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

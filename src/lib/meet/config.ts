import "server-only";
import type { Member } from "./types";

/**
 * clusy/meet — runtime configuration.
 *
 * Everything is env-driven. Mock mode has safe example defaults; production
 * fails closed when identity, origin, or sender configuration is missing.
 * Server-only (reads process.env); never import from client components.
 */

export interface MeetConfig {
  /** Host timezone the availability window is defined in. */
  hostTimezone: string;
  /** Bookable window, minutes from midnight in hostTimezone. */
  windowStartMin: number; // 8:30 -> 510
  windowEndMin: number; // 22:00 -> 1320
  /** ISO weekday numbers that are bookable (1=Mon .. 7=Sun). */
  bookableWeekdays: number[];
  /** Meeting length and slot grid step, minutes. */
  durationMinutes: number;
  slotStepMinutes: number;
  /** Earliest bookable moment: now + minNoticeMinutes. */
  minNoticeMinutes: number;
  /** Latest bookable day: today + horizonDays (host tz). */
  horizonDays: number;
  /** Members whose calendars gate availability. */
  members: Member[];
  /** Slot is shown when at least this many members are free. */
  quorum: number;
  /** Event copy. */
  eventTitle: string;
  eventDescription: string;
  brandName: string;
  /** Absolute origin for links in emails, e.g. https://meet.example.com */
  siteOrigin: string;
  /** Resend "from" for booking emails. */
  emailFrom: string;
  /** Bearer credential accepted only by the reminder endpoint. */
  cronSecret: string | null;
  /** Secret gating /admin (compared in constant time). */
  adminSecret: string | null;
  /** 32-byte secret for token encryption + state signing (hex or utf8). */
  tokenSecret: string | null;
  /** In-memory everything: fake calendars, no external calls. For dev/demo. */
  mockMode: boolean;
}

const MOCK_MEMBERS: Member[] = [
  { key: "founder", name: "Founder", email: "founder@example.com" },
];

function requiredProductionEnv(name: string, mockFallback: string, mockMode: boolean): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (mockMode) return mockFallback;
  throw new Error(`meet: ${name} is required outside mock mode`);
}

function secretEnv(name: string, minimum: number, mockMode: boolean): string | null {
  const value = process.env[name]?.trim();
  if (!value) {
    if (mockMode) return null;
    throw new Error(`meet: ${name} is required outside mock mode`);
  }
  if (value.length < minimum) {
    throw new Error(`meet: ${name} must be at least ${minimum} characters`);
  }
  return value;
}

function validateProductionServices(mockMode: boolean): void {
  if (mockMode) return;
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY"] as const) {
    if (!process.env[name]?.trim()) throw new Error(`meet: ${name} is required outside mock mode`);
  }
  const googleId = process.env.MEET_GOOGLE_CLIENT_ID?.trim();
  const googleSecret = process.env.MEET_GOOGLE_CLIENT_SECRET?.trim();
  const microsoftId = process.env.MEET_MICROSOFT_CLIENT_ID?.trim();
  const microsoftSecret = process.env.MEET_MICROSOFT_CLIENT_SECRET?.trim();
  if (Boolean(googleId) !== Boolean(googleSecret)) {
    throw new Error("meet: Google OAuth client id and secret must be configured together");
  }
  if (Boolean(microsoftId) !== Boolean(microsoftSecret)) {
    throw new Error("meet: Microsoft OAuth client id and secret must be configured together");
  }
  if ((!googleId || !googleSecret) && (!microsoftId || !microsoftSecret)) {
    throw new Error("meet: configure at least one Google or Microsoft OAuth client");
  }
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`meet: ${name} must be an integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`meet: ${name} must be a safe integer`);
  }
  return n;
}

/** "HH:MM" -> minutes from midnight. `24:00` is accepted as an end bound. */
function timeEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`meet: ${name} must be an HH:MM time`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) {
    throw new Error(`meet: ${name} must be between 00:00 and 24:00`);
  }
  return hour * 60 + minute;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function siteOriginEnv(mockMode: boolean): string {
  const raw = requiredProductionEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000", mockMode);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("meet: NEXT_PUBLIC_SITE_URL must be an absolute URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("meet: NEXT_PUBLIC_SITE_URL must be a bare http(s) origin");
  }
  if (!mockMode && url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("meet: NEXT_PUBLIC_SITE_URL must use HTTPS outside local development");
  }
  return url.origin;
}

/** Resend accepts either address@example.com or "Display name <address@example.com>". */
function emailFromEnv(mockMode: boolean): string {
  const value = requiredProductionEnv(
    "MEET_EMAIL_FROM",
    "Clusy Meet <meet@example.com>",
    mockMode
  );
  if (!value || /[\r\n]/.test(value)) {
    throw new Error("meet: MEET_EMAIL_FROM must be a single-line sender address");
  }
  const bracketed = /^[^<>]*<([^<>]+)>$/.exec(value);
  const address = (bracketed?.[1] ?? value).trim();
  if (!EMAIL_RE.test(address)) {
    throw new Error("meet: MEET_EMAIL_FROM must contain a valid email address");
  }
  return value;
}

/**
 * MEET_MEMBERS='[{"key":"owner","name":"Owner","email":"owner@example.com"}]'
 * An explicitly configured value is validated strictly: silently falling
 * back to the founders can route private booking mail to the wrong people.
 */
function membersEnv(mockMode: boolean): Member[] {
  const raw = process.env.MEET_MEMBERS;
  if (!raw) {
    if (mockMode) return MOCK_MEMBERS;
    throw new Error("meet: MEET_MEMBERS is required outside mock mode");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("meet: MEET_MEMBERS must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("meet: MEET_MEMBERS must be a non-empty array");
  }

  const members: Member[] = parsed.map((value, index) => {
    if (typeof value !== "object" || value === null) {
      throw new Error(`meet: MEET_MEMBERS[${index}] must be an object`);
    }
    const candidate = value as Partial<Member>;
    const key = typeof candidate.key === "string" ? candidate.key.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const email = typeof candidate.email === "string" ? candidate.email.trim().toLowerCase() : "";
    if (!key || !name || !EMAIL_RE.test(email)) {
      throw new Error(`meet: MEET_MEMBERS[${index}] must have a key, name, and valid email`);
    }
    return { key, name, email };
  });

  const keys = new Set<string>();
  const emails = new Set<string>();
  for (const member of members) {
    if (keys.has(member.key)) throw new Error(`meet: duplicate member key "${member.key}"`);
    if (emails.has(member.email)) throw new Error(`meet: duplicate member email "${member.email}"`);
    keys.add(member.key);
    emails.add(member.email);
  }
  return members;
}

let cached: MeetConfig | null = null;

export function getMeetConfig(): MeetConfig {
  if (cached) return cached;
  const mockMode = process.env.MEET_MOCK_MODE === "1";
  validateProductionServices(mockMode);
  const members = membersEnv(mockMode);
  const hostTimezone = requiredProductionEnv(
    "MEET_HOST_TIMEZONE",
    "America/Los_Angeles",
    mockMode
  );
  if (!validTimezone(hostTimezone)) {
    throw new Error(`meet: MEET_HOST_TIMEZONE is not a valid IANA timezone: ${hostTimezone}`);
  }
  const windowStartMin = timeEnv("MEET_WINDOW_START", 8 * 60 + 30);
  const windowEndMin = timeEnv("MEET_WINDOW_END", 22 * 60);
  if (windowStartMin >= windowEndMin) {
    throw new Error("meet: MEET_WINDOW_START must be before MEET_WINDOW_END");
  }
  const durationMinutes = intEnv("MEET_DURATION_MINUTES", 30);
  const slotStepMinutes = intEnv("MEET_SLOT_STEP_MINUTES", 30);
  if (durationMinutes <= 0 || durationMinutes > windowEndMin - windowStartMin) {
    throw new Error("meet: MEET_DURATION_MINUTES must be positive and fit inside the booking window");
  }
  if (slotStepMinutes < durationMinutes) {
    throw new Error("meet: MEET_SLOT_STEP_MINUTES must be at least MEET_DURATION_MINUTES");
  }
  const minNoticeMinutes = intEnv("MEET_MIN_NOTICE_MINUTES", 4 * 60);
  if (minNoticeMinutes < 0) {
    throw new Error("meet: MEET_MIN_NOTICE_MINUTES cannot be negative");
  }
  const horizonDays = intEnv("MEET_HORIZON_DAYS", 21);
  if (horizonDays < 0 || horizonDays > 366) {
    throw new Error("meet: MEET_HORIZON_DAYS must be between 0 and 366");
  }
  const quorum = intEnv("MEET_QUORUM", Math.min(2, members.length));
  if (quorum < 1 || quorum > members.length) {
    throw new Error(`meet: MEET_QUORUM must be between 1 and ${members.length}`);
  }

  cached = {
    hostTimezone,
    windowStartMin,
    windowEndMin,
    bookableWeekdays: [1, 2, 3, 4, 5],
    durationMinutes,
    slotStepMinutes,
    minNoticeMinutes,
    horizonDays,
    members,
    quorum,
    eventTitle: requiredProductionEnv("MEET_EVENT_TITLE", "Clusy <> {name}", mockMode),
    eventDescription: requiredProductionEnv(
      "MEET_EVENT_DESCRIPTION",
      "Intro call booked with Clusy Meet.",
      mockMode
    ),
    brandName: requiredProductionEnv("MEET_BRAND_NAME", "Clusy", mockMode),
    siteOrigin: siteOriginEnv(mockMode),
    emailFrom: emailFromEnv(mockMode),
    cronSecret: secretEnv("CRON_SECRET", 24, mockMode),
    adminSecret: secretEnv("MEET_ADMIN_SECRET", 24, mockMode),
    tokenSecret: secretEnv("MEET_TOKEN_SECRET", 32, mockMode),
    mockMode,
  };
  return cached;
}

/** Test hook. */
export function __resetMeetConfigCache(): void {
  cached = null;
}

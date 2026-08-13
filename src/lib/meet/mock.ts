import { getMeetConfig } from "./config";
import { getMeetStore } from "./store";
import { addCivilDays, formatCivilDate, utcToWall, wallToUtcMs } from "./tz";
import type {
  BusyInterval,
  CalendarProvider,
  CalendarProviderId,
  CreatedEvent,
  CreateEventInput,
} from "./types";

/**
 * clusy/meet: mock calendars for MEET_MOCK_MODE.
 *
 * Busy time is a pure function of (memberKey, host-tz civil date): the same
 * day always renders the same blocks, so demos and screenshots are stable
 * across reloads while members still differ from each other. No Math.random,
 * no external calls, no secrets: refresh tokens are the raw string
 * "mock:<memberKey>" and are never encrypted.
 */

/* ------------------------------------------------------------------ */
/* Deterministic pseudo-randomness                                     */
/* ------------------------------------------------------------------ */

/** FNV-1a 32-bit hash: tiny, stable across runtimes. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** xorshift32 step; the guard keeps the sequence out of the zero fixpoint. */
function nextSeed(seed: number): number {
  let s = seed || 0x9e3779b9;
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return s >>> 0;
}

/** Nine lowercase letters as xxx-xxx-xxx, shaped like a Meet code. */
function meetCode(seed: number): string {
  let s = seed;
  const letters: string[] = [];
  for (let i = 0; i < 9; i++) {
    s = nextSeed(s);
    letters.push(String.fromCharCode(97 + (s % 26)));
  }
  return `${letters.slice(0, 3).join("")}-${letters.slice(3, 6).join("")}-${letters.slice(6, 9).join("")}`;
}

/* ------------------------------------------------------------------ */
/* Fake busy time                                                      */
/* ------------------------------------------------------------------ */

const MOCK_TOKEN_PREFIX = "mock:";

function memberKeyFromToken(refreshToken: string): string {
  return refreshToken.startsWith(MOCK_TOKEN_PREFIX)
    ? refreshToken.slice(MOCK_TOKEN_PREFIX.length)
    : refreshToken;
}

/**
 * 2-3 busy blocks of 60-120 minutes per weekday, laid out between 08:00 and
 * 20:00 host time on a 15-minute grid (off the 30-minute slot grid on
 * purpose, so some slots are only partially blocked, like real calendars).
 * With three members and quorum 2 plenty of slots stay free, but days and
 * hours differ per member.
 */
async function mockGetBusy(
  refreshToken: string,
  _calendarIds: string[],
  fromMs: number,
  toMs: number
): Promise<BusyInterval[]> {
  const { hostTimezone } = getMeetConfig();
  const memberKey = memberKeyFromToken(refreshToken);
  const out: BusyInterval[] = [];

  let { year, month, day } = utcToWall(hostTimezone, fromMs);
  for (;;) {
    const dayStartMs = wallToUtcMs(hostTimezone, year, month, day, 0, 0);
    if (dayStartMs >= toMs) break;
    // Weekday in the host zone, probed at noon to dodge midnight offsets.
    const noonMs = wallToUtcMs(hostTimezone, year, month, day, 12, 0);
    const weekday = utcToWall(hostTimezone, noonMs).weekday;
    if (weekday >= 1 && weekday <= 5) {
      let seed = hash32(`${memberKey}:${formatCivilDate(year, month, day)}`);
      seed = nextSeed(seed);
      const blockCount = 2 + (seed % 2);
      for (let i = 0; i < blockCount; i++) {
        seed = nextSeed(seed);
        const durationMin = 60 + (seed % 5) * 15; // 60, 75, 90, 105 or 120
        seed = nextSeed(seed);
        const startChoices = (20 * 60 - durationMin - 8 * 60) / 15 + 1;
        const startMin = 8 * 60 + (seed % startChoices) * 15;
        const startMs = wallToUtcMs(
          hostTimezone,
          year,
          month,
          day,
          Math.floor(startMin / 60),
          startMin % 60
        );
        const endMs = startMs + durationMin * 60_000;
        const clampedStartMs = Math.max(startMs, fromMs);
        const clampedEndMs = Math.min(endMs, toMs);
        if (clampedEndMs > clampedStartMs) {
          out.push({ startMs: clampedStartMs, endMs: clampedEndMs });
        }
      }
    }
    ({ year, month, day } = addCivilDays(year, month, day, 1));
  }
  return out;
}

async function mockCreateEvent(
  _refreshToken: string,
  input: CreateEventInput
): Promise<CreatedEvent> {
  const code = meetCode(hash32(`${input.calendarId}:${input.startAt}:${input.summary}`));
  return {
    eventId: `mock-${crypto.randomUUID().slice(0, 8)}`,
    meetingUrl: `https://meet.google.com/mock-${code}`,
  };
}

/* ------------------------------------------------------------------ */
/* Provider factory                                                    */
/* ------------------------------------------------------------------ */

const providerCache = new Map<CalendarProviderId, CalendarProvider>();

export function mockProvider(id: CalendarProviderId): CalendarProvider {
  const cached = providerCache.get(id);
  if (cached) return cached;
  const provider: CalendarProvider = {
    id,
    getAuthUrl() {
      throw new Error("not available in mock mode");
    },
    async exchangeCode() {
      throw new Error("not available in mock mode");
    },
    async listCalendars() {
      return [
        { id: "primary", name: "Work", primary: true },
        { id: "personal", name: "Personal", primary: false },
      ];
    },
    getBusy: mockGetBusy,
    createEvent: mockCreateEvent,
    async updateEventTime() {
      // No provider-side state to move in mock mode.
    },
    async deleteEvent() {
      // No provider-side state to delete in mock mode.
    },
  };
  providerCache.set(id, provider);
  return provider;
}

/* ------------------------------------------------------------------ */
/* Seeding                                                             */
/* ------------------------------------------------------------------ */

let seeding: Promise<void> | null = null;

/**
 * Seed the memory store once per process: one google account per config
 * member, plus a second (microsoft) account for the first member so the
 * multi-account path gets exercised. Idempotent: an already-populated store
 * is left untouched, and concurrent callers share one seeding pass.
 */
export async function ensureMockReady(): Promise<void> {
  if (!seeding) {
    seeding = seedMockAccounts().catch((err: unknown) => {
      seeding = null; // let a later call retry after a failed seed
      throw err;
    });
  }
  return seeding;
}

async function seedMockAccounts(): Promise<void> {
  const store = getMeetStore();
  const existing = await store.listAccounts();
  if (existing.length > 0) return;

  const { members } = getMeetConfig();
  for (const member of members) {
    await store.upsertAccount({
      memberKey: member.key,
      provider: "google",
      email: `${member.key}@example.com`,
      refreshTokenEnc: `${MOCK_TOKEN_PREFIX}${member.key}`,
      selectedCalendars: [{ id: "primary", name: "Work" }],
      status: "ok",
    });
  }
  const first = members[0];
  if (first) {
    await store.upsertAccount({
      memberKey: first.key,
      provider: "microsoft",
      email: `${first.key}@outlook.example.com`,
      refreshTokenEnc: `${MOCK_TOKEN_PREFIX}${first.key}`,
      selectedCalendars: [{ id: "primary", name: "Work" }],
      status: "ok",
    });
  }
}

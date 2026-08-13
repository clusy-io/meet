import "server-only";
import { getMeetConfig, type MeetConfig } from "./config";
import { decryptSecret } from "./crypto";
import { ensureMockReady } from "./mock";
import { getProvider } from "./providers";
import { availableSlots, candidateSlots } from "./slots";
import { getMeetStore } from "./store";
import { parseCivilDate, wallToUtcMs } from "./tz";
import {
  mergeBusy,
  overlapsBusy,
  ProviderAuthError,
  type AvailabilityResponse,
  type BusyInterval,
  type CalendarAccount,
  type Member,
} from "./types";

/**
 * clusy/meet: the availability service.
 *
 * Turns connected calendars plus existing bookings into bookable slots.
 * Fail-closed by design: a member whose calendars cannot be read (revoked
 * grant, provider outage, undecryptable token) is dropped from the free
 * candidates entirely, because an unreadable calendar must not look free.
 */

const DAY_MS = 86_400_000;

/**
 * Fetch one account's busy intervals. Kept async so a synchronous decrypt
 * failure surfaces as a rejection inside Promise.allSettled like any
 * provider error.
 */
async function fetchAccountBusy(
  config: MeetConfig,
  account: CalendarAccount,
  fromMs: number,
  toMs: number
): Promise<BusyInterval[]> {
  // Mock tokens are raw "mock:<memberKey>" strings, never encrypted.
  const token = config.mockMode ? account.refreshTokenEnc : decryptSecret(account.refreshTokenEnc);
  return getProvider(account.provider).getBusy(
    token,
    account.selectedCalendars.map((c) => c.id),
    fromMs,
    toMs
  );
}

/**
 * Merged PROVIDER busy intervals per member over [fromMs, toMs).
 *
 * Only members with at least one readable contributing account appear in the
 * map; slots.availableSlots treats absent members as unable to attend.
 * Confirmed bookings are NOT included here: this is the cacheable, expensive
 * half (provider API calls). Callers overlay bookings fresh from the DB so a
 * just-booked slot disappears on the very next request, on every instance.
 */
async function providerBusyByMember(
  config: MeetConfig,
  fromMs: number,
  toMs: number
): Promise<Map<string, BusyInterval[]>> {
  const store = getMeetStore();
  const knownKeys = new Set(config.members.map((m) => m.key));
  const accounts = (await store.listAccounts()).filter(
    (a) => a.status === "ok" && a.selectedCalendars.length > 0 && knownKeys.has(a.memberKey)
  );

  const results = await Promise.allSettled(
    accounts.map((account) => fetchAccountBusy(config, account, fromMs, toMs))
  );

  const busyByMember = new Map<string, BusyInterval[]>();
  const failedMembers = new Set<string>();
  results.forEach((result, i) => {
    const account = accounts[i];
    if (result.status === "fulfilled") {
      const list = busyByMember.get(account.memberKey) ?? [];
      list.push(...result.value);
      busyByMember.set(account.memberKey, list);
    } else {
      if (result.reason instanceof ProviderAuthError) {
        // Fire and forget: flag the account for re-auth without blocking
        // or failing the availability response.
        void store.updateAccount(account.id, { status: "reauth_required" }).catch(() => {});
      }
      failedMembers.add(account.memberKey);
    }
  });

  const map = new Map<string, BusyInterval[]>();
  for (const [memberKey, intervals] of busyByMember) {
    if (failedMembers.has(memberKey)) continue;
    map.set(memberKey, mergeBusy(intervals));
  }
  return map;
}

/**
 * Busy overlay from confirmed bookings, applied to EVERY present member:
 * whoever attends, the team holds one intro call at a time. Always read
 * fresh from the DB, never cached: this is what changes at booking cadence,
 * and the DB is the only state shared across serverless instances.
 */
async function withBookingsOverlay(
  providerBusy: Map<string, BusyInterval[]>,
  fromMs: number,
  toMs: number
): Promise<Map<string, BusyInterval[]>> {
  const bookings = await getMeetStore().listConfirmedBookingsInRange(fromMs, toMs);
  if (bookings.length === 0) return providerBusy;
  const overlay: BusyInterval[] = bookings.map((b) => ({
    startMs: Date.parse(b.startAt),
    endMs: Date.parse(b.endAt),
  }));
  const map = new Map<string, BusyInterval[]>();
  for (const [memberKey, busy] of providerBusy) {
    map.set(memberKey, mergeBusy([...busy, ...overlay]));
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

interface BusyCacheEntry {
  expiresMs: number;
  entries: Array<[string, BusyInterval[]]>;
}

const CACHE_TTL_MS = 60_000;

// globalThis-stashed like the store, so dev-mode module duplication across
// route bundles still shares one cache.
const BUSY_CACHE_KEY = "__meet_busy_cache__" as const;
type GlobalWithCache = typeof globalThis & { [BUSY_CACHE_KEY]?: Map<string, BusyCacheEntry> };

function busyCache(): Map<string, BusyCacheEntry> {
  const g = globalThis as GlobalWithCache;
  if (!g[BUSY_CACHE_KEY]) g[BUSY_CACHE_KEY] = new Map();
  return g[BUSY_CACHE_KEY];
}

/**
 * Drop cached provider busy data after a mutation. Bookings are never
 * cached (they overlay fresh on every request), so this only freshens the
 * provider picture, e.g. the calendar event a booking just created.
 */
export function invalidateAvailabilityCache(): void {
  busyCache().clear();
}

/**
 * Bookable slots for `days` civil days starting at `from` (a "YYYY-MM-DD"
 * date in the HOST timezone).
 *
 * Caching split: provider busy data (the expensive half, API calls to
 * Google/Microsoft) is cached per instance for 60s. Confirmed bookings are
 * read fresh from the DB on EVERY request and overlaid, because the DB is
 * the only state shared across serverless instances: a just-booked slot
 * must disappear on the next availability call no matter which instance
 * booked it. Booking-time checks use slotFreeMembers, which caches nothing.
 *
 * `requiredMemberKeys` narrows the result to slots where every listed member
 * is free (reschedule flow: the committed attendees must keep the call).
 */
export async function computeAvailability(
  from: string,
  days: number,
  requiredMemberKeys?: string[]
): Promise<AvailabilityResponse> {
  const config = getMeetConfig();
  if (config.mockMode) await ensureMockReady();

  const fromCivil = parseCivilDate(from);
  if (!fromCivil) throw new Error(`meet: invalid civil date "${from}"`);

  const windowFromMs = wallToUtcMs(
    config.hostTimezone,
    fromCivil.year,
    fromCivil.month,
    fromCivil.day,
    0,
    0
  );
  // One day of slack: the last day's late slots run past its UTC midnight.
  const windowToMs = windowFromMs + days * DAY_MS + DAY_MS;

  const cache = busyCache();
  const cacheKey = `${from}:${days}`;
  const nowMs = Date.now();
  const hit = cache.get(cacheKey);
  let providerBusy: Map<string, BusyInterval[]>;
  if (hit && hit.expiresMs > nowMs) {
    providerBusy = new Map(hit.entries);
  } else {
    providerBusy = await providerBusyByMember(config, windowFromMs, windowToMs);
    cache.set(cacheKey, { expiresMs: nowMs + CACHE_TTL_MS, entries: [...providerBusy] });
    if (cache.size > 64) {
      for (const [key, entry] of cache) {
        if (entry.expiresMs <= nowMs) cache.delete(key);
      }
    }
  }

  const busyMap = await withBookingsOverlay(providerBusy, windowFromMs, windowToMs);
  const candidates = candidateSlots(config, fromCivil, days);
  let slots = availableSlots(config, candidates, busyMap, Date.now());
  const required = requiredMemberKeys ? [...requiredMemberKeys] : [];
  if (required.length > 0) {
    slots = slots.filter((s) => required.every((key) => s.freeMemberKeys.includes(key)));
  }

  return {
    slots: slots.map((s) => new Date(s.startMs).toISOString()),
    durationMinutes: config.durationMinutes,
    hostTimezone: config.hostTimezone,
    minNoticeMinutes: config.minNoticeMinutes,
  };
}

/**
 * Members free for the single slot starting at `startMs`, in config order.
 * Always fresh (no cache): this is the booking-time double-check, so it must
 * see calendar changes the 60s availability cache may still be hiding.
 */
export async function slotFreeMembers(
  startMs: number,
  durationMinutes?: number
): Promise<{ free: Member[]; quorumMet: boolean }> {
  const config = getMeetConfig();
  if (config.mockMode) await ensureMockReady();

  const duration = durationMinutes ?? config.durationMinutes;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error("meet: slot duration must be a positive integer");
  }
  const endMs = startMs + duration * 60_000;
  const busyMap = await withBookingsOverlay(
    await providerBusyByMember(config, startMs, endMs),
    startMs,
    endMs
  );

  const free = config.members.filter((member) => {
    const busy = busyMap.get(member.key);
    return busy !== undefined && !overlapsBusy(busy, startMs, endMs);
  });
  return { free, quorumMet: free.length >= config.quorum };
}

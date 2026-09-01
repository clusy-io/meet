import "server-only";
import { getMeetConfig, type MeetConfig } from "./config";
import { decryptSecret } from "./crypto";
import { ensureMockReady } from "./mock";
import { getEffectiveMeetConfig, getRuntimeMeetConfig } from "./members";
import { teamMemberWindows } from "./pages";
import { getProvider } from "./providers";
import {
  availableSlots,
  candidateSlots,
  transitionZones,
  zoneForCivilDay,
  type SlotCandidate,
} from "./slots";
import { getMeetStore } from "./store";
import { addCivilDays, formatCivilDate, minutesToClock, parseCivilDate, utcToWall, wallToUtcMs } from "./tz";
import {
  mergeBusy,
  overlapsBusy,
  ProviderAuthError,
  type AvailabilityResponse,
  type Booking,
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
 * Busy overlay from confirmed bookings, applied to each booking's OWN
 * attendees rather than to everyone.
 *
 * This used to blanket every member ("the team holds one intro call at a
 * time"), which was harmless while /meet was the only page. With per-person
 * pages it would mean Eldar's 3pm makes Ju's 3pm unbookable, so the overlay
 * now follows attendeeMemberKeys — which createBooking already populates with
 * exactly the members who are committed to the call (all free members for a
 * team booking, the one owner for a personal booking).
 *
 * An EMPTY attendee list still blocks everyone: a degraded or legacy row must
 * fail towards "unavailable", never towards invisible.
 *
 * Always read fresh from the DB, never cached: this is what changes at booking
 * cadence, and the DB is the only state shared across serverless instances.
 */
async function withBookingsOverlay(
  providerBusy: Map<string, BusyInterval[]>,
  fromMs: number,
  toMs: number,
  /**
   * An already-started read for the SAME window. computeAvailability kicks the
   * query off before awaiting the providers, since it depends on nothing they
   * return; passing it here keeps the "always fresh, never cached" contract
   * intact, because it is still one uncached read per request.
   */
  bookingsPromise?: Promise<Booking[]>
): Promise<Map<string, BusyInterval[]>> {
  const bookings = await (bookingsPromise ??
    getMeetStore().listConfirmedBookingsInRange(fromMs, toMs));
  if (bookings.length === 0) return providerBusy;
  const map = new Map<string, BusyInterval[]>();
  for (const [memberKey, busy] of providerBusy) {
    const overlay: BusyInterval[] = bookings
      .filter(
        (b) => b.attendeeMemberKeys.length === 0 || b.attendeeMemberKeys.includes(memberKey)
      )
      .map((b) => ({ startMs: Date.parse(b.startAt), endMs: Date.parse(b.endAt) }));
    map.set(memberKey, overlay.length === 0 ? busy : mergeBusy([...busy, ...overlay]));
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

interface BusyCacheEntry {
  expiresMs: number;
  /**
   * The window this map was actually fetched for. Stored so a wider entry can
   * serve a narrower need: every window starts at host-tz midnight today, so
   * "does this cover me" reduces to comparing the end.
   */
  fromMs: number;
  toMs: number;
  entries: Array<[string, BusyInterval[]]>;
}

const CACHE_TTL_MS = 60_000;

/**
 * The only window worth fetching: host-tz midnight today up to the horizon
 * edge, which is exactly the range availableSlots will accept (slots.ts
 * drops anything at or past `today + horizonDays + 1`).
 *
 * The caller's `from`/`days` deliberately do NOT appear here. They are
 * client-controlled (route.ts clamps them only to [today, today+horizon] and
 * [1,36], ~790 reachable combinations), and keying the cache on them let any
 * unauthenticated visitor miss on every request and fan out a fresh set of
 * Google/Microsoft calls each time. Since no candidate outside this window can
 * survive the horizon filter anyway, a single canonical fetch per day serves
 * every caller with an identical result.
 */
function canonicalWindow(
  config: MeetConfig,
  memberWindows: Iterable<MeetConfig>
): { key: string; fromMs: number; toMs: number } {
  const zones = new Set<string>();
  for (const candidate of [config, ...memberWindows]) {
    for (const zone of transitionZones(candidate)) zones.add(zone);
  }

  let fromMs = Number.POSITIVE_INFINITY;
  let toMs = Number.NEGATIVE_INFINITY;
  const civilKeys: string[] = [];
  const nowMs = Date.now();
  for (const zone of [...zones].sort()) {
    const today = utcToWall(zone, nowMs);
    civilKeys.push(`${zone}:${formatCivilDate(today.year, today.month, today.day)}`);
    fromMs = Math.min(
      fromMs,
      wallToUtcMs(zone, today.year, today.month, today.day, 0, 0)
    );
    const edge = addCivilDays(today.year, today.month, today.day, config.horizonDays + 1);
    toMs = Math.max(toMs, wallToUtcMs(zone, edge.year, edge.month, edge.day, 0, 0));
  }

  // Active roster membership belongs in the key: the provider map is a
  // roster-shaped value, so a cached pre-add/pre-archive map is never valid
  // for a different team even when its time bounds happen to match.
  const roster = config.members.map((member) => member.key).sort().join(",");
  return { key: `${civilKeys.join("|")}|${roster}`, fromMs, toMs };
}

function unionCandidates(configs: Iterable<MeetConfig>, fromCivil: {
  year: number;
  month: number;
  day: number;
}, days: number): SlotCandidate[] {
  const byStart = new Map<number, SlotCandidate>();
  for (const config of configs) {
    for (const candidate of candidateSlots(config, fromCivil, days)) {
      if (!byStart.has(candidate.startMs)) byStart.set(candidate.startMs, candidate);
    }
  }
  return [...byStart.values()].sort((a, b) => a.startMs - b.startMs);
}

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

export interface MemberBusyTimeline {
  hostTimezone: string;
  generatedAt: string;
  range: { from: string; to: string };
  window: { start: string; end: string };
  durationMinutes: number;
  slotStepMinutes: number;
  minNoticeMinutes: number;
  quorum: number;
  bookableWeekdays: number[];
  bookableDates: string[];
  members: Array<{
    key: string;
    name: string;
    status: "ready" | "unavailable";
    busy: Array<{ startAt: string; endAt: string }>;
    working: Array<{ startAt: string; endAt: string }>;
    eligibleStarts: string[];
  }>;
  slots: Array<{
    startAt: string;
    endAt: string;
    freeMemberKeys: string[];
  }>;
}

export const MEMBER_BUSY_TIMELINE_MAX_DAYS = 14;
const MEMBER_GRID_CIVIL_PADDING_DAYS = 2;

function realCivilDate(value: string): { year: number; month: number; day: number } | null {
  const civil = parseCivilDate(value);
  if (!civil || civil.year < 1000 || civil.year > 9999) return null;
  const probe = new Date(Date.UTC(civil.year, civil.month - 1, civil.day));
  return probe.getUTCFullYear() === civil.year &&
    probe.getUTCMonth() + 1 === civil.month &&
    probe.getUTCDate() === civil.day
    ? civil
    : null;
}

function wallDateKey(wall: { year: number; month: number; day: number }): string {
  return formatCivilDate(wall.year, wall.month, wall.day);
}

function memberWorkingIntervals(
  config: MeetConfig,
  paddedFrom: { year: number; month: number; day: number },
  paddedDays: number,
  fromMs: number,
  toMs: number
): BusyInterval[] {
  const intervals: BusyInterval[] = [];
  for (let index = 0; index < paddedDays; index += 1) {
    const civil = addCivilDays(paddedFrom.year, paddedFrom.month, paddedFrom.day, index);
    const zone = zoneForCivilDay(config, civil);
    const noonMs = wallToUtcMs(zone, civil.year, civil.month, civil.day, 12, 0);
    if (!config.bookableWeekdays.includes(utcToWall(zone, noonMs).weekday)) continue;
    const startMs = wallToUtcMs(
      zone, civil.year, civil.month, civil.day,
      Math.floor(config.windowStartMin / 60), config.windowStartMin % 60
    );
    const endMs = wallToUtcMs(
      zone, civil.year, civil.month, civil.day,
      Math.floor(config.windowEndMin / 60), config.windowEndMin % 60
    );
    const clipped = { startMs: Math.max(startMs, fromMs), endMs: Math.min(endMs, toMs) };
    if (clipped.endMs > clipped.startMs) intervals.push(clipped);
  }
  return mergeBusy(intervals);
}

/** Privacy-safe admin timeline using the recoverable roster and member grids. */
export async function computeMemberBusyTimeline(
  from: string,
  requestedDays: number
): Promise<MemberBusyTimeline> {
  if (!Number.isSafeInteger(requestedDays) || requestedDays < 1) {
    throw new Error("meet: timeline days must be a positive integer");
  }
  const fromCivil = realCivilDate(from);
  if (!fromCivil) throw new Error(`meet: timeline from must be a real YYYY-MM-DD date: "${from}"`);
  const days = Math.min(requestedDays, MEMBER_BUSY_TIMELINE_MAX_DAYS);
  const toCivil = addCivilDays(fromCivil.year, fromCivil.month, fromCivil.day, days);
  const to = formatCivilDate(toCivil.year, toCivil.month, toCivil.day);

  // Admin recovery must keep working while the roster is temporarily below quorum.
  const config = await getEffectiveMeetConfig();
  const fromMs = wallToUtcMs(config.hostTimezone, fromCivil.year, fromCivil.month, fromCivil.day, 0, 0);
  const toMs = wallToUtcMs(config.hostTimezone, toCivil.year, toCivil.month, toCivil.day, 0, 0);
  if (config.mockMode) await ensureMockReady();

  const windowsPromise = teamMemberWindows(config);
  const bookingsPromise = getMeetStore().listConfirmedBookingsInRange(fromMs, toMs);
  bookingsPromise.catch(() => {});
  const [windows, providerBusy] = await Promise.all([
    windowsPromise,
    providerBusyByMember(config, fromMs, toMs),
  ]);
  const busyByMember = await withBookingsOverlay(providerBusy, fromMs, toMs, bookingsPromise);
  const paddedFrom = addCivilDays(
    fromCivil.year,
    fromCivil.month,
    fromCivil.day,
    -MEMBER_GRID_CIVIL_PADDING_DAYS
  );
  const paddedDays = days + MEMBER_GRID_CIVIL_PADDING_DAYS * 2;
  let windowStart = config.windowStartMin;
  let windowEnd = config.windowEndMin;
  const bookableDates = new Set<string>();
  const memberSlotSets = new Map<string, Set<number>>();
  const candidatesByStart = new Map<number, SlotCandidate>();

  const members: MemberBusyTimeline["members"] = config.members.map((member) => {
    const rawBusy = busyByMember.get(member.key);
    const memberConfig = windows.get(member.key);
    const working = memberConfig
      ? memberWorkingIntervals(memberConfig, paddedFrom, paddedDays, fromMs, toMs).map((iv) => ({
          startAt: new Date(iv.startMs).toISOString(),
          endAt: new Date(iv.endMs).toISOString(),
        }))
      : [];
    if (!rawBusy || !memberConfig || rawBusy.some((iv) => !Number.isFinite(iv.startMs) || !Number.isFinite(iv.endMs))) {
      memberSlotSets.set(member.key, new Set());
      return { key: member.key, name: member.name, status: "unavailable", busy: [], working, eligibleStarts: [] };
    }
    const candidates = candidateSlots(memberConfig, paddedFrom, paddedDays).filter(
      (candidate) => candidate.startMs >= fromMs && candidate.startMs < toMs
    );
    const eligibleStarts = [...new Set(candidates.map((candidate) => candidate.startMs))]
      .sort((a, b) => a - b)
      .map((startMs) => new Date(startMs).toISOString());
    memberSlotSets.set(member.key, new Set(candidates.map((candidate) => candidate.startMs)));
    for (const candidate of candidates) candidatesByStart.set(candidate.startMs, candidate);
    for (const candidate of candidates) {
      const startWall = utcToWall(config.hostTimezone, candidate.startMs);
      const endWall = utcToWall(config.hostTimezone, candidate.endMs);
      const startMinute = startWall.hour * 60 + startWall.minute;
      const endMinute = wallDateKey(endWall) > wallDateKey(startWall)
        ? 1440
        : endWall.hour * 60 + endWall.minute;
      windowStart = Math.min(windowStart, startMinute);
      windowEnd = Math.max(windowEnd, endMinute);
      bookableDates.add(wallDateKey(startWall));
    }
    const busy = mergeBusy(rawBusy.map((iv) => ({
      startMs: Math.max(iv.startMs, fromMs),
      endMs: Math.min(iv.endMs, toMs),
    })).filter((iv) => iv.endMs > iv.startMs)).map((iv) => ({
      startAt: new Date(iv.startMs).toISOString(),
      endAt: new Date(iv.endMs).toISOString(),
    }));
    return { key: member.key, name: member.name, status: "ready", busy, working, eligibleStarts };
  });

  const reservedStarts = new Set(
    (await bookingsPromise)
      .filter((booking) => booking.pageKey === "")
      .map((booking) => Date.parse(booking.startAt))
      .filter(Number.isFinite)
  );
  const slots = availableSlots(
    config,
    [...candidatesByStart.values()].sort((a, b) => a.startMs - b.startMs),
    busyByMember,
    Date.now(),
    config.quorum,
    memberSlotSets
  )
    .filter((slot) => !reservedStarts.has(slot.startMs))
    .map((slot) => ({
      startAt: new Date(slot.startMs).toISOString(),
      endAt: new Date(slot.startMs + config.durationMinutes * 60_000).toISOString(),
      freeMemberKeys: slot.freeMemberKeys,
    }));

  return {
    hostTimezone: config.hostTimezone,
    generatedAt: new Date().toISOString(),
    range: { from, to },
    window: {
      start: minutesToClock(Math.max(0, Math.min(1440, windowStart))),
      end: minutesToClock(Math.max(0, Math.min(1440, windowEnd))),
    },
    durationMinutes: config.durationMinutes,
    slotStepMinutes: config.slotStepMinutes,
    minNoticeMinutes: config.minNoticeMinutes,
    quorum: config.quorum,
    bookableWeekdays: [...config.bookableWeekdays],
    bookableDates: [...bookableDates].sort(),
    members,
    slots,
  };
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
 *
 * `hostKey` switches to a personal page: only that member's calendar decides,
 * and quorum stops applying. Note this is NOT the same as passing the host in
 * `requiredMemberKeys` — that filter runs AFTER the quorum test, so it yields
 * "the host plus one other founder free", which is a fraction of the host's
 * real openings.
 *
 * `config` supplies that page's window/duration overrides; it defaults to the
 * global config.
 */
export async function computeAvailability(
  from: string,
  days: number,
  options: {
    requiredMemberKeys?: string[];
    hostKey?: string;
    config?: MeetConfig;
  } = {}
): Promise<AvailabilityResponse> {
  // A supplied config (personal pages and pure tests) already carries the
  // current roster. Rebuild only the team defaults around that roster; without
  // one, load the persisted active roster now rather than using env forever.
  const runtimeConfig = options.config ?? (await getRuntimeMeetConfig());
  const globalConfig = options.config
    ? { ...getMeetConfig(), members: runtimeConfig.members }
    : runtimeConfig;
  const config = runtimeConfig;
  const { hostKey, requiredMemberKeys } = options;
  if (config.mockMode) await ensureMockReady();

  const fromCivil = parseCivilDate(from);
  if (!fromCivil) throw new Error(`meet: invalid civil date "${from}"`);

  // Fetch and cache the canonical window, never the caller's. A busy interval
  // outside the caller's days simply overlaps none of their candidates, so a
  // wider map is always safe; a narrower one would not be.
  const memberWindows = await teamMemberWindows(globalConfig);
  const canonicalConfigs = [...memberWindows.values(), config];
  const { key: cacheKey, fromMs: windowFromMs, toMs: canonicalToMs } =
    canonicalWindow(config, canonicalConfigs);

  const cache = busyCache();
  const nowMs = Date.now();
  const hit = cache.get(cacheKey);

  // Identical on both branches: a hit is only accepted when
  // `hit.toMs >= canonicalToMs`, so `hit.toMs` already IS the max. Computing it
  // up front is what lets the bookings read start before the provider await.
  const windowToMs = Math.max(canonicalToMs, hit?.toMs ?? 0);

  // Start the confirmed-bookings read now. It depends only on the window, never
  // on anything the providers return, so awaiting it after them was ~110ms of
  // pure serialisation on every cache miss. Still uncached and still one read
  // per request, which is what invariant 2 actually requires.
  const bookingsPromise = getMeetStore().listConfirmedBookingsInRange(windowFromMs, windowToMs);
  // If the provider leg throws first, this would otherwise be an unobserved
  // rejection. The real error still surfaces when it is awaited below.
  bookingsPromise.catch(() => {});

  let providerBusy: Map<string, BusyInterval[]>;
  if (hit && hit.expiresMs > nowMs && hit.fromMs <= windowFromMs && hit.toMs >= canonicalToMs) {
    providerBusy = new Map(hit.entries);
  } else {
    // A page with a longer horizon widens the shared entry rather than
    // replacing it with a narrower one, so a 14-day personal page can never
    // shrink the window the 21-day team page is relying on.
    // Deliberately fetches EVERY member, not just this page's owner, so the
    // cached map stays page-independent and the team page and each personal
    // page share one entry and one set of provider calls. Narrowing it here
    // would make the cached value partial while the key stayed the same, and
    // the team page would then read a map missing two founders, fail quorum on
    // every slot, and show a silent 60-second outage.
    providerBusy = await providerBusyByMember(globalConfig, windowFromMs, windowToMs);
    cache.set(cacheKey, {
      expiresMs: nowMs + CACHE_TTL_MS,
      fromMs: windowFromMs,
      toMs: windowToMs,
      entries: [...providerBusy],
    });
    // Keys are host-tz civil dates, so this holds one live entry and sheds
    // yesterday's shortly after midnight. The previous sweep fired on
    // `size > 64` but only deleted ALREADY-EXPIRED entries, so a cache full of
    // live ones grew without bound.
    for (const [key, entry] of cache) {
      if (key !== cacheKey && entry.expiresMs <= nowMs) cache.delete(key);
    }
  }

  const fullBusyMap = await withBookingsOverlay(
    providerBusy,
    windowFromMs,
    windowToMs,
    bookingsPromise
  );

  // A personal page sees a map holding at most its own owner. Scoping the MAP
  // (rather than filtering the output) is what makes quorum irrelevant, and it
  // inherits fail-closed for free: a member whose calendars could not be read
  // is ABSENT from the map, so the scoped map is empty, nothing reaches
  // quorum 1, and the page shows no availability. Never read an absent member
  // as free — that turns a revoked OAuth grant into a page that books over a
  // full calendar.
  let busyMap = fullBusyMap;
  let quorum = config.quorum;
  if (hostKey !== undefined) {
    const hostBusy = fullBusyMap.get(hostKey);
    busyMap = new Map(hostBusy === undefined ? [] : [[hostKey, hostBusy]]);
    quorum = 1;
  }

  let candidates: SlotCandidate[];
  let memberSlotSets: Map<string, ReadonlySet<number>> | undefined;
  if (hostKey === undefined) {
    candidates = unionCandidates(memberWindows.values(), fromCivil, days);
    memberSlotSets = new Map(
      [...memberWindows].map(([memberKey, window]) => [
        memberKey,
        new Set(candidateSlots(window, fromCivil, days).map((candidate) => candidate.startMs)),
      ])
    );
  } else {
    candidates = candidateSlots(config, fromCivil, days);
  }
  let slots = availableSlots(
    config,
    candidates,
    busyMap,
    Date.now(),
    quorum,
    memberSlotSets
  );
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
  const config = await getRuntimeMeetConfig();
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

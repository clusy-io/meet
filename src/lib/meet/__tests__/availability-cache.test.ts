import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusyInterval } from "@/lib/meet/types";

/**
 * The provider busy cache: what it is keyed on, and what it refuses to grow to.
 *
 * Two defects motivated these:
 *
 *  1. The key was `${from}:${days}`, both client-controlled. The route clamps
 *     them only to [today, today+horizon] and [1,36], so ~790 distinct keys
 *     were reachable by an unauthenticated caller, each one a full provider
 *     fan-out across every connected account.
 *  2. The eviction sweep fired at `size > 64` but deleted only entries that had
 *     ALREADY expired, so a cache full of live entries never shed anything.
 *
 * Together those meant a single visitor walking `?from=` could both defeat the
 * cache on every request and grow it without bound. The fix is one canonical
 * window per host-tz day, since slots.ts drops any candidate at or past
 * `today + horizonDays + 1` regardless of what the caller asked for.
 */

const mocks = vi.hoisted(() => ({
  config: {
    hostTimezone: "UTC",
    windowStartMin: 9 * 60,
    windowEndMin: 17 * 60,
    bookableWeekdays: [1, 2, 3, 4, 5],
    durationMinutes: 30,
    slotStepMinutes: 30,
    minNoticeMinutes: 0,
    horizonDays: 21,
    members: [
      { key: "one", name: "One", email: "one@example.com" },
      { key: "two", name: "Two", email: "two@example.com" },
    ],
    quorum: 2,
    eventTitle: "Call with {name}",
    eventDescription: "A test call",
    brandName: "Test",
    siteOrigin: "https://example.com",
    emailFrom: "Test <meet@example.com>",
    organizerEmail: null as string | null,
    adminSecret: null,
    tokenSecret: null,
    cronSecret: null,
    mockMode: false,
  },
  getBusy: vi.fn(),
  listAccounts: vi.fn(),
  listConfirmedBookingsInRange: vi.fn(),
}));

vi.mock("@/lib/meet/config", () => ({ getMeetConfig: () => mocks.config }));
vi.mock("@/lib/meet/crypto", () => ({ decryptSecret: (v: string) => v }));
vi.mock("@/lib/meet/providers", () => ({
  getProvider: () => ({ getBusy: mocks.getBusy }),
}));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
    listAccounts: mocks.listAccounts,
    listConfirmedBookingsInRange: mocks.listConfirmedBookingsInRange,
  }),
}));

import { computeAvailability, invalidateAvailabilityCache } from "@/lib/meet/availability";

/** A Monday, so the whole horizon holds bookable weekdays. */
const NOW = Date.parse("2026-08-17T08:00:00.000Z");

/** Window each getBusy call was asked for, in request order. */
function requestedWindows(): Array<{ fromMs: number; toMs: number }> {
  return mocks.getBusy.mock.calls.map((c) => ({ fromMs: c[2] as number, toMs: c[3] as number }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  invalidateAvailabilityCache();
  mocks.getBusy.mockReset();
  mocks.getBusy.mockResolvedValue([] as BusyInterval[]);
  mocks.listConfirmedBookingsInRange.mockReset();
  mocks.listConfirmedBookingsInRange.mockResolvedValue([]);
  mocks.listAccounts.mockReset();
  mocks.listAccounts.mockResolvedValue(
    mocks.config.members.map((m, i) => ({
      id: `acct-${i}`,
      memberKey: m.key,
      provider: "google",
      status: "ok",
      refreshTokenEnc: "tok",
      selectedCalendars: [{ id: "primary", summary: "Primary" }],
    }))
  );
  mocks.config.horizonDays = 21;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("canonical window keying", () => {
  it("serves every reachable from/days combination from ONE provider fetch", async () => {
    // Walk the key space the route actually exposes. Under the old
    // `${from}:${days}` key each of these missed and fanned out again.
    await computeAvailability("2026-08-17", 23);
    const afterFirst = mocks.getBusy.mock.calls.length;
    expect(afterFirst).toBe(2); // one per connected account, once

    for (let day = 17; day <= 28; day++) {
      for (const days of [1, 7, 23, 36]) {
        await computeAvailability(`2026-08-${String(day).padStart(2, "0")}`, days);
      }
    }

    expect(mocks.getBusy.mock.calls.length).toBe(afterFirst);
  });

  it("asks the providers for the horizon edge, not the caller's days", async () => {
    await computeAvailability("2026-08-17", 1);
    const [w] = requestedWindows();
    // today 00:00 UTC .. today+22 00:00 UTC (horizonDays + 1), NOT today+1.
    expect(w.fromMs).toBe(Date.parse("2026-08-17T00:00:00.000Z"));
    expect(w.toMs).toBe(Date.parse("2026-09-08T00:00:00.000Z"));
  });

  it("still returns only the days the caller asked for", async () => {
    // The wider fetch must not widen the ANSWER.
    const narrow = await computeAvailability("2026-08-19", 2);
    expect(narrow.slots.length).toBeGreaterThan(0);
    for (const iso of narrow.slots) {
      expect(iso >= "2026-08-19").toBe(true);
      expect(iso < "2026-08-21").toBe(true);
    }
  });

  it("keeps a busy interval effective for a caller whose window excludes it", async () => {
    // The canonical map carries intervals outside the caller's range; they must
    // neither leak into the answer nor stop applying inside it.
    mocks.getBusy.mockResolvedValue([
      { startMs: Date.parse("2026-08-19T09:00:00.000Z"), endMs: Date.parse("2026-08-19T17:00:00.000Z") },
      { startMs: Date.parse("2026-09-01T09:00:00.000Z"), endMs: Date.parse("2026-09-01T17:00:00.000Z") },
    ]);
    const day = await computeAvailability("2026-08-19", 1);
    expect(day.slots).toEqual([]);
  });
});

describe("cache growth", () => {
  it("holds one entry per host-tz day no matter how the key space is walked", async () => {
    // The old sweep deleted only already-expired entries, so 100 live keys
    // stayed resident. Cache size is not observable from outside, so this
    // asserts the consequence: no extra provider fetches, and after expiry
    // exactly one refetch rather than one per key.
    for (let day = 17; day <= 28; day++) {
      for (const days of [1, 5, 12, 23, 36]) {
        await computeAvailability(`2026-08-${String(day).padStart(2, "0")}`, days);
      }
    }
    expect(mocks.getBusy.mock.calls.length).toBe(2);

    vi.setSystemTime(NOW + 61_000);
    await computeAvailability("2026-08-17", 23);
    expect(mocks.getBusy.mock.calls.length).toBe(4);
  });

  it("refetches once the 60s TTL lapses", async () => {
    await computeAvailability("2026-08-17", 23);
    expect(mocks.getBusy.mock.calls.length).toBe(2);

    vi.setSystemTime(NOW + 59_000);
    await computeAvailability("2026-08-17", 23);
    expect(mocks.getBusy.mock.calls.length).toBe(2);

    vi.setSystemTime(NOW + 61_000);
    await computeAvailability("2026-08-17", 23);
    expect(mocks.getBusy.mock.calls.length).toBe(4);
  });
});

describe("the bookings read does not wait for the providers", () => {
  it("issues both legs concurrently on a cache miss", async () => {
    // The bookings query depends on the window, never on anything the
    // providers return, so awaiting it after them was pure serialisation.
    const order: string[] = [];
    let releaseProviders!: () => void;
    const providersGate = new Promise<void>((r) => {
      releaseProviders = r;
    });

    mocks.getBusy.mockImplementation(async () => {
      order.push("providers:start");
      await providersGate;
      order.push("providers:end");
      return [];
    });
    mocks.listConfirmedBookingsInRange.mockImplementation(async () => {
      order.push("bookings:start");
      return [];
    });

    const pending = computeAvailability("2026-08-17", 23);
    // Let both legs get going, then prove the bookings read already started
    // even though the providers have not returned.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toContain("bookings:start");
    expect(order).not.toContain("providers:end");

    releaseProviders();
    await pending;
    expect(order.indexOf("bookings:start")).toBeLessThan(order.indexOf("providers:end"));
  });

  it("still reads bookings for the same window the providers were asked for", async () => {
    await computeAvailability("2026-08-17", 1);
    const [pFrom, pTo] = [
      mocks.getBusy.mock.calls[0][2] as number,
      mocks.getBusy.mock.calls[0][3] as number,
    ];
    const [bFrom, bTo] = mocks.listConfirmedBookingsInRange.mock.calls[0] as [number, number];
    // A narrower bookings window would silently drop a confirmed booking from
    // the overlay, which is the one thing that must never happen.
    expect(bFrom).toBe(pFrom);
    expect(bTo).toBe(pTo);
  });

  it("surfaces a bookings failure rather than swallowing it", async () => {
    // The read is started early with a no-op catch attached so it is not an
    // unobserved rejection; that must not turn into a silently empty overlay.
    mocks.listConfirmedBookingsInRange.mockRejectedValue(new Error("db down"));
    await expect(computeAvailability("2026-08-17", 23)).rejects.toThrow("db down");
  });
});

describe("a shorter-horizon page cannot shrink the shared window", () => {
  it("widens rather than replaces when horizons differ", async () => {
    const team = { ...mocks.config, horizonDays: 21 };
    const personal = { ...mocks.config, horizonDays: 7 };

    // Personal page first: fetches its own narrower window.
    await computeAvailability("2026-08-17", 8, { config: personal });
    expect(requestedWindows()[0].toMs).toBe(Date.parse("2026-08-25T00:00:00.000Z"));

    // The team page needs more, so it refetches wider.
    await computeAvailability("2026-08-17", 23, { config: team });
    expect(requestedWindows()[2].toMs).toBe(Date.parse("2026-09-08T00:00:00.000Z"));

    // The personal page now reuses the wider entry instead of narrowing it,
    // which would otherwise leave the team page a map missing two weeks of
    // busy data and offer slots over a full calendar.
    const before = mocks.getBusy.mock.calls.length;
    await computeAvailability("2026-08-17", 8, { config: personal });
    expect(mocks.getBusy.mock.calls.length).toBe(before);
  });
});

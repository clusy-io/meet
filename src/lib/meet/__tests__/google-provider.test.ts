import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google OAuth2 client reuse.
 *
 * A fresh client holds no access token, so googleapis mints one over the
 * network before its first API call. Building a client per call meant every
 * free-busy read paid that round trip, and availability reads every connected
 * account at once, so a cold request paid it once per account.
 *
 * Microsoft already had this cache (microsoft.ts, accessTokenCache); Google
 * documented the opposite as deliberate. These pin the new behaviour and, just
 * as importantly, pin what must NOT be shared between accounts.
 */

const mocks = vi.hoisted(() => ({
  constructed: [] as Array<Record<string, unknown>>,
  setCredentials: vi.fn(),
  freebusyQuery: vi.fn(),
  calendarCalls: [] as unknown[],
}));

// Mocks the SUBPATHS the provider imports, not the `googleapis` umbrella: the
// umbrella eagerly loads ~984 API surfaces and the provider deliberately no
// longer touches it.
vi.mock("googleapis/build/src/apis/calendar", () => {
  class OAuth2 {
    credentials: Record<string, unknown> = {};
    constructor(opts: Record<string, unknown>) {
      mocks.constructed.push(opts);
    }
    setCredentials(creds: Record<string, unknown>) {
      this.credentials = creds;
      mocks.setCredentials(creds);
    }
    generateAuthUrl() {
      return "https://accounts.google.com/o/oauth2/auth";
    }
  }
  return {
    auth: { OAuth2 },
    calendar: (opts: unknown) => {
      mocks.calendarCalls.push(opts);
      return { freebusy: { query: mocks.freebusyQuery } };
    },
  };
});

vi.mock("googleapis/build/src/apis/oauth2", () => ({
  oauth2: () => ({ userinfo: { get: async () => ({ data: {} }) } }),
}));

import { __resetGoogleProviderState } from "@/lib/meet/providers/google";
import { googleProvider } from "@/lib/meet/providers/google";

const FROM = Date.parse("2026-08-17T00:00:00.000Z");
const TO = Date.parse("2026-09-08T00:00:00.000Z");

beforeEach(() => {
  process.env.MEET_GOOGLE_CLIENT_ID = "client-id";
  process.env.MEET_GOOGLE_CLIENT_SECRET = "client-secret";
  __resetGoogleProviderState();
  mocks.constructed.length = 0;
  mocks.calendarCalls.length = 0;
  mocks.setCredentials.mockClear();
  mocks.freebusyQuery.mockReset();
  mocks.freebusyQuery.mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } });
});

afterEach(() => {
  __resetGoogleProviderState();
});

describe("OAuth2 client reuse", () => {
  it("builds ONE client across repeated reads for the same account", async () => {
    await googleProvider.getBusy("refresh-a", ["primary"], FROM, TO);
    expect(mocks.constructed.length).toBe(1);

    await googleProvider.getBusy("refresh-a", ["primary"], FROM, TO);
    await googleProvider.getBusy("refresh-a", ["primary"], FROM, TO);

    // Still one client, so the access token minted for the first call is the
    // one the later calls ride on.
    expect(mocks.constructed.length).toBe(1);
    expect(mocks.freebusyQuery.mock.calls.length).toBe(3);
  });

  it("never shares a client between two accounts", async () => {
    await googleProvider.getBusy("refresh-a", ["primary"], FROM, TO);
    await googleProvider.getBusy("refresh-b", ["primary"], FROM, TO);
    expect(mocks.constructed.length).toBe(2);

    // Each client carries its own credential, never the other's.
    const seeded = mocks.setCredentials.mock.calls.map((c) => c[0].refresh_token);
    expect(seeded).toEqual(["refresh-a", "refresh-b"]);
  });

  it("treats a re-granted account as a new client", async () => {
    // A re-auth mints a NEW refresh token, so it must not ride the old
    // client, whose credential was just revoked.
    await googleProvider.getBusy("refresh-old", ["primary"], FROM, TO);
    await googleProvider.getBusy("refresh-new", ["primary"], FROM, TO);
    expect(mocks.constructed.length).toBe(2);
  });

  it("keeps the OAuth start flow on its own throwaway client", async () => {
    // The consent-URL client carries a redirectUri and no refresh token; it
    // must never be served from, or land in, the cache.
    await googleProvider.getBusy("refresh-a", ["primary"], FROM, TO);
    const before = mocks.constructed.length;
    googleProvider.getAuthUrl("state-123", "https://example.com/cb");
    expect(mocks.constructed.length).toBe(before + 1);
    expect(mocks.constructed[before].redirectUri).toBe("https://example.com/cb");

    // ...and the cached read client is still the cached one.
    await googleProvider.getBusy("refresh-a", ["primary"], FROM, TO);
    expect(mocks.constructed.length).toBe(before + 1);
  });
});

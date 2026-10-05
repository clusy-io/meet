import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public availability route's window.
 *
 * The booking pages never send `from` or `days`, so the route's default IS
 * the range visitors can book in. It used to be a fixed 23 days, sized for a
 * 21-day horizon, and quietly hid every day past it once the horizon grew.
 */
const mocks = vi.hoisted(() => ({
  config: {
    hostTimezone: "Europe/London",
    horizonDays: 30,
    members: [{ key: "one", name: "One", email: "one@example.com" }],
  } as Record<string, unknown>,
  compute: vi.fn(),
  getPage: vi.fn(),
  getBookingByToken: vi.fn(),
}));

vi.mock("@/lib/meet/availability", () => ({ computeAvailability: mocks.compute }));
vi.mock("@/lib/meet/members", () => ({
  getRuntimeMeetConfig: async () => mocks.config,
}));
vi.mock("@/lib/meet/pages", () => ({ getPage: mocks.getPage }));
vi.mock("@/lib/meet/ratelimit", () => ({ rateLimit: () => true }));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({ getBookingByToken: mocks.getBookingByToken }),
}));

import { GET } from "@/app/api/meet/availability/route";

// Mon Oct 5 2026, 14:00 in London.
const NOW = Date.parse("2026-10-05T13:00:00.000Z");

function get(query = "") {
  return GET(new Request(`https://example.com/api/meet/availability${query}`));
}

/** The (from, days) the route handed computeAvailability. */
function requested() {
  const [from, days] = mocks.compute.mock.calls[0] ?? [];
  return { from, days };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  mocks.compute.mockResolvedValue({ slots: [] });
  mocks.getPage.mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("public availability window", () => {
  it("covers the whole horizon when the picker sends no range", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    // Today through today + 30 is 31 opening days; two more cover member
    // zones ahead of London.
    expect(requested()).toEqual({ from: "2026-10-05", days: 33 });
  });

  it("follows a personal page's own horizon", async () => {
    mocks.getPage.mockResolvedValue({
      enabled: true,
      member: { key: "one" },
      config: { ...mocks.config, horizonDays: 45, quorum: 1 },
    });

    await get("?host=one");

    expect(requested()).toEqual({ from: "2026-10-05", days: 48 });
    expect(mocks.compute.mock.calls[0]?.[2]).toMatchObject({ hostKey: "one" });
  });

  it("follows the booking's page when rescheduling", async () => {
    mocks.getBookingByToken.mockResolvedValue({
      status: "confirmed",
      attendeeMemberKeys: ["one"],
      pageKey: "one",
    });
    mocks.getPage.mockResolvedValue({
      enabled: true,
      member: { key: "one" },
      config: { ...mocks.config, horizonDays: 7, quorum: 1 },
    });

    await get("?token=manage-token");

    expect(requested()).toEqual({ from: "2026-10-05", days: 10 });
  });

  it("keeps an explicit day count inside the horizon's span", async () => {
    await get("?days=7");
    expect(requested().days).toBe(7);

    mocks.compute.mockClear();
    await get("?days=400");
    expect(requested().days).toBe(33);

    mocks.compute.mockClear();
    await get("?days=0");
    expect(requested().days).toBe(1);
  });

  it("clamps a start past the horizon to its last day", async () => {
    await get("?from=2026-12-01");
    expect(requested().from).toBe("2026-11-04");

    mocks.compute.mockClear();
    await get("?from=2026-11-04");
    expect(requested().from).toBe("2026-11-04");

    mocks.compute.mockClear();
    await get("?from=2026-09-01");
    expect(requested().from).toBe("2026-10-05");
  });
});

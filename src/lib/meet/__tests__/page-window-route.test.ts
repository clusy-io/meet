import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin write path for a booking page's opening and closing hours.
 *
 * The interesting cases are all about a close that lands on the next civil
 * day: the route has to read "08:00 to 02:00" as an 18-hour overnight window
 * and store the close in the canonical form the slot grid reads back
 * (minutes from the opening day's midnight), not as a bare 120.
 */
const mocks = vi.hoisted(() => ({
  getPageSettings: vi.fn(),
  upsertPageSettings: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@/lib/meet/admin", () => ({ requireAdmin: () => true }));
vi.mock("@/lib/meet/availability", () => ({
  invalidateAvailabilityCache: mocks.invalidate,
}));
vi.mock("@/lib/meet/config", () => ({
  getMeetConfig: () => ({ mockMode: false }),
}));
vi.mock("@/lib/meet/crypto", () => ({ encryptSecret: (value: string) => value }));
vi.mock("@/lib/meet/members", () => ({
  getEffectiveMeetConfig: async () => ({
    members: [{ key: "ava", name: "Ava", email: "ava@example.com" }],
    // Team defaults: 08:30 to 22:00, 30-minute meetings on a 30-minute grid.
    windowStartMin: 510,
    windowEndMin: 1320,
    durationMinutes: 30,
    slotStepMinutes: 30,
  }),
}));
vi.mock("@/lib/meet/mock", () => ({ ensureMockReady: vi.fn() }));
vi.mock("@/lib/meet/requestSecurity", () => ({
  hasTrustedMutationOrigin: () => true,
}));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
    getPageSettings: mocks.getPageSettings,
    upsertPageSettings: mocks.upsertPageSettings,
  }),
}));

import { PATCH } from "@/app/api/meet/admin/pages/[memberKey]/route";

const context = { params: Promise.resolve({ memberKey: "ava" }) };

async function patch(body: Record<string, unknown>) {
  const response = await PATCH(
    new Request("https://example.com/api/meet/admin/pages/ava", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    context,
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPageSettings.mockResolvedValue(null);
  mocks.upsertPageSettings.mockResolvedValue({});
});

describe("booking-page hours", () => {
  it("stores 08:00 to 02:00 as an 18-hour overnight window", async () => {
    const { status } = await patch({ windowStart: "08:00", windowEnd: "02:00" });
    expect(status).toBe(200);
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("ava", {
      windowStartMin: 480,
      windowEndMin: 1560,
    });
  });

  it("keeps a same-day window as written", async () => {
    await patch({ windowStart: "09:00", windowEnd: "17:00" });
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("ava", {
      windowStartMin: 540,
      windowEndMin: 1020,
    });
  });

  it("normalizes a lone close against the inherited open", async () => {
    // The open stays inherited (08:30), so 02:00 is still the next day.
    await patch({ windowEnd: "02:00" });
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("ava", {
      windowEndMin: 1560,
    });
  });

  it("re-reads a lone open against the stored overnight close", async () => {
    mocks.getPageSettings.mockResolvedValue({ windowStartMin: 480, windowEndMin: 1560 });
    const { status } = await patch({ windowStart: "20:00" });
    expect(status).toBe(200);
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("ava", {
      windowStartMin: 1200,
    });
  });

  it("rejects an open that would make the stored close more than a day away", async () => {
    mocks.getPageSettings.mockResolvedValue({ windowStartMin: 480, windowEndMin: 1560 });
    const { status, body } = await patch({ windowStart: "01:00" });
    expect(status).toBe(400);
    expect(body.message).toMatch(/24 hours/);
    expect(mocks.upsertPageSettings).not.toHaveBeenCalled();
  });

  it("measures the meeting length against the overnight span", async () => {
    const tooLong = await patch({
      windowStart: "22:00",
      windowEnd: "02:00",
      durationMinutes: 300,
      slotStepMinutes: 300,
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.message).toMatch(/meeting length/i);

    const fits = await patch({
      windowStart: "22:00",
      windowEnd: "02:00",
      durationMinutes: 180,
      slotStepMinutes: 180,
    });
    expect(fits.status).toBe(200);
    expect(mocks.upsertPageSettings).toHaveBeenLastCalledWith("ava", {
      durationMinutes: 180,
      slotStepMinutes: 180,
      windowStartMin: 1320,
      windowEndMin: 1560,
    });
  });

  it("clears both overrides without inventing a window", async () => {
    await patch({ windowStart: null, windowEnd: null });
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("ava", {
      windowStartMin: null,
      windowEndMin: null,
    });
  });

  it("still rejects a close that is not a time", async () => {
    const { status } = await patch({ windowEnd: "26:00" });
    expect(status).toBe(400);
    expect(mocks.upsertPageSettings).not.toHaveBeenCalled();
  });
});

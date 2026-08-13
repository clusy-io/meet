import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reschedule: vi.fn() }));

vi.mock("@/lib/meet/bookings", () => ({
  rescheduleBooking: mocks.reschedule,
  toBookingView: vi.fn(),
}));
vi.mock("@/lib/meet/ratelimit", () => ({ rateLimit: () => true }));
vi.mock("@/lib/meet/requestSecurity", () => ({ hasTrustedMutationOrigin: () => true }));

import { POST } from "@/app/api/meet/bookings/[token]/reschedule/route";

describe("reschedule API conflicts", () => {
  it("returns 409 with the stale-version message", async () => {
    mocks.reschedule.mockResolvedValueOnce({
      ok: false,
      code: "stale",
      message: "This booking changed in another request. Refresh and choose a time again.",
    });
    const request = new Request("https://example.com/api/meet/bookings/token/reschedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: "2026-08-20T17:00:00.000Z", timezone: "UTC" }),
    });

    const response = await POST(request, { params: Promise.resolve({ token: "token" }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      message: "This booking changed in another request. Refresh and choose a time again.",
    });
  });
});

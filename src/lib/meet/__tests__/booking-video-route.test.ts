import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/meet/bookings/route";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/meet/bookings", () => ({ createBooking: mocks.create, toBookingView: () => ({}) }));
vi.mock("@/lib/meet/members", () => ({ listEffectiveMembers: async () => [] }));
vi.mock("@/lib/meet/ratelimit", () => ({ rateLimit: () => true }));
vi.mock("@/lib/meet/requestSecurity", () => ({ hasTrustedMutationOrigin: () => true }));

function request(video?: string) {
  const booking = { name: "Guest", email: "guest@example.com", start: "2026-10-10T09:00:00Z", timezone: "UTC", video };
  return new Request("https://example.com/api/meet/bookings", { method: "POST", body: JSON.stringify(booking) });
}

describe("booking API video preference", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.create.mockResolvedValue({ ok: true, booking: {} });
  });
  it.each([undefined, "meet", "teams"])("passes the chosen service (%s) to booking", async (video) => {
    expect((await POST(request(video))).status).toBe(201);
    expect(mocks.create.mock.calls[0][0].video).toBe(video);
  });
  it("rejects unrecognized providers before creating a booking", async () => {
    expect((await POST(request("unknown"))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

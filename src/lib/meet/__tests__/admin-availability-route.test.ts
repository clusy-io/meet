import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: true, compute: vi.fn() }));
vi.mock("@/lib/meet/admin", () => ({ requireAdmin: () => mocks.admin }));
vi.mock("@/lib/meet/availability", () => ({
  MEMBER_BUSY_TIMELINE_MAX_DAYS: 14,
  computeMemberBusyTimeline: mocks.compute,
}));
import { GET } from "@/app/api/meet/admin/availability/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin = true;
  mocks.compute.mockResolvedValue({ members: [] });
});

describe("admin availability route", () => {
  it("authenticates before parsing", async () => {
    mocks.admin = false;
    const response = await GET(new Request("https://example.com/api/meet/admin/availability?from=no"));
    expect(response.status).toBe(401);
    expect(mocks.compute).not.toHaveBeenCalled();
  });

  it.each([
    ["?from=2026-09-01", 7],
    ["?from=2026-09-01&days=99", 14],
  ])("accepts and clamps %s", async (query, days) => {
    const response = await GET(new Request(`https://example.com/api/meet/admin/availability${query}`));
    expect(response.status).toBe(200);
    expect(mocks.compute).toHaveBeenCalledWith("2026-09-01", days);
  });

  it.each(["", "?from=2026-02-30", "?from=2026-09-01&days=0", "?from=2026-09-01&days=1.5"])(
    "rejects malformed query %s",
    async (query) => {
      const response = await GET(new Request(`https://example.com/api/meet/admin/availability${query}`));
      expect(response.status).toBe(400);
      expect(mocks.compute).not.toHaveBeenCalled();
    }
  );

  it("hides provider failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.compute.mockRejectedValue(new Error("secret"));
    const response = await GET(new Request("https://example.com/api/meet/admin/availability?from=2026-09-01"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "Calendar availability is temporarily unavailable." });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteAccount: vi.fn(),
  getAccount: vi.fn(),
  invalidateAvailabilityCache: vi.fn(),
  listConfirmedBookingsInRange: vi.fn(),
  updateAccount: vi.fn(),
}));

vi.mock("@/lib/meet/admin", () => ({ requireAdmin: () => true }));
vi.mock("@/lib/meet/availability", () => ({
  invalidateAvailabilityCache: mocks.invalidateAvailabilityCache,
}));
vi.mock("@/lib/meet/config", () => ({
  getMeetConfig: () => ({ horizonDays: 21, mockMode: false }),
}));
vi.mock("@/lib/meet/mock", () => ({ ensureMockReady: vi.fn() }));
vi.mock("@/lib/meet/requestSecurity", () => ({
  hasTrustedMutationOrigin: () => true,
}));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
    deleteAccount: mocks.deleteAccount,
    getAccount: mocks.getAccount,
    listConfirmedBookingsInRange: mocks.listConfirmedBookingsInRange,
    updateAccount: mocks.updateAccount,
  }),
}));

import { DELETE, PATCH } from "@/app/api/meet/admin/accounts/[id]/route";

const context = { params: Promise.resolve({ id: "account-1" }) };

describe("admin calendar account availability cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccount.mockResolvedValue({ id: "account-1" });
    mocks.listConfirmedBookingsInRange.mockResolvedValue([]);
    mocks.updateAccount.mockResolvedValue(undefined);
    mocks.deleteAccount.mockResolvedValue(undefined);
  });

  it("invalidates cached availability after calendar selection is saved", async () => {
    const request = new Request(
      "https://example.com/api/meet/admin/accounts/account-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedCalendars: [{ id: "primary", name: "Primary" }],
        }),
      },
    );

    const response = await PATCH(request, context);

    expect(response.status).toBe(200);
    expect(mocks.updateAccount).toHaveBeenCalledWith("account-1", {
      selectedCalendars: [{ id: "primary", name: "Primary" }],
    });
    expect(mocks.invalidateAvailabilityCache).toHaveBeenCalledOnce();
    expect(mocks.updateAccount.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidateAvailabilityCache.mock.invocationCallOrder[0],
    );
  });

  it("invalidates cached availability after an account is disconnected", async () => {
    const request = new Request(
      "https://example.com/api/meet/admin/accounts/account-1",
      { method: "DELETE" },
    );

    const response = await DELETE(request, context);

    expect(response.status).toBe(200);
    expect(mocks.deleteAccount).toHaveBeenCalledWith("account-1");
    expect(mocks.invalidateAvailabilityCache).toHaveBeenCalledOnce();
    expect(mocks.deleteAccount.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.invalidateAvailabilityCache.mock.invocationCallOrder[0],
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeMembers: [
    { key: "one", name: "One", email: "one@example.com", archived: false },
    { key: "two", name: "Two", email: "two@example.com", archived: false },
    {
      key: "three",
      name: "Three",
      email: "three@example.com",
      archived: false,
    },
  ],
  invalidate: vi.fn(),
  listEffectiveMembers: vi.fn(),
  listMemberRecords: vi.fn(),
  getMemberRecord: vi.fn(),
  insertMemberRecord: vi.fn(),
  ensureMemberRecord: vi.fn(),
  upsertMemberRecord: vi.fn(),
  updateMemberIdentity: vi.fn(),
  updateMemberArchivedAt: vi.fn(),
  restoreMemberArchivedAt: vi.fn(),
  getPageSettings: vi.fn(),
  upsertPageSettings: vi.fn(),
  hasFutureBooking: vi.fn(),
  listAccounts: vi.fn(),
}));

vi.mock("@/lib/meet/admin", () => ({ requireAdmin: () => true }));
vi.mock("@/lib/meet/availability", () => ({
  invalidateAvailabilityCache: mocks.invalidate,
}));
vi.mock("@/lib/meet/config", () => ({ getMeetConfig: () => ({ quorum: 2 }) }));
vi.mock("@/lib/meet/members", () => ({
  listEffectiveMembers: mocks.listEffectiveMembers,
  getEffectiveMeetConfig: async () => ({
    members: mocks.activeMembers,
    quorum: 2,
    hostTimezone: "UTC",
    windowStartMin: 540,
    windowEndMin: 1020,
    mockMode: false,
  }),
}));
vi.mock("@/lib/meet/pages", () => ({
  isReservedPageSlug: (key: string) => ["admin", "manage", "api"].includes(key),
}));
vi.mock("@/lib/meet/requestSecurity", () => ({
  hasTrustedMutationOrigin: () => true,
}));
vi.mock("@/lib/meet/mock", () => ({ ensureMockReady: vi.fn() }));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
    listMemberRecords: mocks.listMemberRecords,
    getMemberRecord: mocks.getMemberRecord,
    insertMemberRecord: mocks.insertMemberRecord,
    ensureMemberRecord: mocks.ensureMemberRecord,
    upsertMemberRecord: mocks.upsertMemberRecord,
    updateMemberIdentity: mocks.updateMemberIdentity,
    updateMemberArchivedAt: mocks.updateMemberArchivedAt,
    restoreMemberArchivedAt: mocks.restoreMemberArchivedAt,
    getPageSettings: mocks.getPageSettings,
    upsertPageSettings: mocks.upsertPageSettings,
    hasFutureConfirmedBookingForMember: mocks.hasFutureBooking,
    listAccounts: mocks.listAccounts,
  }),
}));

import { GET as GET_ACCOUNTS } from "@/app/api/meet/admin/accounts/route";
import { POST } from "@/app/api/meet/admin/members/route";
import { DELETE, PATCH } from "@/app/api/meet/admin/members/[memberKey]/route";

const ACTIVE = mocks.activeMembers;
const NOW = "2026-08-31T12:00:00.000Z";
const context = (memberKey: string) => ({
  params: Promise.resolve({ memberKey }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listEffectiveMembers.mockResolvedValue(ACTIVE);
  mocks.listMemberRecords.mockResolvedValue([]);
  mocks.getMemberRecord.mockResolvedValue({
    ...ACTIVE[0],
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  mocks.insertMemberRecord.mockImplementation(async (member) => ({
    ok: true,
    member,
  }));
  mocks.ensureMemberRecord.mockImplementation(async (member) => ({
    ok: true,
    member: { ...member, createdAt: NOW, updatedAt: NOW },
  }));
  mocks.upsertMemberRecord.mockImplementation(async (member) => ({
    ok: true,
    member,
  }));
  mocks.updateMemberIdentity.mockImplementation(async (_memberKey, patch) => ({
    ok: true,
    member: {
      key: "one",
      name: patch.name ?? "One",
      email: patch.email ?? "one@example.com",
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  }));
  mocks.updateMemberArchivedAt.mockImplementation(
    async (memberKey, archivedAt) => ({
      key: memberKey,
      name: memberKey === "one" ? "One" : "London Host",
      email: memberKey === "one" ? "one@example.com" : "host@example.com",
      archivedAt,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  mocks.restoreMemberArchivedAt.mockResolvedValue(true);
  mocks.getPageSettings.mockResolvedValue(null);
  mocks.upsertPageSettings.mockResolvedValue({});
  mocks.hasFutureBooking.mockResolvedValue(false);
  mocks.listAccounts.mockResolvedValue([]);
});

describe("admin member API", () => {
  it("claims identity, creates a paused timezone-aware page, then activates", async () => {
    mocks.getMemberRecord.mockResolvedValueOnce({
      key: "london-host",
      name: "London Host",
      email: "host@example.com",
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const response = await POST(
      new Request("https://example.com/api/meet/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "london-host",
          name: "London Host",
          email: "HOST@EXAMPLE.COM",
          timezone: "Europe/London",
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.insertMemberRecord).toHaveBeenCalledWith({
      key: "london-host",
      name: "London Host",
      email: "host@example.com",
      archivedAt: expect.any(String),
    });
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("london-host", {
      enabled: false,
      timezone: "Europe/London",
    });
    expect(mocks.restoreMemberArchivedAt).toHaveBeenCalledWith(
      "london-host",
      expect.any(String),
    );
    expect(mocks.insertMemberRecord.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.upsertPageSettings.mock.invocationCallOrder[0],
    );
    expect(mocks.upsertPageSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.restoreMemberArchivedAt.mock.invocationCallOrder[0],
    );
  });

  it("does not activate over a concurrent archive marker during setup", async () => {
    mocks.restoreMemberArchivedAt.mockResolvedValueOnce(false);
    const response = await POST(
      new Request("https://example.com/api/meet/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "new-host",
          name: "New Host",
          email: "new-host@example.com",
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(mocks.updateMemberArchivedAt).not.toHaveBeenCalled();
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("new-host", {
      enabled: false,
      timezone: null,
    });
  });

  it("does not let a concurrent duplicate add touch page settings", async () => {
    mocks.insertMemberRecord.mockResolvedValueOnce({
      ok: false,
      reason: "key_taken",
    });
    const response = await POST(
      new Request("https://example.com/api/meet/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "new-host",
          name: "New Host",
          email: "new-host@example.com",
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(mocks.upsertPageSettings).not.toHaveBeenCalled();
    expect(mocks.updateMemberArchivedAt).not.toHaveBeenCalled();
  });

  it("filters archived connections from the active admin response", async () => {
    mocks.listAccounts.mockResolvedValue([
      {
        id: "active-account",
        memberKey: "one",
        provider: "google",
        email: "one@example.com",
        selectedCalendars: [],
        status: "ok",
        createdAt: "2026-08-31T12:00:00.000Z",
      },
      {
        id: "archived-account",
        memberKey: "retired",
        provider: "google",
        email: "retired@example.com",
        selectedCalendars: [],
        status: "ok",
        createdAt: "2026-08-31T12:00:00.000Z",
      },
    ]);
    const response = await GET_ACCOUNTS(
      new Request("https://example.com/api/meet/admin/accounts"),
    );
    await expect(response.json()).resolves.toMatchObject({
      accounts: [{ id: "active-account", memberKey: "one" }],
    });
  });

  it("blocks archive when the future/legacy booking guard reports a match", async () => {
    mocks.hasFutureBooking.mockResolvedValueOnce(true);
    const future = await DELETE(
      new Request("https://example.com/api/meet/admin/members/one", {
        method: "DELETE",
      }),
      context("one"),
    );
    expect(future.status).toBe(409);
    expect(mocks.upsertPageSettings).not.toHaveBeenCalled();
    expect(mocks.updateMemberArchivedAt).not.toHaveBeenCalled();
  });

  it("blocks quorum-breaking removals before querying future bookings", async () => {
    mocks.listEffectiveMembers.mockResolvedValue(ACTIVE.slice(0, 2));
    const quorum = await DELETE(
      new Request("https://example.com/api/meet/admin/members/one", {
        method: "DELETE",
      }),
      context("one"),
    );
    expect(quorum.status).toBe(409);
    expect(mocks.hasFutureBooking).not.toHaveBeenCalled();
  });

  it("patches only requested identity fields and cannot undo a concurrent archive", async () => {
    const archivedAt = "2026-08-31T12:30:00.000Z";
    mocks.updateMemberIdentity.mockResolvedValueOnce({
      ok: true,
      member: {
        key: "one",
        name: "One Renamed",
        email: "concurrent@example.com",
        archivedAt,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    const response = await PATCH(
      new Request("https://example.com/api/meet/admin/members/one", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "One Renamed" }),
      }),
      context("one"),
    );

    expect(mocks.updateMemberIdentity).toHaveBeenCalledWith("one", {
      name: "One Renamed",
    });
    expect(mocks.updateMemberArchivedAt).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      member: {
        key: "one",
        name: "One Renamed",
        email: "concurrent@example.com",
        archived: true,
      },
    });
  });

  it("does not restore when archived:false observed an already-active member", async () => {
    const response = await PATCH(
      new Request("https://example.com/api/meet/admin/members/one", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      }),
      context("one"),
    );

    expect(response.status).toBe(200);
    expect(mocks.updateMemberIdentity).not.toHaveBeenCalled();
    expect(mocks.updateMemberArchivedAt).not.toHaveBeenCalled();
    expect(mocks.upsertPageSettings).not.toHaveBeenCalled();
  });

  it("keeps a concurrent archive marker instead of replacing it", async () => {
    const concurrentMarker = "2026-08-31T12:30:00.000Z";
    mocks.ensureMemberRecord.mockResolvedValueOnce({
      ok: true,
      member: {
        ...ACTIVE[0],
        archivedAt: concurrentMarker,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    const response = await DELETE(
      new Request("https://example.com/api/meet/admin/members/one", {
        method: "DELETE",
      }),
      context("one"),
    );

    expect(response.status).toBe(200);
    expect(mocks.updateMemberArchivedAt).not.toHaveBeenCalled();
    expect(mocks.restoreMemberArchivedAt).not.toHaveBeenCalled();
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("one", {
      enabled: false,
    });
  });

  it("restores the page's prior visibility when an archive is compensated", async () => {
    mocks.getPageSettings.mockResolvedValueOnce({ enabled: true });
    mocks.listEffectiveMembers
      .mockResolvedValueOnce(ACTIVE)
      .mockResolvedValueOnce([
        { ...ACTIVE[0], archived: true },
        { ...ACTIVE[1], archived: true },
        ACTIVE[2],
      ]);

    const response = await DELETE(
      new Request("https://example.com/api/meet/admin/members/one", {
        method: "DELETE",
      }),
      context("one"),
    );

    expect(response.status).toBe(409);
    expect(mocks.restoreMemberArchivedAt).toHaveBeenCalledWith(
      "one",
      expect.any(String),
    );
    expect(mocks.upsertPageSettings.mock.calls).toEqual([
      ["one", { enabled: false }],
      ["one", { enabled: true }],
    ]);
  });

  it("restores the page's prior visibility when the archive write errors", async () => {
    mocks.getPageSettings.mockResolvedValueOnce({ enabled: true });
    mocks.updateMemberArchivedAt.mockRejectedValueOnce(
      new Error("archive write failed"),
    );

    await expect(
      DELETE(
        new Request("https://example.com/api/meet/admin/members/one", {
          method: "DELETE",
        }),
        context("one"),
      ),
    ).rejects.toThrow("archive write failed");
    expect(mocks.upsertPageSettings.mock.calls).toEqual([
      ["one", { enabled: false }],
      ["one", { enabled: true }],
    ]);
  });

  it("compensates an ambiguous page-pause error before any archive write", async () => {
    mocks.getPageSettings.mockResolvedValueOnce({ enabled: true });
    mocks.upsertPageSettings
      .mockRejectedValueOnce(new Error("page pause failed"))
      .mockResolvedValueOnce({});
    mocks.restoreMemberArchivedAt.mockResolvedValueOnce(false);

    await expect(
      DELETE(
        new Request("https://example.com/api/meet/admin/members/one", {
          method: "DELETE",
        }),
        context("one"),
      ),
    ).rejects.toThrow("page pause failed");
    expect(mocks.updateMemberArchivedAt).not.toHaveBeenCalled();
    expect(mocks.upsertPageSettings.mock.calls).toEqual([
      ["one", { enabled: false }],
      ["one", { enabled: true }],
    ]);
  });

  it("pauses before archive and restores without republishing", async () => {
    const archivedAt = "2026-08-30T12:00:00.000Z";
    const archived = [{ ...ACTIVE[0], archived: true }, ACTIVE[1], ACTIVE[2]];
    const removed = await DELETE(
      new Request("https://example.com/api/meet/admin/members/one", {
        method: "DELETE",
      }),
      context("one"),
    );
    expect(removed.status).toBe(200);
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("one", {
      enabled: false,
    });

    vi.clearAllMocks();
    mocks.listEffectiveMembers.mockResolvedValue(archived);
    mocks.listMemberRecords.mockResolvedValue([
      {
        ...ACTIVE[0],
        archivedAt,
        createdAt: archivedAt,
        updatedAt: archivedAt,
      },
    ]);
    mocks.ensureMemberRecord.mockResolvedValue({
      ok: true,
      member: {
        ...ACTIVE[0],
        archivedAt,
        createdAt: archivedAt,
        updatedAt: archivedAt,
      },
    });
    mocks.upsertPageSettings.mockResolvedValue({});
    mocks.getMemberRecord.mockResolvedValue({
      ...ACTIVE[0],
      archivedAt: null,
      createdAt: archivedAt,
      updatedAt: archivedAt,
    });
    const restored = await PATCH(
      new Request("https://example.com/api/meet/admin/members/one", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      }),
      context("one"),
    );
    expect(restored.status).toBe(200);
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("one", {
      enabled: false,
    });
    expect(mocks.restoreMemberArchivedAt).toHaveBeenCalledWith(
      "one",
      archivedAt,
    );
    expect(mocks.updateMemberArchivedAt).not.toHaveBeenCalled();
  });

  it("does not let a stale restore clear a newer archive marker", async () => {
    const observedAt = "2026-08-30T12:00:00.000Z";
    const newerAt = "2026-08-31T12:30:00.000Z";
    mocks.listEffectiveMembers.mockResolvedValue([
      { ...ACTIVE[0], archived: true },
      ACTIVE[1],
      ACTIVE[2],
    ]);
    mocks.ensureMemberRecord.mockResolvedValue({
      ok: true,
      member: {
        ...ACTIVE[0],
        archivedAt: observedAt,
        createdAt: observedAt,
        updatedAt: observedAt,
      },
    });
    mocks.restoreMemberArchivedAt.mockResolvedValueOnce(false);
    mocks.getMemberRecord.mockResolvedValueOnce({
      ...ACTIVE[0],
      archivedAt: newerAt,
      createdAt: observedAt,
      updatedAt: newerAt,
    });

    const response = await PATCH(
      new Request("https://example.com/api/meet/admin/members/one", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      }),
      context("one"),
    );

    expect(response.status).toBe(409);
    expect(mocks.restoreMemberArchivedAt).toHaveBeenCalledWith(
      "one",
      observedAt,
    );
    expect(mocks.updateMemberArchivedAt).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      member: { key: "one", archived: true },
    });
  });
});

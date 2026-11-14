import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/meet/admin/look-busy: the admin switch and its live preview.
 *
 * The preview is the one place hidden times are ever named, so these pin
 * that it stays behind the admin gate, draws what visitors see, and that the
 * switch writes the right row: a member's own, or the team page's "".
 */

const mocks = vi.hoisted(() => ({
  admin: true,
  origin: true,
  plan: vi.fn(),
  getPage: vi.fn(),
  getPageSettings: vi.fn(),
  upsertPageSettings: vi.fn(),
  config: {
    hostTimezone: "UTC",
    windowStartMin: 540,
    windowEndMin: 1020,
    bookableWeekdays: [1, 2, 3, 4, 5],
    durationMinutes: 30,
    slotStepMinutes: 30,
    minNoticeMinutes: 0,
    horizonDays: 4,
    members: [{ key: "ju", name: "Ju", email: "ju@example.com" }],
    quorum: 1,
    eventTitle: "Call with {name}",
    eventDescription: "A test call",
    brandName: "Test",
    siteOrigin: "https://example.com",
    emailFrom: "Test <meet@example.com>",
    organizerEmail: null,
    adminSecret: null,
    tokenSecret: null,
    cronSecret: null,
    mockMode: false,
  },
}));

vi.mock("@/lib/meet/admin", () => ({ requireAdmin: () => mocks.admin }));
vi.mock("@/lib/meet/requestSecurity", () => ({ hasTrustedMutationOrigin: () => mocks.origin }));
vi.mock("@/lib/meet/availability", () => ({ computeAvailabilityPlan: mocks.plan }));
vi.mock("@/lib/meet/members", () => ({
  getRuntimeMeetConfig: async () => mocks.config,
  getEffectiveMeetConfig: async () => mocks.config,
}));
vi.mock("@/lib/meet/mock", () => ({ ensureMockReady: vi.fn() }));
vi.mock("@/lib/meet/pages", () => ({ getPage: mocks.getPage }));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({
    getPageSettings: mocks.getPageSettings,
    upsertPageSettings: mocks.upsertPageSettings,
  }),
}));

import { GET, PATCH } from "@/app/api/meet/admin/look-busy/route";
import type { LookBusyPreview } from "@/components/meet/admin/types";

const MIN = 60_000;
const NOW = Date.parse("2026-08-17T10:00:00.000Z"); // a Monday
const at = (iso: string) => Date.parse(iso);

/** Seven weekdays of 9:00-12:00 slots; the 11:00s are taken, the 9:30s hidden. */
function fakePlan(level: string) {
  const grid: number[] = [];
  for (let day = 0; day < 9; day += 1) {
    for (let slot = 0; slot < 6; slot += 1) grid.push(at("2026-08-17T09:00:00Z") + day * 24 * 60 * MIN + slot * 30 * MIN);
  }
  const taken = (start: number) => new Date(start).getUTCHours() === 11;
  const open = new Set(grid.filter((start) => !taken(start)));
  const hidden = new Set(grid.filter((start) => new Date(start).toISOString().endsWith("09:30:00.000Z")));
  return {
    response: { slots: [], durationMinutes: 30, hostTimezone: "UTC", minNoticeMinutes: 0 },
    lookBusy: { level, grid, open, hidden, bookableFromMs: NOW },
  };
}

async function get(query = "") {
  const response = await GET(new Request(`https://example.com/api/meet/admin/look-busy${query}`));
  return { status: response.status, body: (await response.json()) as LookBusyPreview & { message?: string } };
}

async function patch(body: unknown) {
  const response = await PATCH(
    new Request("https://example.com/api/meet/admin/look-busy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mocks.admin = true;
  mocks.origin = true;
  mocks.plan.mockImplementation(async (_from: string, _days: number, options: { lookBusy: string }) =>
    fakePlan(options.lookBusy),
  );
  mocks.getPageSettings.mockResolvedValue(null);
  mocks.upsertPageSettings.mockResolvedValue({});
  mocks.getPage.mockImplementation(async (key: string) =>
    key === "ju"
      ? {
          member: mocks.config.members[0],
          enabled: false,
          config: { ...mocks.config, hostTimezone: "Europe/London", lookBusy: "light" },
          settings: { lookBusy: "light" },
        }
      : null,
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("the preview", () => {
  it("draws the team page's next five bookable days, as visitors see them", async () => {
    mocks.getPageSettings.mockResolvedValue({ lookBusy: "packed" });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(mocks.getPageSettings).toHaveBeenCalledWith("");
    const [, , options] = mocks.plan.mock.calls[0];
    expect(options).toMatchObject({ hostKey: undefined, lookBusy: "packed" });
    expect(body).toMatchObject({ host: null, level: "packed", storedLevel: "packed", path: "/" });

    expect(body.days.map((day) => day.date)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
    ]);
    // Today starts at 10:00: the times already past are not drawn.
    expect(body.days[0].slots.map((slot) => slot.minute)).toEqual([600, 630, 660, 690]);
    expect(body.days[1].slots.map((slot) => slot.state)).toEqual([
      "open",
      "hidden",
      "open",
      "open",
      "busy",
      "busy",
    ]);
    expect(body.next).toEqual({ visible: 4 * 3 + 2, hidden: 4, busy: 5 * 2 });
    expect(body.horizon).toEqual({ visible: 8 * 3 + 2, hidden: 8, busy: 9 * 2 });
  });

  it("previews any level without saving it", async () => {
    const { body } = await get("?level=light");
    expect(body.level).toBe("light");
    expect(body.storedLevel).toBeNull();
    expect(mocks.upsertPageSettings).not.toHaveBeenCalled();
  });

  it("starts an untouched page at Balanced", async () => {
    expect((await get()).body.level).toBe("balanced");
  });

  it("previews a person's page on its own config, paused or not", async () => {
    const { status, body } = await get("?host=ju");
    expect(status).toBe(200);
    const [, , options] = mocks.plan.mock.calls[0];
    expect(options).toMatchObject({ hostKey: "ju", lookBusy: "light" });
    expect(options.config.hostTimezone).toBe("Europe/London");
    expect(body).toMatchObject({ host: "ju", path: "/ju", storedLevel: "light" });
  });

  it("says so when there is nothing free to preview", async () => {
    mocks.plan.mockImplementation(async () => {
      const plan = fakePlan("balanced");
      plan.lookBusy.open = new Set();
      return plan;
    });
    const { body } = await get();
    expect(body.days).toEqual([]);
    expect(body.horizon.visible + body.horizon.hidden).toBe(0);
  });

  it("refuses unknown people, unknown levels and anyone but an admin", async () => {
    expect((await get("?host=nobody")).status).toBe(404);
    expect((await get("?level=maximum")).status).toBe(400);
    mocks.admin = false;
    expect((await get()).status).toBe(401);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it("answers a calendar failure with a message, not a stack", async () => {
    mocks.plan.mockRejectedValue(new Error("graph timeout"));
    const { status, body } = await get();
    expect(status).toBe(500);
    expect(body.message).not.toContain("graph");
  });
});

describe("the switch", () => {
  it("writes the team page's own row", async () => {
    expect((await patch({ level: "light" })).status).toBe(200);
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("", { lookBusy: "light" });
    await patch({ level: null });
    expect(mocks.upsertPageSettings).toHaveBeenLastCalledWith("", { lookBusy: null });
  });

  it("writes a member's row", async () => {
    await patch({ host: "ju", level: "packed" });
    expect(mocks.upsertPageSettings).toHaveBeenCalledWith("ju", { lookBusy: "packed" });
  });

  it("refuses unknown people, bad levels, other sites and non-admins", async () => {
    expect((await patch({ host: "nobody", level: "light" })).status).toBe(404);
    expect((await patch({ level: "on" })).status).toBe(400);
    expect((await patch({ host: "ju" })).status).toBe(400);
    mocks.origin = false;
    expect((await patch({ level: "light" })).status).toBe(403);
    mocks.origin = true;
    mocks.admin = false;
    expect((await patch({ level: "light" })).status).toBe(401);
    expect(mocks.upsertPageSettings).not.toHaveBeenCalled();
  });
});

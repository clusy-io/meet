import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetConfig } from "@/lib/meet/config";
import { getEffectiveMeetConfig } from "@/lib/meet/members";
import { availableVideoProviders } from "@/lib/meet/videoProviders";

const mocks = vi.hoisted(() => ({
  listConnectedVideoAccounts: vi.fn(),
  seed: vi.fn(),
}));
vi.mock("@/lib/meet/store", () => ({ getMeetStore: () => mocks }));
vi.mock("@/lib/meet/mock", () => ({ ensureMockReady: mocks.seed }));
vi.mock("@/lib/meet/members", () => ({ getEffectiveMeetConfig: vi.fn() }));

const members = ["one", "two", "three"].map((key) => ({ key, name: key, email: key + "@example.com" }));
const config: MeetConfig = {
  hostTimezone: "UTC", windowStartMin: 540, windowEndMin: 1020, bookableWeekdays: [1, 2, 3, 4, 5],
  durationMinutes: 30, slotStepMinutes: 30, minNoticeMinutes: 0, horizonDays: 30, quorum: 1, members,
  siteOrigin: "https://www.example.com", eventTitle: "Meeting", eventDescription: "", brandName: "Example",
  emailFrom: "meet@example.com", cronSecret: null, adminSecret: null, tokenSecret: null, mockMode: false,
};

describe("public video choices", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getEffectiveMeetConfig).mockResolvedValue(config);
  });

  it("defaults to Meet when both healthy provider types can host", async () => {
    mocks.listConnectedVideoAccounts.mockResolvedValue([
      { provider: "microsoft", email: "one@EXAMPLE.com" }, { provider: "google", email: "two@example.com" },
    ]);
    expect(await availableVideoProviders({})).toEqual(["meet", "teams"]);
    expect(mocks.listConnectedVideoAccounts).toHaveBeenCalledWith(["one", "two", "three"]);
  });

  it("looks up only the page owner and shows Teams alone for Microsoft-only hosts", async () => {
    mocks.listConnectedVideoAccounts.mockResolvedValue([{ provider: "microsoft", email: "one@example.com" }]);
    expect(await availableVideoProviders({ host: "one" })).toEqual(["teams"]);
    expect(mocks.listConnectedVideoAccounts).toHaveBeenCalledWith(["one"]);
  });

  it("only offers conference services from hosts eligible for the selected meeting type", async () => {
    vi.mocked(getEffectiveMeetConfig).mockResolvedValue({ ...config, investor: {
      startDate: "2026-11-10", endDate: "2026-11-20", requiredMember: "two", partners: ["three"],
    } });
    mocks.listConnectedVideoAccounts.mockResolvedValue([]);
    expect(await availableVideoProviders({ meetingType: "investor" })).toEqual([]);
    expect(mocks.listConnectedVideoAccounts).toHaveBeenCalledWith(["two", "three"]);
  });

  it("accepts explicitly configured work domains on unrelated booking origins", async () => {
    vi.mocked(getEffectiveMeetConfig).mockResolvedValue({ ...config,
      siteOrigin: "https://scheduling.example.org", teamsDomains: ["organization.example"],
    });
    mocks.listConnectedVideoAccounts.mockResolvedValue([{ provider: "microsoft", email: "one@organization.example" }]);
    expect(await availableVideoProviders({})).toEqual(["teams"]);
  });

  it("offers no video service for a plain Microsoft calendar invitation", async () => {
    mocks.listConnectedVideoAccounts.mockResolvedValue([{ provider: "microsoft", email: "two@other.example" }]);
    expect(await availableVideoProviders({})).toEqual([]);
  });

  it("seeds demo accounts before answering from the store", async () => {
    vi.mocked(getEffectiveMeetConfig).mockResolvedValue({ ...config, mockMode: true });
    mocks.listConnectedVideoAccounts.mockImplementation(async () => {
      expect(mocks.seed).toHaveBeenCalledOnce();
      return [{ provider: "microsoft", email: "one@outlook.example.com" }];
    });
    expect(await availableVideoProviders({})).toEqual(["teams"]);
  });
});

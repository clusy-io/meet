import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMeetConfigCache, getMeetConfig } from "../config";
import { availabilityRange, configForMeetingType, investorWindow, meetingTypeEventCopy, teamMeetingTypes } from "../meetingTypes";

const investorEnv = {
  MEET_INVESTOR_START_DATE: "2027-03-13",
  MEET_INVESTOR_END_DATE: "2027-03-15",
  MEET_INVESTOR_REQUIRED_MEMBER: "required",
  MEET_INVESTOR_PARTNERS: "partner-a, partner-b",
};

function setInvestor(overrides: Partial<typeof investorEnv> = {}) {
  for (const [key, value] of Object.entries({ ...investorEnv, ...overrides })) vi.stubEnv(key, value);
}

beforeEach(() => {
  vi.stubEnv("MEET_MOCK_MODE", "1");
  vi.stubEnv("MEET_HOST_TIMEZONE", "America/Los_Angeles");
  vi.stubEnv("MEET_QUORUM", undefined);
  for (const key of Object.keys(investorEnv)) vi.stubEnv(key, undefined);
  __resetMeetConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetMeetConfigCache();
});

describe("team meeting types", () => {
  it("makes Investor opt-in and keeps the operator's regular meeting settings", () => {
    vi.stubEnv("MEET_MEMBERS", JSON.stringify([
      { key: "a", name: "A", email: "a@example.com" },
      { key: "b", name: "B", email: "b@example.com" },
    ]));
    const base = getMeetConfig();
    expect(base.quorum).toBe(1);
    const config = { ...base, durationMinutes: 45, slotStepMinutes: 60, quorum: 2 };
    expect(teamMeetingTypes(config).map(({ key, durationMinutes }) => [key, durationMinutes]))
      .toEqual([["chat", 15], ["meeting", 45]]);
    expect(configForMeetingType(config, "meeting")).toBe(config);
    expect(configForMeetingType(config, "chat")).toMatchObject({ durationMinutes: 15, quorum: 1 });
    expect(configForMeetingType(config, "investor")).toBeNull();
    expect(investorWindow(config)).toBeUndefined();
    expect(meetingTypeEventCopy(config, "investor").eventTitle).toContain("investor meeting");
  });

  it("uses the active roster when applying the named participant rules", () => {
    setInvestor();
    const config = getMeetConfig();
    const runtimeMembers = ["partner-b", "other", "required", "partner-a"].map((key) => ({
      key, name: key, email: `${key}@example.com`,
    }));
    const investor = configForMeetingType({ ...config, members: runtimeMembers }, "investor");
    expect(investor?.members.map((member) => member.key)).toEqual(["partner-b", "required", "partner-a"]);
    expect(investor).toMatchObject({ quorum: 2, durationMinutes: 30 });
    expect(teamMeetingTypes(config).map(({ label }) => label)).toEqual(["Chat", "Meeting", "Investor"]);
  });

  it("includes the last campaign date in the host timezone through a DST transition", () => {
    setInvestor();
    const config = getMeetConfig();
    expect(investorWindow(config)).toEqual({
      fromMs: Date.parse("2027-03-13T08:00:00Z"),
      toMs: Date.parse("2027-03-16T07:00:00Z"),
    });
    expect(availabilityRange(config, "investor")).toEqual({ from: "2027-03-13", days: 3 });
  });

  it.each([
    { MEET_INVESTOR_END_DATE: "" },
    { MEET_INVESTOR_START_DATE: "2027-02-29" },
    { MEET_INVESTOR_END_DATE: "2027-03-12" },
    { MEET_INVESTOR_REQUIRED_MEMBER: "" },
    { MEET_INVESTOR_REQUIRED_MEMBER: "one,two" },
    { MEET_INVESTOR_PARTNERS: "required,other" },
    { MEET_INVESTOR_PARTNERS: "" },
    { MEET_INVESTOR_PARTNERS: "first,,third" },
  ])("fails closed for an invalid campaign %#", (overrides) => {
    setInvestor(overrides);
    expect(getMeetConfig).toThrow("MEET_INVESTOR_");
  });
});

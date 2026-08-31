import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    members: [
      { key: "one", name: "One", email: "one@example.com" },
      { key: "two", name: "Two", email: "two@example.com" },
    ],
    quorum: 2,
  },
  listMemberRecords: vi.fn(),
}));

vi.mock("@/lib/meet/config", () => ({ getMeetConfig: () => mocks.config }));
vi.mock("@/lib/meet/store", () => ({
  getMeetStore: () => ({ listMemberRecords: mocks.listMemberRecords }),
}));

import {
  getEffectiveMeetConfig,
  getHistoricalMeetConfig,
  getRuntimeMeetConfig,
  listEffectiveMembers,
} from "@/lib/meet/members";

const CREATED = "2026-08-31T12:00:00.000Z";

beforeEach(() => {
  mocks.config.quorum = 2;
  mocks.listMemberRecords.mockReset();
  mocks.listMemberRecords.mockResolvedValue([]);
});

describe("effective meeting roster", () => {
  it("preserves baseline order, overlays identities, appends additions and archives", async () => {
    mocks.listMemberRecords.mockResolvedValue([
      {
        key: "two",
        name: "Two Renamed",
        email: "two-new@example.com",
        archivedAt: CREATED,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
      {
        key: "three",
        name: "Three",
        email: "three@example.com",
        archivedAt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ]);

    expect(await listEffectiveMembers()).toEqual([
      { key: "one", name: "One", email: "one@example.com", archived: false },
      { key: "two", name: "Two Renamed", email: "two-new@example.com", archived: true },
      { key: "three", name: "Three", email: "three@example.com", archived: false },
    ]);
    await expect(getRuntimeMeetConfig()).resolves.toMatchObject({
      members: [
        { key: "one", name: "One", email: "one@example.com" },
        { key: "three", name: "Three", email: "three@example.com" },
      ],
    });
    await expect(getHistoricalMeetConfig()).resolves.toMatchObject({
      members: [
        { key: "one" },
        { key: "two" },
        { key: "three" },
      ],
    });
  });

  it("keeps admin recovery available while strict scheduling enforces quorum", async () => {
    mocks.config.quorum = 3;
    await expect(getEffectiveMeetConfig()).resolves.toMatchObject({
      quorum: 3,
      members: expect.any(Array),
    });
    await expect(getRuntimeMeetConfig()).rejects.toThrow(
      "active member count (2) cannot satisfy quorum 3"
    );
    mocks.listMemberRecords.mockResolvedValue([
      {
        key: "three",
        name: "Three",
        email: "three@example.com",
        archivedAt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ]);
    await expect(getRuntimeMeetConfig()).resolves.toMatchObject({ quorum: 3 });
  });

  it("fails closed on duplicate effective mailboxes from direct DB edits", async () => {
    mocks.listMemberRecords.mockResolvedValue([
      {
        key: "two",
        name: "Two",
        email: "ONE@example.com",
        archivedAt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ]);
    await expect(listEffectiveMembers()).rejects.toThrow("effective member roster is invalid");
  });
});

import { describe, expect, it } from "vitest";
import { teamRecipients } from "@/lib/meet/emails";
import type { Member } from "@/lib/meet/types";

const MEMBERS: Member[] = [
  { key: "ava", name: "Ava", email: "ava@example.com" },
  { key: "ben", name: "Ben", email: "ben@example.com" },
  { key: "cam", name: "Cam", email: "cam@example.com" },
];

describe("teamRecipients", () => {
  it("copies every configured member, not only the attending ones", () => {
    expect(teamRecipients(MEMBERS)).toEqual([
      "ava@example.com",
      "ben@example.com",
      "cam@example.com",
    ]);
  });

  it("dedupes case and whitespace variants so nobody is mailed twice", () => {
    expect(
      teamRecipients([
        { key: "ava", name: "Ava", email: " Ava@Example.com " },
        { key: "ava-alt", name: "Ava", email: "ava@example.com" },
        { key: "blank", name: "Placeholder", email: "  " },
      ])
    ).toEqual(["ava@example.com"]);
  });
});

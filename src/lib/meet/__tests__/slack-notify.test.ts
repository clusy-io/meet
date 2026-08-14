import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking } from "@/lib/meet/types";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  post: vi.fn(),
  webhookForPage: vi.fn(),
  config: {
    hostTimezone: "America/Los_Angeles",
    members: [
      { key: "ju", name: "Ju", email: "ju@example.com" },
      { key: "eldar", name: "Eldar", email: "eldar@example.com" },
    ],
  },
}));

vi.mock("@/lib/meet/config", () => ({ getMeetConfig: () => mocks.config }));
vi.mock("@/lib/meet/pages", () => ({ slackWebhookForPage: mocks.webhookForPage }));
vi.mock("@/lib/meet/slack", () => ({
  getMeetingSlackSettings: mocks.settings,
  postMeetingSlackEvent: mocks.post,
}));

import { notifyBookingSlack } from "@/lib/meet/slackNotify";

const TEAM_HOOK = "https://hooks.slack.com/services/T0/B0/team";
const JU_HOOK = "https://hooks.slack.com/services/T0/B0/ju";
const ENABLED_AT = Date.parse("2026-08-13T00:00:00Z");

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "booking-1",
    pageKey: "",
    startAt: "2026-08-20T17:00:00.000Z",
    endAt: "2026-08-20T17:30:00.000Z",
    durationMinutes: 30,
    name: "Booker",
    email: "booker@example.com",
    notes: null,
    timezone: "America/Los_Angeles",
    attendeeMemberKeys: ["ju"],
    guests: [],
    eventRefs: [],
    meetingUrl: null,
    status: "confirmed",
    manageToken: "tok",
    history: [],
    remindersSent: [],
    syncStatus: "synced",
    createdAt: "2026-08-14T00:00:00.000Z",
    cancelledAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockReturnValue({
    state: "enabled",
    webhookUrl: TEAM_HOOK,
    enabledAtMs: ENABLED_AT,
    referenceSecret: "secret",
  });
  mocks.webhookForPage.mockImplementation(async (pageKey: string, fallback: string) =>
    pageKey === "ju" ? JU_HOOK : fallback
  );
  mocks.post.mockResolvedValue({ ok: true });
});

describe("notifyBookingSlack", () => {
  it("posts a team booking to the team webhook with no host name", async () => {
    await notifyBookingSlack(booking(), "confirmed");
    expect(mocks.post).toHaveBeenCalledTimes(1);
    const [url, event] = mocks.post.mock.calls[0];
    expect(url).toBe(TEAM_HOOK);
    expect(event).toMatchObject({ type: "confirmed", hostName: null, bookerName: "Booker" });
  });

  it("routes a personal booking to that page's webhook and names the host", async () => {
    await notifyBookingSlack(booking({ pageKey: "ju" }), "confirmed");
    const [url, event] = mocks.post.mock.calls[0];
    expect(url).toBe(JU_HOOK);
    expect(event).toMatchObject({ hostName: "Ju" });
  });

  it("carries the previous time on a reschedule", async () => {
    await notifyBookingSlack(booking(), "rescheduled", "2026-08-19T17:00:00.000Z");
    expect(mocks.post.mock.calls[0][1]).toMatchObject({
      type: "rescheduled",
      previousStartAt: "2026-08-19T17:00:00.000Z",
    });
  });

  it("says nothing when Slack is not configured", async () => {
    mocks.settings.mockReturnValue({ state: "disabled" });
    await notifyBookingSlack(booking(), "confirmed");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("does not announce bookings that predate activation", async () => {
    await notifyBookingSlack(booking({ createdAt: "2026-08-01T00:00:00.000Z" }), "confirmed");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("still announces the cancellation of a pre-activation booking", async () => {
    // The cutoff exists to avoid backfilling history, not to hide a change
    // happening right now to a call that is still on the calendar.
    await notifyBookingSlack(booking({ createdAt: "2026-08-01T00:00:00.000Z" }), "cancelled");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("never throws when Slack rejects the post", async () => {
    mocks.post.mockResolvedValue({ ok: false, retryable: true, reason: "server" });
    await expect(notifyBookingSlack(booking(), "confirmed")).resolves.toBeUndefined();
  });

  it("never throws when the transport blows up", async () => {
    // This is the load-bearing guarantee: a Slack outage must not fail a
    // booking, nor make a delivered reminder look undelivered and re-send.
    mocks.post.mockRejectedValue(new Error("boom"));
    await expect(notifyBookingSlack(booking(), "confirmed")).resolves.toBeUndefined();
  });

  it("never throws when webhook resolution blows up", async () => {
    mocks.webhookForPage.mockRejectedValue(new Error("db down"));
    await expect(notifyBookingSlack(booking({ pageKey: "ju" }), "1h")).resolves.toBeUndefined();
  });
});

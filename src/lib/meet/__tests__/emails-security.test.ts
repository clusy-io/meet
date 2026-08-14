import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resendState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  error: null as null | { message: string },
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (mail: Record<string, unknown>) => {
        resendState.calls.push(mail);
        return { data: { id: "email-id" }, error: resendState.error };
      },
    };
  },
}));

import { bookingEventDescription } from "@/lib/meet/bookings";
import { __resetMeetConfigCache, getMeetConfig } from "@/lib/meet/config";
import { sendBookingConfirmed } from "@/lib/meet/emails";
import { buildIcs } from "@/lib/meet/ics";
import type { Booking, Member } from "@/lib/meet/types";

const MEMBERS: Member[] = [
  { key: "one", name: "One", email: "one@example.com" },
  { key: "two", name: "Two", email: "two@example.com" },
];

const BOOKING: Booking = {
  id: "booking-id",
  pageKey: "",
  startAt: "2026-08-20T17:00:00.000Z",
  endAt: "2026-08-20T17:30:00.000Z",
  durationMinutes: 30,
  name: "Booker",
  email: "booker@example.com",
  notes: "Private planning notes",
  timezone: "America/Los_Angeles",
  attendeeMemberKeys: ["one", "two"],
  guests: ["guest@example.com"],
  eventRefs: [],
  meetingUrl: "https://meet.google.com/example",
  status: "confirmed",
  manageToken: "super-secret-token",
  history: [],
  remindersSent: [],
  syncStatus: "synced",
  createdAt: "2026-08-12T00:00:00.000Z",
  cancelledAt: null,
};

const MANAGE_URL = `https://meet.example.com/manage/${BOOKING.manageToken}`;
const ENV_NAMES = [
  "RESEND_API_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "MEET_MEMBERS",
  "MEET_MOCK_MODE",
  "MEET_HOST_TIMEZONE",
  "MEET_EVENT_TITLE",
  "MEET_EVENT_DESCRIPTION",
  "MEET_BRAND_NAME",
  "MEET_EMAIL_FROM",
  "MEET_ADMIN_SECRET",
  "MEET_TOKEN_SECRET",
  "CRON_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "MEET_GOOGLE_CLIENT_ID",
  "MEET_GOOGLE_CLIENT_SECRET",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

beforeEach(() => {
  resendState.calls.length = 0;
  resendState.error = null;
  process.env.RESEND_API_KEY = "re_test";
  process.env.NEXT_PUBLIC_SITE_URL = "https://meet.example.com";
  process.env.MEET_MEMBERS = JSON.stringify(MEMBERS);
  process.env.MEET_HOST_TIMEZONE = "America/Los_Angeles";
  process.env.MEET_EVENT_TITLE = "Test <> {name}";
  process.env.MEET_EVENT_DESCRIPTION = "Test call";
  process.env.MEET_BRAND_NAME = "Test";
  process.env.MEET_EMAIL_FROM = "Test <meet@example.com>";
  process.env.MEET_ADMIN_SECRET = `admin-secret-${"0".repeat(24)}`;
  process.env.MEET_TOKEN_SECRET = `token-secret-${"0".repeat(32)}`;
  process.env.CRON_SECRET = `cron-secret-${"0".repeat(24)}`;
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  process.env.MEET_GOOGLE_CLIENT_ID = "google-client-test";
  process.env.MEET_GOOGLE_CLIENT_SECRET = "google-secret-test";
  delete process.env.MEET_MOCK_MODE;
  __resetMeetConfigCache();
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  __resetMeetConfigCache();
  vi.restoreAllMocks();
});

describe("management-link containment", () => {
  it("keeps the bearer URL out of provider and ICS payloads", () => {
    const config = getMeetConfig();
    expect(bookingEventDescription(config, BOOKING)).not.toContain(BOOKING.manageToken);
    expect(bookingEventDescription(config, BOOKING)).toContain(BOOKING.notes);
    expect(buildIcs(BOOKING, "REQUEST")).not.toContain(BOOKING.manageToken);
  });

  it("includes the manage URL only in the booker's email body", async () => {
    await sendBookingConfirmed(BOOKING, MEMBERS);
    expect(resendState.calls).toHaveLength(2);

    const booker = resendState.calls.find(
      (mail) => JSON.stringify(mail.to) === JSON.stringify([BOOKING.email])
    );
    const team = resendState.calls.find(
      (mail) => JSON.stringify(mail.to) === JSON.stringify(MEMBERS.map((m) => m.email))
    );
    expect(`${booker?.html}\n${booker?.text}`).toContain(MANAGE_URL);
    expect(`${team?.html}\n${team?.text}`).not.toContain(BOOKING.manageToken);

    for (const mail of resendState.calls) {
      const attachments = mail.attachments as Array<{ content: Buffer }>;
      expect(attachments[0]?.content.toString("utf8")).not.toContain(BOOKING.manageToken);
    }
  });

  it("notifies guests individually without a manage token when provider invites failed", async () => {
    const withoutVideo = { ...BOOKING, meetingUrl: null };
    await sendBookingConfirmed(withoutVideo, MEMBERS, { notifyGuestsDirectly: true });

    expect(resendState.calls).toHaveLength(3);
    const guest = resendState.calls.find(
      (mail) => JSON.stringify(mail.to) === JSON.stringify(["guest@example.com"])
    );
    const guestCopy = `${guest?.html}\n${guest?.text}`;
    expect(guestCopy).not.toContain(BOOKING.manageToken);
    expect(guestCopy).toContain("America/Los_Angeles");
    expect(guestCopy).not.toContain("in San Francisco");
    expect(guestCopy).toContain("No video link is available yet");
  });
});

describe("delivery failure propagation", () => {
  it("rejects when Resend reports an error", async () => {
    resendState.error = { message: "provider unavailable" };
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendBookingConfirmed(BOOKING, MEMBERS)).rejects.toThrow(
      "meet email provider rejected"
    );
  });

  it("rejects when production has no Resend API key", async () => {
    delete process.env.RESEND_API_KEY;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendBookingConfirmed(BOOKING, MEMBERS)).rejects.toThrow(
      "RESEND_API_KEY is required outside mock mode"
    );
  });
});

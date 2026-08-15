import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The optional post-booking nudge.
 *
 * Two properties matter here, and the first matters most: a scheduler must
 * advertise NOTHING unless its operator configured something. A fork that
 * silently kept someone else's product pitch in its confirmation emails would
 * be a genuine problem, so "off by default" is pinned rather than assumed.
 *
 * The second is that when it IS configured, the HTML and plaintext bodies of
 * the same email agree. Those bodies are written out separately by hand and
 * have drifted before, invisibly, because almost every client renders the HTML.
 */

const resendState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));
const siteState = vi.hoisted(() => ({
  cta: undefined as undefined | Record<string, string>,
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (mail: Record<string, unknown>) => {
        resendState.calls.push(mail);
        return { data: { id: "email-id" }, error: null };
      },
    };
  },
}));

vi.mock("@/meet.config", () => ({
  get SITE() {
    return {
      name: "Test",
      legalName: "Test Inc.",
      bookingTitle: "Book a call",
      description: "Book a call.",
      homepage: "https://example.com",
      repository: "https://example.com/repo",
      logo: "/logo.png",
      ...(siteState.cta ? { cta: siteState.cta } : {}),
    };
  },
}));

import { __resetMeetConfigCache } from "@/lib/meet/config";
import { productCta } from "@/lib/meet/cta";
import { sendBookingCancelled, sendBookingConfirmed } from "@/lib/meet/emails";
import type { Booking, Member } from "@/lib/meet/types";

const MEMBERS: Member[] = [
  { key: "ada", name: "Ada", email: "ada@example.com" },
  { key: "sam", name: "Sam", email: "sam@example.com" },
];

const BOOKING: Booking = {
  id: "booking-id",
  pageKey: "",
  startAt: "2026-08-20T17:00:00.000Z",
  endAt: "2026-08-20T17:30:00.000Z",
  durationMinutes: 30,
  name: "Booker",
  email: "booker@example.com",
  notes: null,
  timezone: "America/Los_Angeles",
  attendeeMemberKeys: ["ada", "sam"],
  guests: [],
  eventRefs: [],
  meetingUrl: "https://meet.example.com/x",
  status: "confirmed",
  manageToken: "super-secret-token",
  history: [],
  remindersSent: [],
  syncStatus: "synced",
  createdAt: "2026-08-12T00:00:00.000Z",
  cancelledAt: null,
};

const CONFIGURED = {
  lead: "While you wait",
  body: "One sentence about the product.",
  linkLabel: "Take a look",
  href: "https://example.com/product",
};

// Config fails closed outside mock mode, so every required variable has to be
// present for sendBookingConfirmed to get as far as building a body.
const ENV: Record<string, string> = {
  RESEND_API_KEY: "re_test",
  NEXT_PUBLIC_SITE_URL: "https://meet.example.com",
  MEET_MEMBERS: JSON.stringify(MEMBERS),
  MEET_HOST_TIMEZONE: "America/Los_Angeles",
  MEET_EVENT_TITLE: "Test <> {name}",
  MEET_EVENT_DESCRIPTION: "Test call",
  MEET_BRAND_NAME: "Test",
  MEET_EMAIL_FROM: "Test <meet@example.com>",
  MEET_ADMIN_SECRET: `admin-secret-${"0".repeat(24)}`,
  MEET_TOKEN_SECRET: `token-secret-${"0".repeat(32)}`,
  CRON_SECRET: `cron-secret-${"0".repeat(24)}`,
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  MEET_GOOGLE_CLIENT_ID: "google-client-test",
  MEET_GOOGLE_CLIENT_SECRET: "google-secret-test",
};

const originalEnv = Object.fromEntries(
  [...Object.keys(ENV), "MEET_MOCK_MODE"].map((name) => [name, process.env[name]])
);

beforeEach(() => {
  resendState.calls.length = 0;
  siteState.cta = undefined;
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
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

function bookerMail(): string {
  const mail = resendState.calls.find(
    (m) => JSON.stringify(m.to) === JSON.stringify([BOOKING.email])
  );
  return `${mail?.html ?? ""}\n${mail?.text ?? ""}`;
}

describe("off unless configured", () => {
  it("resolves to null with no SITE.cta", () => {
    expect(productCta()).toBeNull();
  });

  it("adds nothing to the confirmation email", async () => {
    await sendBookingConfirmed(BOOKING, MEMBERS);
    const before = bookerMail();
    expect(before).toContain(BOOKING.manageToken); // the email did send
    expect(before.toLowerCase()).not.toContain("while you wait");
  });

  it.each(["lead", "body", "linkLabel", "href"])(
    "stays off when %s is missing, rather than rendering half of it",
    (missing) => {
      siteState.cta = { ...CONFIGURED, [missing]: "" };
      expect(productCta()).toBeNull();
    }
  );
});

describe("when configured", () => {
  beforeEach(() => {
    siteState.cta = CONFIGURED;
  });

  it("puts the same copy in the HTML and the plaintext", async () => {
    await sendBookingConfirmed(BOOKING, MEMBERS);
    const mail = resendState.calls.find(
      (m) => JSON.stringify(m.to) === JSON.stringify([BOOKING.email])
    );
    for (const body of [String(mail?.html), String(mail?.text)]) {
      expect(body).toContain(CONFIGURED.lead);
      expect(body).toContain(CONFIGURED.body);
      expect(body).toContain(CONFIGURED.href);
      expect(body).toContain(CONFIGURED.linkLabel);
    }
  });

  it("keeps it off the team copy and off cancellations", async () => {
    await sendBookingConfirmed(BOOKING, MEMBERS);
    const team = resendState.calls.find(
      (m) => JSON.stringify(m.to) === JSON.stringify(MEMBERS.map((x) => x.email))
    );
    expect(`${team?.html}\n${team?.text}`).not.toContain(CONFIGURED.body);

    resendState.calls.length = 0;
    await sendBookingCancelled({ ...BOOKING, status: "cancelled" }, MEMBERS);
    for (const mail of resendState.calls) {
      expect(`${mail.html}\n${mail.text}`).not.toContain(CONFIGURED.body);
    }
  });
});

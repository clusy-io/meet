import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMeetConfigCache } from "@/lib/meet/config";
import {
  buildMeetingSlackPayload,
  getMeetingSlackSettings,
  parseMeetingSlackEnabledAt,
  postMeetingSlackEvent,
  validateMeetingSlackWebhook,
  type MeetingSlackEvent,
} from "@/lib/meet/slack";

const HOOK = "https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnopqrst";

const EVENT: MeetingSlackEvent = {
  bookingId: "booking-1",
  type: "confirmed",
  startAt: "2026-08-20T17:00:00.000Z",
  endAt: "2026-08-20T17:30:00.000Z",
  hostName: null,
  bookerName: "Dana Booker",
};

const saved = { ...process.env };
beforeEach(() => {
  // This repo fails closed outside mock mode: getMeetConfig() throws unless the
  // production-required values are present, and the settings gate calls it.
  process.env.MEET_MEMBERS = JSON.stringify([
    { key: "one", name: "One", email: "one@example.com" },
  ]);
  process.env.NEXT_PUBLIC_SITE_URL = "https://meet.example.com";
  process.env.MEET_EVENT_TITLE = "Example <> {name}";
  process.env.MEET_EVENT_DESCRIPTION = "An example call.";
  process.env.MEET_BRAND_NAME = "Example";
  process.env.MEET_EMAIL_FROM = "Example <meet@example.com>";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "s".repeat(40);
  process.env.RESEND_API_KEY = "re_test";
  process.env.MEET_GOOGLE_CLIENT_ID = "example.apps.googleusercontent.com";
  process.env.MEET_GOOGLE_CLIENT_SECRET = "google-secret";
  process.env.MEET_HOST_TIMEZONE = "America/Los_Angeles";
  process.env.MEET_WINDOW_START = "08:30";
  process.env.MEET_WINDOW_END = "22:00";
  process.env.MEET_DURATION_MINUTES = "30";
  process.env.MEET_SLOT_STEP_MINUTES = "30";
  process.env.MEET_MIN_NOTICE_MINUTES = "240";
  process.env.MEET_HORIZON_DAYS = "21";
  process.env.MEET_QUORUM = "1";
  process.env.MEET_ADMIN_SECRET = "a".repeat(32);
  process.env.CRON_SECRET = "c".repeat(32);
  process.env.MEET_TOKEN_SECRET = "x".repeat(32);
  __resetMeetConfigCache();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
  __resetMeetConfigCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("webhook validation (SSRF fence)", () => {
  it("accepts a canonical incoming webhook", () => {
    expect(validateMeetingSlackWebhook(HOOK)).toBe(HOOK);
  });

  it.each([
    ["http, not https", HOOK.replace("https:", "http:")],
    ["another host", HOOK.replace("hooks.slack.com", "hooks.slack.com.evil.test")],
    ["an internal address", "https://169.254.169.254/services/A/B/C"],
    ["a query string", `${HOOK}?x=1`],
    ["a fragment", `${HOOK}#x`],
    ["credentials", HOOK.replace("https://", "https://user:pass@")],
    ["a wrong path shape", "https://hooks.slack.com/api/chat.postMessage"],
    ["untrimmed input", ` ${HOOK} `],
    ["nothing", undefined],
  ])("rejects %s", (_label, value) => {
    expect(validateMeetingSlackWebhook(value as string | undefined)).toBeNull();
  });
});

describe("activation timestamp", () => {
  it("accepts a canonical ISO-Z instant", () => {
    expect(parseMeetingSlackEnabledAt("2026-08-13T00:00:00Z", Date.parse("2026-08-14T00:00:00Z")))
      .toBe(Date.parse("2026-08-13T00:00:00Z"));
  });

  it("rejects a non-canonical or future value", () => {
    const now = Date.parse("2026-08-14T00:00:00Z");
    expect(parseMeetingSlackEnabledAt("2026-08-13 00:00:00", now)).toBeNull();
    expect(parseMeetingSlackEnabledAt("2026-08-13T00:00:00+02:00", now)).toBeNull();
    expect(parseMeetingSlackEnabledAt("2026-09-01T00:00:00Z", now)).toBeNull();
  });
});

describe("settings gate", () => {
  it("stays disabled outside production even with a webhook", () => {
    process.env.MEET_SLACK_WEBHOOK_URL = HOOK;
    process.env.MEET_SLACK_ENABLED_AT = "2026-08-13T00:00:00Z";
    vi.stubEnv("NODE_ENV", "development");
    expect(getMeetingSlackSettings().state).toBe("disabled");
  });

  it("stays disabled with a webhook but no activation timestamp", () => {
    process.env.MEET_SLACK_WEBHOOK_URL = HOOK;
    delete process.env.MEET_SLACK_ENABLED_AT;
    vi.stubEnv("NODE_ENV", "production");
    expect(getMeetingSlackSettings().state).toBe("disabled");
  });

  it("is enabled in production with both set", () => {
    process.env.MEET_SLACK_WEBHOOK_URL = HOOK;
    process.env.MEET_SLACK_ENABLED_AT = "2026-08-13T00:00:00Z";
    process.env.MEET_TOKEN_SECRET = "x".repeat(32);
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.MEET_MOCK_MODE;
    const settings = getMeetingSlackSettings();
    expect(settings.state).toBe("enabled");
  });
});

describe("payload", () => {
  const render = (event: MeetingSlackEvent) =>
    JSON.stringify(buildMeetingSlackPayload(event, "America/Los_Angeles", "secret"));

  it("names the host for a personal booking and the team otherwise", () => {
    expect(render({ ...EVENT, hostName: "Ju" })).toContain("call with Ju");
    expect(render(EVENT)).toContain("intro call");
  });

  it("says who booked it, in the blocks and in the notification fallback", () => {
    const payload = buildMeetingSlackPayload(
      { ...EVENT, hostName: "Ju" },
      "America/Los_Angeles",
      "secret"
    );
    expect(JSON.stringify(payload.blocks)).toContain("Dana Booker");
    expect(payload.text).toContain("Dana Booker");
  });

  it("escapes a booker name that would otherwise inject Slack markup", () => {
    // Slack resolves <...> as a link and <!channel> as an everyone-ping, so an
    // unescaped name could turn a booking notice into either.
    const blob = render({ ...EVENT, bookerName: "<!channel> <https://evil.test|click>" });
    expect(blob).not.toContain("<!channel>");
    expect(blob).not.toContain("<https://evil.test");
    expect(blob).toContain("&lt;!channel&gt;");
  });

  it("collapses newlines in a booker name so it cannot forge a line", () => {
    const payload = buildMeetingSlackPayload(
      { ...EVENT, bookerName: "Real Name\nReference: forged" },
      "UTC",
      "secret"
    );
    expect(payload.text.split("\n")).toHaveLength(1);
  });

  it("falls back to a placeholder rather than rendering an empty name", () => {
    expect(render({ ...EVENT, bookerName: "   " })).toContain("Someone");
  });

  it("shows both times on a reschedule", () => {
    const blob = render({
      ...EVENT,
      type: "rescheduled",
      previousStartAt: "2026-08-19T17:00:00.000Z",
    });
    expect(blob).toContain("*Was*");
    expect(blob).toContain("*Now*");
  });

  it("leaks no booker email, manage token or manage link", () => {
    // A Slack channel is a shared surface. The booker's NAME and the join link
    // are deliberately included; their email address is not, and the manage
    // token is a bearer capability that can cancel or move the booking, so it
    // must never reach it.
    const payload = buildMeetingSlackPayload(
      { ...EVENT, hostName: "Ju", meetingUrl: "https://meet.google.com/abc-defg-hij" },
      "America/Los_Angeles",
      "secret"
    );
    const blob = JSON.stringify(payload);
    expect(blob).not.toContain("/meet/manage");
    expect(blob).not.toContain("super-secret");
    expect(blob).not.toContain(EVENT.bookingId);
    expect(blob).not.toMatch(/[\w.]+@[\w.]+/);
  });

  it("offers a join button when there is a meeting URL", () => {
    const payload = buildMeetingSlackPayload(
      { ...EVENT, meetingUrl: "https://meet.google.com/abc-defg-hij" },
      "UTC",
      "secret"
    );
    const actions = payload.blocks.find((b) => b.type === "actions") as
      | { elements: Array<{ url: string; text: { text: string } }> }
      | undefined;
    expect(actions?.elements[0].url).toBe("https://meet.google.com/abc-defg-hij");
    expect(actions?.elements[0].text.text).toBe("Join the call");
  });

  it("keeps hyphenated Meet codes intact", () => {
    // A guard that rejected hyphens would silently drop every Google Meet link.
    const url = "https://meet.google.com/abc-defg-hij";
    expect(JSON.stringify(buildMeetingSlackPayload({ ...EVENT, meetingUrl: url }, "UTC", "s")))
      .toContain(url);
  });

  it("offers no join button on a cancellation, and none without a URL", () => {
    const cancelled = buildMeetingSlackPayload(
      { ...EVENT, type: "cancelled", meetingUrl: "https://meet.google.com/abc-defg-hij" },
      "UTC",
      "secret"
    );
    expect(cancelled.blocks.some((b) => b.type === "actions")).toBe(false);
    const noUrl = buildMeetingSlackPayload({ ...EVENT, meetingUrl: null }, "UTC", "secret");
    expect(noUrl.blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("refuses a join URL that could forge extra lines or is not https", () => {
    for (const bad of [
      "https://evil.test/x\nReference: forged",
      "http://meet.google.com/abc-defg-hij",
      "javascript:alert(1)",
      "not a url",
    ]) {
      const payload = buildMeetingSlackPayload({ ...EVENT, meetingUrl: bad }, "UTC", "secret");
      expect(payload.blocks.some((b) => b.type === "actions")).toBe(false);
    }
  });

  it("disables unfurling so Slack fetches nothing on our behalf", () => {
    const payload = buildMeetingSlackPayload(EVENT, "UTC", "secret");
    expect(payload.unfurl_links).toBe(false);
    expect(payload.unfurl_media).toBe(false);
  });

  it("gives each event a stable, non-reversible reference", () => {
    const ref = (event: MeetingSlackEvent) =>
      /`([0-9a-f]{12})`/.exec(
        JSON.stringify(buildMeetingSlackPayload(event, "UTC", "secret"))
      )?.[1];
    expect(ref(EVENT)).toBe(ref(EVENT));
    expect(ref(EVENT)).not.toBe(ref({ ...EVENT, type: "cancelled" }));
  });
});

describe("delivery classification", () => {
  const post = (impl: typeof fetch) =>
    postMeetingSlackEvent(HOOK, EVENT, "UTC", "secret", impl);

  it("reports success on 200", async () => {
    const res = await post((async () => new Response("ok", { status: 200 })) as typeof fetch);
    expect(res).toEqual({ ok: true });
  });

  it("treats 429 as retryable and reads retry-after", async () => {
    const res = await post((async () =>
      new Response("", { status: 429, headers: { "retry-after": "30" } })) as typeof fetch);
    expect(res).toMatchObject({ ok: false, retryable: true, reason: "rate", retryAfterMs: 30_000 });
  });

  it("treats 5xx as retryable and 4xx as not", async () => {
    expect(await post((async () => new Response("", { status: 503 })) as typeof fetch))
      .toMatchObject({ retryable: true, reason: "server" });
    expect(await post((async () => new Response("", { status: 404 })) as typeof fetch))
      .toMatchObject({ retryable: false, reason: "client" });
  });

  it("classifies a network failure without throwing", async () => {
    const res = await post((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(res).toMatchObject({ ok: false, retryable: true, reason: "network" });
  });
});

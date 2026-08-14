import "server-only";

import { createHmac } from "crypto";
import { getMeetConfig } from "./config";

/**
 * meet — Slack notifications.
 *
 * Notifications are posted inline from the booking lifecycle, next to the
 * emails, rather than through a durable outbox. That trade is deliberate: an
 * outbox buys at-least-once delivery at the cost of a table, a lease and a
 * dispatcher, which is more machinery than a booking notice warrants. The
 * consequence is that a failed post is not retried; see the README.
 *
 * Payload policy: a Slack channel is a shared surface, so the message carries
 * the event, the times, the host, who booked, the join link and a keyed
 * reference, and nothing else. No booker email address, no notes, no guests,
 * and above all no manage token or /meet/manage URL.
 *
 * The booker's NAME is the one piece of visitor-supplied text in the payload,
 * which makes it the only injection surface here: see escapeMrkdwn.
 *
 * The join link and the manage link are not the same kind of secret and are
 * treated differently on purpose. The join link lets someone attend a call the
 * channel's members are attending anyway, which is why it is useful there. The
 * manage token lets anyone holding it cancel or move the booking, so it stays
 * out, and a test asserts that.
 *
 * Link unfurling is off so Slack cannot fetch anything on our behalf.
 *
 * Server-only.
 */

const WEBHOOK_MAX_LENGTH = 512;
const PAYLOAD_MAX_BYTES = 8_192;
const REQUEST_TIMEOUT_MS = 3_000;
const ENABLED_AT_MAX_FUTURE_SKEW_MS = 5 * 60_000;

export type MeetingSlackEventType = "confirmed" | "rescheduled" | "cancelled" | "24h" | "1h";

export interface MeetingSlackEvent {
  bookingId: string;
  type: MeetingSlackEventType;
  /** UTC ISO instants of the booking as it stands after this event. */
  startAt: string;
  endAt: string;
  /** Only on "rescheduled". */
  previousStartAt?: string;
  /** Display name of the person the call is with; null for a team booking. */
  hostName: string | null;
  /** Who booked it. Untrusted: escaped before it reaches the payload. */
  bookerName: string;
  /**
   * Provider video-call URL, when one exists. Omitted on cancellations, where
   * a join link is dead and only invites misclicks.
   */
  meetingUrl?: string | null;
}

export type MeetingSlackFailureReason =
  | "rate"
  | "server"
  | "client"
  | "timeout"
  | "network"
  | "invalid";

export type SlackPostResult =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: MeetingSlackFailureReason; retryAfterMs?: number };

export type MeetingSlackSettings =
  | { state: "disabled" }
  | { state: "invalid" }
  | { state: "enabled"; webhookUrl: string; enabledAtMs: number; referenceSecret: string };

/**
 * Block Kit, with `text` kept as the notification fallback: that is what shows
 * in the sidebar, in push notifications and in any client that cannot render
 * blocks, so it must stand alone.
 */
type SlackBlock = Record<string, unknown>;

type MeetingSlackPayload = {
  text: string;
  blocks: SlackBlock[];
  unfurl_links: false;
  unfurl_media: false;
};

/**
 * Strictly accept only Slack's canonical Incoming Webhook URL shape.
 *
 * This is an SSRF fence, not tidiness: the server POSTs to whatever comes back
 * from here, including per-page webhooks typed into /meet/admin.
 */
export function validateMeetingSlackWebhook(raw: string | undefined): string | null {
  if (!raw || raw.length > WEBHOOK_MAX_LENGTH || raw.trim() !== raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "hooks.slack.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/services\/[A-Za-z0-9_-]{8,128}\/[A-Za-z0-9_-]{8,128}\/[A-Za-z0-9_-]{8,192}$/.test(
      url.pathname
    )
  ) {
    return null;
  }
  return url.toString();
}

/** Canonical ISO-Z only, and never meaningfully in the future. */
export function parseMeetingSlackEnabledAt(
  raw: string | undefined,
  nowMs: number = Date.now()
): number | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw)) return null;
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) return null;
  const canonical = new Date(value).toISOString();
  if (raw !== canonical && raw !== `${canonical.slice(0, -5)}Z`) return null;
  if (!Number.isFinite(nowMs) || value > nowMs + ENABLED_AT_MAX_FUTURE_SKEW_MS) return null;
  return value;
}

export function isValidMeetingSlackDisplayTimezone(hostTimezone: string): boolean {
  if (!/^[A-Za-z0-9_+/-]{1,64}$/.test(hostTimezone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: hostTimezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail-closed in four independent ways: mock mode is silent, any non-production
 * non-production environment is silent, including Vercel previews (so a
 * preview branch cannot post into the real channel even if a secret is copied
 * into it), a webhook without an activation timestamp is off, and anything
 * malformed is "invalid" rather than a guess.
 *
 * MEET_SLACK_ENABLED_AT doubles as the on switch and as the cutoff: nothing
 * that happened before it is ever announced.
 */
export function getMeetingSlackSettings(): MeetingSlackSettings {
  const rawWebhook = process.env.MEET_SLACK_WEBHOOK_URL;
  const rawEnabledAt = process.env.MEET_SLACK_ENABLED_AT;
  if (!rawWebhook && !rawEnabledAt) return { state: "disabled" };
  // Webhook-first rollout is intentional: the webhook can be stored and
  // checked before anything is allowed to post.
  if (rawWebhook && !rawEnabledAt) return { state: "disabled" };
  if (!rawWebhook || !rawEnabledAt) return { state: "invalid" };
  const config = getMeetConfig();
  // Both gates, because neither alone is right.
  //
  // NODE_ENV covers self-hosting: this template is documented as deployable to
  // any Node host, where VERCEL_ENV is simply unset, and keying off VERCEL_ENV
  // there would leave Slack silently dead while /admin reported it configured.
  //
  // VERCEL_ENV covers Vercel, where PREVIEW deployments also run with
  // NODE_ENV=production. Without this second check a preview branch would post
  // into the real channel, which is exactly what "previews stay silent" above
  // promises it will not do.
  const vercelEnv = process.env.VERCEL_ENV;
  if (
    config.mockMode ||
    process.env.NODE_ENV !== "production" ||
    (vercelEnv !== undefined && vercelEnv !== "production")
  ) {
    return { state: "disabled" };
  }
  const webhookUrl = validateMeetingSlackWebhook(rawWebhook);
  const enabledAtMs = parseMeetingSlackEnabledAt(rawEnabledAt);
  if (
    !webhookUrl ||
    enabledAtMs === null ||
    !config.tokenSecret ||
    !isValidMeetingSlackDisplayTimezone(config.hostTimezone)
  ) {
    return { state: "invalid" };
  }
  return { state: "enabled", webhookUrl, enabledAtMs, referenceSecret: config.tokenSecret };
}

/**
 * Short, keyed, non-reversible handle for correlating a Slack line with a
 * booking without putting the booking id (or anything else identifying) in a
 * shared channel.
 */
export function meetingSlackEventReference(event: MeetingSlackEvent, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${event.bookingId}\u001f${event.type}\u001f${event.startAt}`)
    .digest("hex")
    .slice(0, 12);
}

function formatInstant(iso: string, hostTimezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: hostTimezone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

const EVENT_LABELS: Record<MeetingSlackEventType, string> = {
  confirmed: "Booked",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
  "24h": "Starting in 24 hours",
  "1h": "Starting in 1 hour",
};

/** One glyph per event so the channel is scannable without reading. */
const EVENT_ICONS: Record<MeetingSlackEventType, string> = {
  confirmed: ":white_check_mark:",
  rescheduled: ":arrows_counterclockwise:",
  cancelled: ":x:",
  "24h": ":alarm_clock:",
  "1h": ":alarm_clock:",
};

/**
 * A join URL safe to drop into the message.
 *
 * The Slack `text` field is a newline-delimited format we assemble by hand, so
 * a URL containing a newline could forge extra lines (a fake "Reference:", say).
 * Requiring https and rejecting any whitespace or control character removes
 * that, and keeps a non-URL value from being rendered as if it were a link.
 */
/**
 * Make visitor-supplied text safe for a Slack mrkdwn field.
 *
 * Slack resolves `<...>` as links and `<!channel>` as a broadcast, so an
 * unescaped name could turn a booking notice into a link to anywhere or an
 * everyone-ping. Slack's own rule is to escape exactly & < >. Newlines are
 * collapsed too, since the fallback `text` is a newline-delimited string we
 * assemble by hand and a name carrying one could forge a line in it.
 */
function escapeMrkdwn(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeJoinUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512 || /[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

export function buildMeetingSlackPayload(
  event: MeetingSlackEvent,
  hostTimezone: string,
  referenceSecret: string
): MeetingSlackPayload {
  if (!isValidMeetingSlackDisplayTimezone(hostTimezone)) {
    throw new Error("meet Slack display timezone is invalid");
  }

  const label = EVENT_LABELS[event.type];
  // The host name is ours, so it needs no escaping; the booker's does.
  // Deliberately brand-free: this builder stays pure so it can be exercised
  // without a full runtime config, and the host name already carries whatever
  // specificity a personal booking needs.
  const subject = event.hostName ? `call with ${event.hostName}` : "intro call";
  const booker = escapeMrkdwn(event.bookerName) || "Someone";
  const current = formatInstant(event.startAt, hostTimezone);
  const minutes = Math.max(
    0,
    Math.round((Date.parse(event.endAt) - Date.parse(event.startAt)) / 60_000)
  );
  const joinUrl = event.type === "cancelled" ? null : safeJoinUrl(event.meetingUrl);

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${EVENT_ICONS[event.type]}  *${label}*\n*${booker}* — ${subject}`,
      },
    },
  ];

  // A reschedule is the one case where two instants matter, so it gets its own
  // stacked pair rather than being squeezed into the side-by-side fields.
  if (event.type === "rescheduled" && event.previousStartAt) {
    blocks.push({
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Was*\n~${formatInstant(event.previousStartAt, hostTimezone)}~`,
        },
        { type: "mrkdwn", text: `*Now*\n${current}` },
      ],
    });
  } else {
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*${event.type === "cancelled" ? "Was" : "When"}*\n${current}` },
        { type: "mrkdwn", text: `*Duration*\n${minutes} minutes` },
      ],
    });
  }

  if (joinUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Join the call", emoji: false },
          url: joinUrl,
          style: "primary",
        },
      ],
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${hostTimezone.replaceAll("_", " ")}  ·  \`${meetingSlackEventReference(
          event,
          referenceSecret
        )}\``,
      },
    ],
  });

  return {
    // Fallback for notifications and non-block clients; must read on its own.
    text: `${label}: ${booker} — ${subject}, ${current}`,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  };
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw || !/^\d{1,5}$/.test(raw)) return undefined;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 1) return undefined;
  return Math.min(seconds, 3_600) * 1_000;
}

async function postPayload(
  webhookUrl: string,
  payload: MeetingSlackPayload,
  fetchImpl: typeof fetch = fetch
): Promise<SlackPostResult> {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > PAYLOAD_MAX_BYTES) {
    return { ok: false, retryable: false, reason: "invalid" };
  }
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body,
      // A hung Slack call must not hold a serverless invocation open past the
      // booking response the visitor is waiting on.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (response.status === 200) return { ok: true };
    if (response.status === 429) {
      const retryAfter = retryAfterMs(response);
      return {
        ok: false,
        retryable: true,
        reason: "rate",
        ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
      };
    }
    if (response.status >= 500) return { ok: false, retryable: true, reason: "server" };
    return { ok: false, retryable: false, reason: "client" };
  } catch (error) {
    const name =
      typeof error === "object" && error !== null && "name" in error
        ? String((error as { name: unknown }).name)
        : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, retryable: true, reason: "timeout" };
    }
    if (error instanceof TypeError) return { ok: false, retryable: true, reason: "network" };
    throw error;
  }
}

export async function postMeetingSlackEvent(
  webhookUrl: string,
  event: MeetingSlackEvent,
  hostTimezone: string,
  referenceSecret: string,
  fetchImpl: typeof fetch = fetch
): Promise<SlackPostResult> {
  return postPayload(
    webhookUrl,
    buildMeetingSlackPayload(event, hostTimezone, referenceSecret),
    fetchImpl
  );
}

/** Fixed synthetic message: no booking lookup, no event state, no user content. */
export async function postMeetingSlackSynthetic(
  webhookUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<SlackPostResult> {
  return postPayload(
    webhookUrl,
    {
      text: "Synthetic test: meeting notifications",
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: ":satellite_antenna:  Synthetic test — meeting notifications, webhook delivery check",
            },
          ],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    },
    fetchImpl
  );
}

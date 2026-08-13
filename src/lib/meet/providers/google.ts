import "server-only";
import { google, type calendar_v3 } from "googleapis";
import {
  ProviderAuthError,
  type BusyInterval,
  type CalendarProvider,
  type CreatedEvent,
  type CreateEventInput,
  type ProviderCalendarListEntry,
  type ProviderTokens,
} from "../types";

/**
 * clusy/meet: Google Calendar provider.
 *
 * Stateless by design: every method builds a fresh OAuth2 client seeded with
 * the (decrypted) refresh token, and googleapis mints access tokens on demand.
 * A revoked grant surfaces as invalid_grant or a 401; both are normalized to
 * ProviderAuthError so callers can flip the account to "reauth_required".
 */

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
];
const REQUEST_TIMEOUT_MS = 15_000;

function newOAuthClient(redirectUri?: string, refreshToken?: string) {
  const clientId = process.env.MEET_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.MEET_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("meet: MEET_GOOGLE_CLIENT_ID / MEET_GOOGLE_CLIENT_SECRET are not set");
  }
  const client = new google.auth.OAuth2({
    clientId,
    clientSecret,
    redirectUri,
    // Applies to OAuth token refresh/exchange and authenticated Google API
    // requests made through this client; do not let a provider stall a
    // serverless invocation indefinitely.
    transporterOptions: { timeout: REQUEST_TIMEOUT_MS },
  });
  if (refreshToken) client.setCredentials({ refresh_token: refreshToken });
  return client;
}

function calendarFor(refreshToken: string): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: newOAuthClient(undefined, refreshToken) });
}

/** Best-effort HTTP status from a gaxios/googleapis error shape. */
function errStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown } | null;
  };
  for (const candidate of [e.status, e.response?.status, e.code]) {
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  return null;
}

function mentionsInvalidGrant(err: unknown): boolean {
  if (err instanceof Error && err.message.includes("invalid_grant")) return true;
  const data = (err as { response?: { data?: unknown } | null } | null)?.response?.data;
  if (data === undefined || data === null) return false;
  try {
    return JSON.stringify(data).includes("invalid_grant");
  } catch {
    return false;
  }
}

/**
 * Normalize revoked-grant failures (invalid_grant, or a 401 that survives
 * the automatic token refresh) to ProviderAuthError; everything else
 * propagates untouched.
 */
async function withAuthGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (mentionsInvalidGrant(err) || errStatus(err) === 401) {
      const detail = err instanceof Error ? err.message : "invalid_grant";
      throw new ProviderAuthError("google", detail);
    }
    throw err;
  }
}

/** Read "email" from an OIDC id_token without verification (issuer is Google over TLS). */
function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  const segments = idToken.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    if (typeof payload === "object" && payload !== null) {
      const email = (payload as { email?: unknown }).email;
      if (typeof email === "string" && email.length > 0) return email;
    }
  } catch {
    // Malformed token: fall through to the userinfo endpoint.
  }
  return null;
}

export const googleProvider: CalendarProvider = {
  id: "google",

  getAuthUrl(state: string, redirectUri: string): string {
    return newOAuthClient(redirectUri).generateAuthUrl({
      access_type: "offline",
      // select_account: members connect SEVERAL accounts of the same
      // provider, so the chooser must always appear instead of silently
      // reusing whichever session is active. consent: force a refresh
      // token on every connect.
      prompt: "consent select_account",
      scope: SCOPES,
      state,
    });
  },

  async exchangeCode(code: string, redirectUri: string): Promise<ProviderTokens> {
    return withAuthGuard(async () => {
      const client = newOAuthClient(redirectUri);
      const { tokens } = await client.getToken(code);
      const accessToken = tokens.access_token;
      if (!accessToken) throw new Error("google: token exchange returned no access token");

      let email = emailFromIdToken(tokens.id_token);
      if (!email) {
        client.setCredentials(tokens);
        const { data } = await google.oauth2({ version: "v2", auth: client }).userinfo.get();
        email = typeof data.email === "string" && data.email.length > 0 ? data.email : null;
      }
      if (!email) throw new Error("google: could not resolve the account email");

      return {
        accessToken,
        refreshToken: tokens.refresh_token ?? undefined,
        expiresAtMs: tokens.expiry_date ?? Date.now() + 3_600_000,
        email,
      };
    });
  },

  async listCalendars(refreshToken: string): Promise<ProviderCalendarListEntry[]> {
    return withAuthGuard(async () => {
      const calendar = calendarFor(refreshToken);
      const out: ProviderCalendarListEntry[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await calendar.calendarList.list({ pageToken, maxResults: 250 });
        for (const item of data.items ?? []) {
          if (!item.id) continue;
          out.push({ id: item.id, name: item.summary ?? item.id, primary: !!item.primary });
        }
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);
      return out;
    });
  },

  async getBusy(
    refreshToken: string,
    calendarIds: string[],
    fromMs: number,
    toMs: number
  ): Promise<BusyInterval[]> {
    return withAuthGuard(async () => {
      const calendar = calendarFor(refreshToken);
      const { data } = await calendar.freebusy.query({
        requestBody: {
          timeMin: new Date(fromMs).toISOString(),
          timeMax: new Date(toMs).toISOString(),
          items: calendarIds.map((id) => ({ id })),
        },
      });
      const calendars = data.calendars ?? {};
      const out: BusyInterval[] = [];
      for (const id of calendarIds) {
        const cal = calendars[id];
        // Fail closed: a calendar that failed to compute (deleted, unshared)
        // carries errors instead of busy data, and one absent from the
        // response is equally unreadable. Skipping either would make it look
        // free all day, so throw and let availability drop this member for
        // the window (matching the Microsoft path).
        if (!cal) {
          throw new Error(`google: freebusy returned no data for calendar "${id}"`);
        }
        if (cal.errors && cal.errors.length > 0) {
          const reason = cal.errors[0]?.reason ?? "unknown";
          throw new Error(`google: freebusy failed for calendar "${id}": ${reason}`);
        }
        for (const period of cal.busy ?? []) {
          if (!period.start || !period.end) continue;
          out.push({ startMs: Date.parse(period.start), endMs: Date.parse(period.end) });
        }
      }
      // Raw per-calendar intervals: the caller merges across accounts.
      return out;
    });
  },

  async createEvent(refreshToken: string, input: CreateEventInput): Promise<CreatedEvent> {
    return withAuthGuard(async () => {
      const calendar = calendarFor(refreshToken);
      const requestBody: calendar_v3.Schema$Event = {
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.startAt, timeZone: "UTC" },
        end: { dateTime: input.endAt, timeZone: "UTC" },
        attendees: input.attendees.map((a) => ({ email: a.email, displayName: a.name })),
      };
      if (input.withConference) {
        requestBody.conferenceData = {
          createRequest: {
            requestId: crypto.randomUUID(),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        };
      }
      const { data } = await calendar.events.insert({
        calendarId: input.calendarId,
        conferenceDataVersion: 1,
        sendUpdates: "all",
        requestBody,
      });
      if (!data.id) throw new Error("google: event insert returned no event id");
      const videoEntry = data.conferenceData?.entryPoints?.find(
        (p) => p.entryPointType === "video"
      );
      return { eventId: data.id, meetingUrl: data.hangoutLink ?? videoEntry?.uri ?? null };
    });
  },

  async updateEventTime(
    refreshToken: string,
    calendarId: string,
    eventId: string,
    startAt: string,
    endAt: string
  ): Promise<void> {
    await withAuthGuard(() =>
      calendarFor(refreshToken).events.patch({
        calendarId,
        eventId,
        sendUpdates: "all",
        requestBody: {
          start: { dateTime: startAt, timeZone: "UTC" },
          end: { dateTime: endAt, timeZone: "UTC" },
        },
      })
    );
  },

  async deleteEvent(refreshToken: string, calendarId: string, eventId: string): Promise<void> {
    await withAuthGuard(async () => {
      try {
        await calendarFor(refreshToken).events.delete({ calendarId, eventId, sendUpdates: "all" });
      } catch (err) {
        // Already gone (404) or previously deleted (410): deletion is idempotent.
        const status = errStatus(err);
        if (status === 404 || status === 410) return;
        throw err;
      }
    });
  },
};

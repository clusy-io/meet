import "server-only";
import type {
  BusyInterval,
  CalendarProvider,
  CreatedEvent,
  CreateEventInput,
  ProviderCalendarListEntry,
  ProviderTokens,
} from "../types";
import { mergeBusy, ProviderAuthError } from "../types";

/**
 * clusy/meet - Microsoft (Outlook) calendar provider.
 *
 * Raw fetch against Microsoft Graph, no SDK, so the module stays
 * dependency-free. Access tokens are cached per refresh token for the
 * lifetime of the lambda instance. Revoked grants surface as
 * ProviderAuthError so callers can flip the account to "reauth_required".
 * Server-only.
 */

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access openid email User.Read Calendars.ReadWrite";
const REQUEST_TIMEOUT_MS = 15_000;

/** showAs values that block a slot; free and workingElsewhere do not. */
const BUSY_SHOW_AS = new Set(["busy", "oof", "tentative"]);

/** AADSTS codes that mean the refresh grant itself is dead, not a transient. */
const AUTH_ERROR_PATTERN = /AADSTS(?:70000|70043|50173)\b/;

function requireEnv(
  name: "MEET_MICROSOFT_CLIENT_ID" | "MEET_MICROSOFT_CLIENT_SECRET"
): string {
  const value = process.env[name];
  if (!value) throw new Error(`meet: ${name} is not set`);
  return value;
}

/* ------------------------------------------------------------------ */
/* Token endpoint                                                      */
/* ------------------------------------------------------------------ */

interface TokenEndpointBody {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface TokenGrantResult {
  accessToken: string;
  expiresInSec: number;
  refreshToken?: string;
  idToken?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenGrantResult> {
  const body = new URLSearchParams({
    client_id: requireEnv("MEET_MICROSOFT_CLIENT_ID"),
    client_secret: requireEnv("MEET_MICROSOFT_CLIENT_SECRET"),
    scope: SCOPES,
    ...params,
  });
  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let data: TokenEndpointBody;
  try {
    data = (await res.json()) as TokenEndpointBody;
  } catch {
    throw new Error(`meet: microsoft token endpoint returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok || data.error !== undefined || typeof data.access_token !== "string") {
    const err = data.error ?? "unknown_error";
    const aadMatch = AUTH_ERROR_PATTERN.exec(data.error_description ?? "");
    if (err === "invalid_grant" || aadMatch) {
      throw new ProviderAuthError("microsoft", aadMatch ? aadMatch[0] : err);
    }
    throw new Error(`meet: microsoft token request failed (HTTP ${res.status}, ${err})`);
  }
  const rawExpiresIn =
    typeof data.expires_in === "number"
      ? data.expires_in
      : Number.parseInt(String(data.expires_in ?? ""), 10);
  return {
    accessToken: data.access_token,
    expiresInSec: Number.isFinite(rawExpiresIn) ? rawExpiresIn : 3600,
    ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
    ...(typeof data.id_token === "string" ? { idToken: data.id_token } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Refresh-token rotation                                              */
/* ------------------------------------------------------------------ */

/**
 * Microsoft rotates refresh tokens: a refresh-token grant may return a NEW
 * refresh_token, and the presented one eventually stops working (silently
 * killing the connection in ~90 days if the replacement is discarded).
 * The alias map redirects in-flight callers that still hold the old string
 * to the replacement within this instance; the registered handler is how a
 * rotation reaches persistence (see tokenRotation.ts, wired up in
 * providers/index.ts).
 */
const rotatedRefreshTokens = new Map<string, string>();

type RefreshTokenRotationHandler = (
  oldRefreshToken: string,
  newRefreshToken: string
) => Promise<void>;

let rotationHandler: RefreshTokenRotationHandler | null = null;

export function setRefreshTokenRotationHandler(
  handler: RefreshTokenRotationHandler | null
): void {
  rotationHandler = handler;
}

/** Follow the alias chain so a token rotated more than once still resolves. */
function resolveRefreshToken(refreshToken: string): string {
  let current = refreshToken;
  for (let hops = 0; hops < 32; hops++) {
    const next = rotatedRefreshTokens.get(current);
    if (next === undefined) break;
    current = next;
  }
  return current;
}

async function noteRefreshTokenRotation(
  oldRefreshToken: string,
  newRefreshToken: string
): Promise<void> {
  // Persist first. A serverless invocation may freeze as soon as the request
  // resolves, so detached work can silently lose Microsoft's replacement
  // token. Keeping the old alias until persistence succeeds also makes a
  // transient store failure retryable on the next provider call.
  if (rotationHandler) await rotationHandler(oldRefreshToken, newRefreshToken);
  rotatedRefreshTokens.set(oldRefreshToken, newRefreshToken);
}

/* ------------------------------------------------------------------ */
/* Access-token cache                                                  */
/* ------------------------------------------------------------------ */

interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
}

// Per lambda instance, keyed by refresh token. Refreshed early so a token
// never expires mid-request.
const accessTokenCache = new Map<string, CachedAccessToken>();
const accessTokenRefreshes = new Map<string, Promise<string>>();

const REFRESH_MARGIN_MS = 60_000;

async function getAccessToken(
  presentedRefreshToken: string,
  forceRefresh = false
): Promise<string> {
  // Callers may still hold a refresh token that has since rotated; follow
  // the alias map so their old string keeps working within this instance.
  const refreshToken = resolveRefreshToken(presentedRefreshToken);
  const cached = accessTokenCache.get(refreshToken);
  if (!forceRefresh && cached && cached.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
    return cached.accessToken;
  }
  // Coalesce concurrent refreshes for the same credential. Besides avoiding
  // needless token traffic, this serializes A -> B rotation persistence so a
  // second caller cannot rotate stale A again while B is still being stored.
  const inFlight = accessTokenRefreshes.get(refreshToken);
  if (inFlight) return inFlight;

  const refresh = (async (): Promise<string> => {
    const now = Date.now();
    const grant = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (grant.refreshToken !== undefined && grant.refreshToken !== refreshToken) {
      await noteRefreshTokenRotation(refreshToken, grant.refreshToken);
    }
    const entry: CachedAccessToken = {
      accessToken: grant.accessToken,
      expiresAtMs: now + grant.expiresInSec * 1000,
    };
    // Key the cache by the newest token so post-rotation lookups still hit.
    accessTokenCache.set(grant.refreshToken ?? refreshToken, entry);
    return entry.accessToken;
  })();
  accessTokenRefreshes.set(refreshToken, refresh);
  try {
    return await refresh;
  } finally {
    if (accessTokenRefreshes.get(refreshToken) === refresh) {
      accessTokenRefreshes.delete(refreshToken);
    }
  }
}

/** Test hook: provider modules are process-global across Vitest cases. */
export function __resetMicrosoftProviderState(): void {
  rotatedRefreshTokens.clear();
  accessTokenCache.clear();
  accessTokenRefreshes.clear();
  rotationHandler = null;
}

/* ------------------------------------------------------------------ */
/* Graph plumbing                                                      */
/* ------------------------------------------------------------------ */

interface GraphRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Authenticated Graph fetch. A 401 with a cached token is retried once on a
 * fresh refresh (the benign cause is a token revoked mid-cache); a 401 on
 * the freshly refreshed token means the grant is gone.
 */

/**
 * Event URLs: an empty calendarId targets the account's DEFAULT calendar via
 * /me/events. Events must live on a calendar the account owns; the selected
 * busy-source calendars may be read-only and are never valid event targets.
 */
function eventCollectionUrl(calendarId: string): string {
  return calendarId
    ? `${GRAPH_BASE}/me/calendars/${encodeURIComponent(calendarId)}/events`
    : `${GRAPH_BASE}/me/events`;
}

function eventUrl(calendarId: string, eventId: string): string {
  return calendarId
    ? `${GRAPH_BASE}/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    : `${GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}`;
}

async function graphFetch(
  refreshToken: string,
  url: string,
  init: GraphRequestInit = {}
): Promise<Response> {
  const doFetch = (token: string): Promise<Response> =>
    fetch(url, {
      method: init.method ?? "GET",
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  let res = await doFetch(await getAccessToken(refreshToken));
  if (res.status === 401) {
    res = await doFetch(await getAccessToken(refreshToken, true));
    if (res.status === 401) {
      throw new ProviderAuthError("microsoft", "Graph rejected a freshly refreshed token");
    }
  }
  return res;
}

/** Error for a non-OK Graph response, carrying the status and OData code. */
async function graphError(res: Response, operation: string): Promise<Error> {
  let code = "unknown";
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    if (typeof body.error?.code === "string" && body.error.code.length > 0) {
      code = body.error.code;
    }
  } catch {
    // Non-JSON error body; the status alone will have to do.
  }
  return new Error(`meet: microsoft ${operation} failed (HTTP ${res.status}, ${code})`);
}

/** GET a collection, following @odata.nextLink to exhaustion. */
async function graphGetPaged<T>(
  refreshToken: string,
  firstUrl: string,
  headers: Record<string, string> | undefined,
  operation: string
): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = firstUrl;
  while (url) {
    const res = await graphFetch(refreshToken, url, headers ? { headers } : {});
    if (!res.ok) throw await graphError(res, operation);
    const page = (await res.json()) as { value?: T[]; "@odata.nextLink"?: string };
    if (Array.isArray(page.value)) out.push(...page.value);
    url = page["@odata.nextLink"];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Payload parsing                                                     */
/* ------------------------------------------------------------------ */

interface IdTokenEmailClaims {
  /** The "email" claim: an actual mailbox address when present. */
  email: string | null;
  /** The "preferred_username" claim: a UPN, not guaranteed routable. */
  preferredUsername: string | null;
}

/** id_token claims can carry the account email; avoids a /me round trip. */
function claimsFromIdToken(idToken: string | undefined): IdTokenEmailClaims {
  const empty: IdTokenEmailClaims = { email: null, preferredUsername: null };
  if (!idToken) return empty;
  const parts = idToken.split(".");
  if (parts.length < 2) return empty;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      preferred_username?: unknown;
      email?: unknown;
    };
    const asString = (v: unknown): string | null =>
      typeof v === "string" && v.length > 0 ? v : null;
    return { email: asString(claims.email), preferredUsername: asString(claims.preferred_username) };
  } catch {
    return empty;
  }
}

interface GraphMeProfile {
  mail: string | null;
  userPrincipalName: string | null;
}

async function fetchMeProfile(accessToken: string): Promise<GraphMeProfile> {
  const res = await fetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw await graphError(res, "profile lookup");
  const me = (await res.json()) as { mail?: string | null; userPrincipalName?: string | null };
  return {
    mail: typeof me.mail === "string" && me.mail.length > 0 ? me.mail : null,
    userPrincipalName:
      typeof me.userPrincipalName === "string" && me.userPrincipalName.length > 0
        ? me.userPrincipalName
        : null,
  };
}

/**
 * Graph returns {dateTime, timeZone} with dateTime like
 * "2026-08-12T18:30:00.0000000" (no zone suffix; UTC because we send
 * Prefer: outlook.timezone="UTC"). Trim the fraction to milliseconds and
 * pin the zone before parsing.
 */
function parseGraphUtc(dateTime: string): number {
  const trimmed = dateTime.replace(/\.(\d{3})\d+/, ".$1");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  return Date.parse(hasZone ? trimmed : `${trimmed}Z`);
}

interface GraphCalendar {
  id: string;
  name?: string;
  isDefaultCalendar?: boolean;
}

interface GraphDateTime {
  dateTime?: string;
  timeZone?: string;
}

interface GraphViewEvent {
  start?: GraphDateTime;
  end?: GraphDateTime;
  showAs?: string;
}

interface GraphCreatedEvent {
  id?: string;
  onlineMeeting?: { joinUrl?: string | null } | null;
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

export const microsoftProvider: CalendarProvider = {
  id: "microsoft",

  getAuthUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: requireEnv("MEET_MICROSOFT_CLIENT_ID"),
      response_type: "code",
      response_mode: "query",
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
      // Members connect SEVERAL Microsoft accounts; without the chooser the
      // authorize endpoint silently reuses the active session.
      prompt: "select_account",
    });
    return `${AUTHORITY}/authorize?${params.toString()}`;
  },

  async exchangeCode(code: string, redirectUri: string): Promise<ProviderTokens> {
    const now = Date.now();
    const grant = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    const expiresAtMs = now + grant.expiresInSec * 1000;
    // Resolution order: id_token "email" claim (a real mailbox), then Graph
    // /me "mail", and only then the UPN-shaped fallbacks. preferred_username
    // is a UPN, not guaranteed routable, so it must never win over the rest.
    const claims = claimsFromIdToken(grant.idToken);
    let email = claims.email;
    if (email === null) {
      const me = await fetchMeProfile(grant.accessToken);
      email = me.mail ?? claims.preferredUsername ?? me.userPrincipalName;
    }
    if (email === null) throw new Error("meet: microsoft profile has no email address");
    // Seed the cache so the connect flow's follow-up calls skip a refresh.
    if (grant.refreshToken) {
      accessTokenCache.set(grant.refreshToken, { accessToken: grant.accessToken, expiresAtMs });
    }
    return {
      accessToken: grant.accessToken,
      ...(grant.refreshToken !== undefined ? { refreshToken: grant.refreshToken } : {}),
      expiresAtMs,
      email,
    };
  },

  async listCalendars(refreshToken: string): Promise<ProviderCalendarListEntry[]> {
    const calendars = await graphGetPaged<GraphCalendar>(
      refreshToken,
      `${GRAPH_BASE}/me/calendars?$select=id,name,isDefaultCalendar&$top=100`,
      undefined,
      "calendar list"
    );
    return calendars
      .filter((c) => typeof c.id === "string" && c.id.length > 0)
      .map((c) => ({
        id: c.id,
        name: typeof c.name === "string" && c.name.length > 0 ? c.name : c.id,
        primary: c.isDefaultCalendar === true,
      }));
  },

  async getBusy(
    refreshToken: string,
    calendarIds: string[],
    fromMs: number,
    toMs: number
  ): Promise<BusyInterval[]> {
    const startIso = new Date(fromMs).toISOString();
    const endIso = new Date(toMs).toISOString();
    const perCalendar = await Promise.all(
      calendarIds.map((calendarId) => {
        const url =
          `${GRAPH_BASE}/me/calendars/${encodeURIComponent(calendarId)}/calendarView` +
          `?startDateTime=${encodeURIComponent(startIso)}` +
          `&endDateTime=${encodeURIComponent(endIso)}` +
          `&$select=start,end,showAs&$top=200`;
        return graphGetPaged<GraphViewEvent>(
          refreshToken,
          url,
          { Prefer: 'outlook.timezone="UTC"' },
          "calendar view"
        );
      })
    );
    const intervals: BusyInterval[] = [];
    for (const events of perCalendar) {
      for (const ev of events) {
        if (!BUSY_SHOW_AS.has(ev.showAs ?? "")) continue;
        const start = ev.start?.dateTime;
        const end = ev.end?.dateTime;
        if (!start || !end) continue;
        const startMs = Math.max(parseGraphUtc(start), fromMs);
        const endMs = Math.min(parseGraphUtc(end), toMs);
        // NaN from an unparsable date fails both checks and is dropped.
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
        if (endMs <= startMs) continue;
        intervals.push({ startMs, endMs });
      }
    }
    return mergeBusy(intervals);
  },

  async createEvent(refreshToken: string, input: CreateEventInput): Promise<CreatedEvent> {
    // Graph emails invites natively. When withConference is set, failure must
    // propagate so booking orchestration can try the next healthy organizer;
    // silently retrying as a plain event would prematurely strand the booking
    // without video even when another account can host it.
    const basePayload: Record<string, unknown> = {
      subject: input.summary,
      body: { contentType: "text", content: input.description },
      start: { dateTime: input.startAt, timeZone: "UTC" },
      end: { dateTime: input.endAt, timeZone: "UTC" },
      attendees: input.attendees.map((a) => ({
        emailAddress: {
          address: a.email,
          ...(a.name !== undefined ? { name: a.name } : {}),
        },
        type: "required",
      })),
    };
    const postEvent = (payload: Record<string, unknown>): Promise<Response> =>
      graphFetch(
        refreshToken,
        eventCollectionUrl(input.calendarId),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
    const parseCreated = async (res: Response): Promise<GraphCreatedEvent & { id: string }> => {
      const created = (await res.json()) as GraphCreatedEvent;
      if (typeof created.id !== "string" || created.id.length === 0) {
        throw new Error("meet: microsoft event create returned no id");
      }
      return { ...created, id: created.id };
    };

    if (input.withConference) {
      const res = await postEvent({
        ...basePayload,
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
      });
      if (!res.ok) throw await graphError(res, "event create");
      const created = await parseCreated(res);
      const joinUrl = created.onlineMeeting?.joinUrl;
      return {
        eventId: created.id,
        // event.webLink opens the Outlook calendar item; it is never a Teams
        // join URL and must not be shown as one.
        meetingUrl: typeof joinUrl === "string" && joinUrl.trim() ? joinUrl : null,
      };
    }

    const res = await postEvent(basePayload);
    if (!res.ok) throw await graphError(res, "event create");
    const created = await parseCreated(res);
    return { eventId: created.id, meetingUrl: null };
  },

  async updateEventTime(
    refreshToken: string,
    calendarId: string,
    eventId: string,
    startAt: string,
    endAt: string
  ): Promise<void> {
    const res = await graphFetch(
      refreshToken,
      eventUrl(calendarId, eventId),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: { dateTime: startAt, timeZone: "UTC" },
          end: { dateTime: endAt, timeZone: "UTC" },
        }),
      }
    );
    if (!res.ok) throw await graphError(res, "event update");
  },

  async deleteEvent(refreshToken: string, calendarId: string, eventId: string): Promise<void> {
    const res = await graphFetch(
      refreshToken,
      eventUrl(calendarId, eventId),
      { method: "DELETE" }
    );
    // Already gone counts as deleted; cancel flows must stay idempotent.
    if (res.status === 404 || res.status === 410) return;
    if (!res.ok) throw await graphError(res, "event delete");
  },
};

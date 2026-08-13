import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMicrosoftProviderState,
  microsoftProvider,
  setRefreshTokenRotationHandler,
} from "@/lib/meet/providers/microsoft";
import type { CreateEventInput } from "@/lib/meet/types";

const originalClientId = process.env.MEET_MICROSOFT_CLIENT_ID;
const originalClientSecret = process.env.MEET_MICROSOFT_CLIENT_SECRET;

beforeEach(() => {
  __resetMicrosoftProviderState();
  process.env.MEET_MICROSOFT_CLIENT_ID = "test-client";
  process.env.MEET_MICROSOFT_CLIENT_SECRET = "test-secret";
});

afterEach(() => {
  if (originalClientId === undefined) delete process.env.MEET_MICROSOFT_CLIENT_ID;
  else process.env.MEET_MICROSOFT_CLIENT_ID = originalClientId;
  if (originalClientSecret === undefined) delete process.env.MEET_MICROSOFT_CLIENT_SECRET;
  else process.env.MEET_MICROSOFT_CLIENT_SECRET = originalClientSecret;
  __resetMicrosoftProviderState();
  vi.unstubAllGlobals();
});

const EVENT_INPUT: CreateEventInput = {
  calendarId: "",
  summary: "Test call",
  description: "Test description",
  startAt: "2026-08-20T17:00:00.000Z",
  endAt: "2026-08-20T17:30:00.000Z",
  attendees: [{ email: "booker@example.com" }],
  withConference: true,
};

function stubMicrosoftFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url.includes("/oauth2/v2.0/token")) {
        return new Response(
          JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(null, { status: 204 });
    })
  );
  return urls;
}

describe("Microsoft event mutation URLs", () => {
  it("updates legacy events stored with an explicit calendar id", async () => {
    const urls = stubMicrosoftFetch();

    await microsoftProvider.updateEventTime(
      "refresh-legacy-update",
      "calendar/id",
      "event/id",
      "2026-08-20T17:00:00.000Z",
      "2026-08-20T17:30:00.000Z"
    );

    expect(urls.at(-1)).toBe(
      "https://graph.microsoft.com/v1.0/me/calendars/calendar%2Fid/events/event%2Fid"
    );
  });

  it("deletes legacy events stored with an explicit calendar id", async () => {
    const urls = stubMicrosoftFetch();

    await microsoftProvider.deleteEvent(
      "refresh-legacy-delete",
      "calendar/id",
      "event/id"
    );

    expect(urls.at(-1)).toBe(
      "https://graph.microsoft.com/v1.0/me/calendars/calendar%2Fid/events/event%2Fid"
    );
  });

  it("uses /me/events for events on the default calendar", async () => {
    const urls = stubMicrosoftFetch();

    await microsoftProvider.updateEventTime(
      "refresh-default-update",
      "",
      "event/id",
      "2026-08-20T17:00:00.000Z",
      "2026-08-20T17:30:00.000Z"
    );

    expect(urls.at(-1)).toBe(
      "https://graph.microsoft.com/v1.0/me/events/event%2Fid"
    );
  });
});

describe("Microsoft event creation", () => {
  function stubCreate(created: Record<string, unknown>, status = 201) {
    const graphBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/oauth2/v2.0/token")) {
          return new Response(
            JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        graphBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify(created), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    return graphBodies;
  }

  it("uses only the Teams joinUrl, never the Outlook event webLink", async () => {
    stubCreate({
      id: "event-id",
      webLink: "https://outlook.office.com/calendar/item",
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/real" },
    });

    await expect(microsoftProvider.createEvent("refresh-create-join", EVENT_INPUT)).resolves.toEqual({
      eventId: "event-id",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/real",
    });
  });

  it("returns no meeting URL when Graph supplies only webLink", async () => {
    stubCreate({ id: "event-id", webLink: "https://outlook.office.com/calendar/item" });

    await expect(
      microsoftProvider.createEvent("refresh-create-weblink", EVENT_INPUT)
    ).resolves.toEqual({ eventId: "event-id", meetingUrl: null });
  });

  it("does not hide a failed conference request by retrying a plain event", async () => {
    const bodies = stubCreate({ error: { code: "TooManyRequests" } }, 429);

    await expect(
      microsoftProvider.createEvent("refresh-create-failure", EVENT_INPUT)
    ).rejects.toThrow("HTTP 429");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
    });
  });
});

describe("Microsoft refresh-token rotation", () => {
  it("awaits durable rotation persistence before making the Graph request", async () => {
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const persist = vi.fn(() => persistenceGate);
    setRefreshTokenRotationHandler(persist);
    let graphCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/oauth2/v2.0/token")) {
          return new Response(
            JSON.stringify({
              access_token: "rotated-access",
              refresh_token: "new-refresh",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        graphCalls++;
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const pending = microsoftProvider.listCalendars("old-refresh");
    await vi.waitFor(() => expect(persist).toHaveBeenCalledWith("old-refresh", "new-refresh"));
    expect(graphCalls).toBe(0);

    releasePersistence();
    await expect(pending).resolves.toEqual([]);
    expect(graphCalls).toBe(1);
  });

  it("does not call Graph when rotation persistence fails", async () => {
    setRefreshTokenRotationHandler(async () => {
      throw new Error("database unavailable");
    });
    let graphCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/oauth2/v2.0/token")) {
          return new Response(
            JSON.stringify({
              access_token: "rotated-access",
              refresh_token: "new-refresh",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        graphCalls++;
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      })
    );

    await expect(microsoftProvider.listCalendars("old-refresh")).rejects.toThrow(
      "database unavailable"
    );
    expect(graphCalls).toBe(0);
  });
});

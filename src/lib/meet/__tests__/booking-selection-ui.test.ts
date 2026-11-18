import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MeetPage from "@/app/page";
import TeamBookingPage from "@/app/book/[type]/page";
import { availabilityUrl } from "@/components/meet/AvailabilityPrime";
import { __resetMeetConfigCache } from "@/lib/meet/config";
import { ThemeProvider } from "@/components/ThemeProvider";

function markup(element: ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, null, element));
}

function investorConfig() {
  vi.stubEnv("MEET_INVESTOR_START_DATE", "2029-03-12");
  vi.stubEnv("MEET_INVESTOR_END_DATE", "2029-03-18");
  vi.stubEnv("MEET_INVESTOR_REQUIRED_MEMBER", "founder");
  vi.stubEnv("MEET_INVESTOR_PARTNERS", "partner");
}

beforeEach(() => {
  vi.stubEnv("MEET_MOCK_MODE", "1");
  vi.stubEnv("MEET_INVESTOR_START_DATE", undefined);
  vi.stubEnv("MEET_INVESTOR_END_DATE", undefined);
  vi.stubEnv("MEET_INVESTOR_REQUIRED_MEMBER", undefined);
  vi.stubEnv("MEET_INVESTOR_PARTNERS", undefined);
  __resetMeetConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetMeetConfigCache();
});

describe("public meeting selection", () => {
  it("offers the default choices before fetching calendars or requesting contact details", () => {
    const home = markup(MeetPage());
    expect(home).toContain('href="/book/chat"');
    expect(home).toContain('href="/book/meeting"');
    expect(home).not.toContain('href="/book/investor"');
    expect(home).not.toContain("meet-availability-prime");
    expect(home).not.toContain("<form");
  });

  it("opens the configured investor month and primes its own availability", async () => {
    investorConfig();
    expect(markup(MeetPage())).toContain('href="/book/investor"');
    const page = markup(await TeamBookingPage({ params: Promise.resolve({ type: "investor" }) }));
    expect(page).toContain('var u="/api/meet/availability?type=investor"');
    expect(page).toContain("March 2029");
    expect(page).not.toContain('href="/book/chat"');
  });

  it.each(["investor", "unknown"])("rejects an unavailable meeting type (%s)", async (type) => {
    await expect(TeamBookingPage({ params: Promise.resolve({ type }) })).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  it("keeps personal and private rescheduling lookups scoped to the host or token", () => {
    expect(availabilityUrl({ host: "investor", meetingType: "meeting" }))
      .toBe("/api/meet/availability?host=investor");
    expect(availabilityUrl({ manageToken: "demo-token", meetingType: "investor" }))
      .toBe("/api/meet/availability?token=demo-token");
  });
});

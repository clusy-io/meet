import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import MemberBookingPage from "@/app/[member]/page";
import TeamBookingPage from "@/app/book/[type]/page";
import { ThemeProvider } from "@/components/ThemeProvider";
import { getMeetConfig, __resetMeetConfigCache } from "@/lib/meet/config";

function markup(element: ReactElement) {
  return renderToStaticMarkup(createElement(ThemeProvider, null, element));
}

afterEach(() => {
  vi.unstubAllEnvs();
  __resetMeetConfigCache();
});

it("links a team calendar to meeting types and keeps the personal calendar scoped to its host", async () => {
  vi.stubEnv("MEET_MOCK_MODE", "1");
  __resetMeetConfigCache();
  const team = await TeamBookingPage({ params: Promise.resolve({ type: "meeting" }) });
  expect(markup(team)).toMatch(/<a[^>]*href="\/"[^>]*>Meeting types<svg[^>]*lucide-arrow-right/);

  const member = getMeetConfig().members[0].key;
  const personal = await MemberBookingPage({ params: Promise.resolve({ member }) });
  expect(markup(personal)).not.toContain(">Meeting types<");
});

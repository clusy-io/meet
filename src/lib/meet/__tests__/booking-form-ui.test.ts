import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BookingForm, type BookingFormState } from "@/components/meet/BookingForm";
import MeetBooking from "@/components/meet/MeetBooking";
import type { VideoChoice } from "@/lib/meet/types";

const noop = () => {};
const draft: BookingFormState = {
  values: {
    name: "", email: "", notes: "", guests: ["guest@example.test"],
    guestInput: "", guestError: null, websiteUrl: "", pending: false, error: null,
  },
  setters: {
    name: noop, email: noop, notes: noop, guests: noop, guestInput: noop,
    guestError: noop, websiteUrl: noop, pending: noop, error: noop,
  },
};

describe("public booking details", () => {
  it.each<[VideoChoice[], string]>([
    [["meet", "teams"], "Google Meet"],
    [["teams"], "Microsoft Teams"],
    [[], "Calendar invitation"],
  ])("shows the available default on calendars offering %j", (videoProviders, expected) => {
    const page = renderToStaticMarkup(createElement(MeetBooking, {
      headline: "Support call", durationMinutes: 45, videoProviders,
    }));
    expect(page).toContain("Support call");
    expect(page).toContain("45 min");
    expect(page).toContain(expected);
    if (!videoProviders.includes("meet")) expect(page).not.toContain("Google Meet");
  });

  function form(videoProviders: VideoChoice[], video: VideoChoice | undefined) {
    return renderToStaticMarkup(createElement(BookingForm, {
      startIso: "2027-03-01T12:00:00Z", timezone: "UTC", state: draft,
      videoProviders, video, onVideoChange: noop, onDone: noop, onSlotTaken: noop,
    }));
  }

  it("shows the chosen service inside the optional guest and video controls", () => {
    const html = form(["meet", "teams"], "teams");
    expect(html).toMatch(/<summary>[\s\S]*?Guests &amp; video \(1\)[\s\S]*?<\/summary>/);
    expect(html).toMatch(/<input[^>]*name="video"[^>]*checked=""[^>]*value="teams"/);
    expect(html).toContain("Microsoft Teams");
    expect(html).toContain("Google Meet");
  });

  it("offers only guest options for a single provider and keeps notes optional", () => {
    const html = form(["teams"], "teams");
    expect(html).toMatch(/<summary>[\s\S]*?Guests \(1\)[\s\S]*?<\/summary>/);
    expect(html).not.toContain('type="radio"');
    expect(html).not.toMatch(/<textarea[^>]*required/);
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("Confirm booking"));
  });
});

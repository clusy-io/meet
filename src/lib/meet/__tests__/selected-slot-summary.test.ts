import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppointmentSummary, SelectedSlotSummary } from "@/components/meet/SelectedSlotSummary";

function summary(start: string, durationMinutes = 30): string {
  return renderToStaticMarkup(createElement(SelectedSlotSummary, {
    start, durationMinutes, timezone: "America/Los_Angeles",
  })).replace(/\s+/gu, " ");
}

describe("selected booking time", () => {
  it("displays the local day above a compact range using the meeting's timezone", () => {
    const html = summary("2027-03-15T17:00:00Z");
    expect(html).toContain('dateTime="2027-03-15T17:00:00Z"');
    expect(html).toMatch(/>Mon, Mar 15, 2027<\/time><span[^>]+>10:00\s*[–-]\s*10:30 AM PDT</);
  });

  it("uses the actual duration and shows the end date when a booking crosses midnight", () => {
    const html = summary("2026-11-21T07:50:00Z", 15);
    expect(html).toContain("Fri, Nov 20, 2026");
    expect(html).toContain("11:50 PM PST to Sat, Nov 21, 2026, 12:05 AM PST");
  });

  it("uses both offsets when a booking spans the spring clock change", () => {
    expect(summary("2027-03-14T09:45:00Z")).toContain("1:45 AM PST – 3:15 AM PDT");
  });

  it("distinguishes hours repeated when daylight saving time ends", () => {
    const html = summary("2027-11-07T08:10:00Z", 60);
    expect(html).toContain("1:10 AM PDT to 1:10 AM PST");
  });
});

describe("appointment summary", () => {
  it.each([[1, "1 available time"], [3, "3 available times"]] as const)(
    "shows the local date and count for %i choices",
    (availableCount, label) => {
      const html = renderToStaticMarkup(createElement(AppointmentSummary, {
        start: "2027-01-01T00:15:00Z", timezone: "America/Los_Angeles", availableCount,
      }));
      expect(html).toContain("Thursday, December 31, 2026");
      expect(html).toContain("December 2026");
      expect(html).toContain(label);
    }
  );

  it("shows both local offsets when the selected time spans a clock change", () => {
    const html = renderToStaticMarkup(createElement(AppointmentSummary, {
      start: "2026-11-01T08:45:00Z", timezone: "America/Los_Angeles", durationMinutes: 30,
    })).replace(/\s+/gu, " ");
    expect(html).toContain("Sunday, November 1, 2026");
    expect(html).toContain("1:45 AM PDT – 1:15 AM PST");
    expect(html).toContain("1:45 AM PDT to 1:15 AM PST");
  });
});

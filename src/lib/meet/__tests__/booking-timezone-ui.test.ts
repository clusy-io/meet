import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TimezoneSelect } from "@/components/meet/TimezoneSelect";

function trigger(slotIso: string | null, placement?: "above" | "below"): string {
  return renderToStaticMarkup(createElement(TimezoneSelect, {
    value: "America/Los_Angeles",
    slotIso,
    placement,
    onChange: () => {},
  }));
}

it("shows the zone name until a meeting date is chosen", () => {
  expect(trigger(null)).toContain("America/Los Angeles");
  expect(trigger(null)).not.toContain("UTC");
});

it("uses the actual slot instant across a daylight saving change", () => {
  expect(trigger("2027-03-14T09:30:00Z")).toContain("America/Los Angeles (UTC-8)");
  expect(trigger("2027-03-14T10:30:00Z")).toContain("America/Los Angeles (UTC-7)");
  expect(trigger("2027-03-15T17:00:00Z")).toContain("America/Los Angeles (UTC-7)");
});

it("keeps the full accessible zone name beside the short public header label", () => {
  const html = trigger("2027-03-15T17:00:00Z", "below");
  expect(html).toContain('aria-label="Time zone, America/Los Angeles (UTC-7)"');
  expect(html).toContain(">Los Angeles (UTC-7)</span>");
});

/**
 * clusy/meet: does the calendar card hold its box while availability loads?
 *
 * Companion to slotpicker-invariants.mjs, and it exists for the same reason:
 * the vitest suite never renders SlotPicker, so "stable loading geometry" was
 * a stated goal that had quietly stopped being true.
 *
 *   MEET_MOCK_MODE=1 npm run dev
 *   node docs/loading-geometry.mjs http://localhost:3000/book/meeting
 *
 * Needs playwright-core and a local Chrome build, taken ad hoc:
 *   npm i --no-save playwright-core && npx playwright install chromium
 *
 * Against the pre-2026-08 skeleton this reports +19px on desktop and +18px on
 * mobile: that skeleton had no weekday header row, hardcoded 42 cells while
 * the real grid emitted 5 or 6 rows, and used p-5 where the real card uses p-4.
 *
 * Measures the SAME element across the arrival by delaying the availability
 * response, so this is a before/after of one box, not two guesses.
 */
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const url = process.argv[2] ?? "http://localhost:3000/book/meeting";
const viewports = [
  { name: "desktop", width: 1500, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
];

const CARD = "[data-meet-calendar]";
const results = [];

for (const vp of viewports) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });

  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  // Release the actual local response only after measuring the pending frame.
  // A fixed sleep could sample the same state twice on a slow machine.
  const gate = Promise.withResolvers();
  await page.route("**/api/meet/availability*", async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const card = page.locator(CARD);
  await card.waitFor();
  assert.equal(await card.count(), 1, "Public booking should mount one responsive calendar");
  const element = await card.elementHandle();
  await card.locator("[data-meet-date]").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await card.getAttribute("aria-busy"), "true", "First sample must be loading");

  async function measure() {
    const dates = card.locator('button[data-meet-date], button[aria-hidden="true"]:disabled');
    await (await dates.first().elementHandle()).waitForElementState("stable");
    assert.ok(await element.evaluate((el) => el.isConnected), "Availability must fill the same calendar element");
    return element.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const cells = el.querySelectorAll('button[data-meet-date], button[aria-hidden="true"]:disabled');
      const first = cells[0].getBoundingClientRect();
      return {
        x: Math.round(rect.x), y: Math.round(rect.y),
        w: Math.round(rect.width), h: Math.round(rect.height),
        cellCount: cells.length,
        cell0: { x: Math.round(first.x), y: Math.round(first.y), w: Math.round(first.width) },
        seeking: el.getAttribute("aria-busy") === "true",
      };
    });
  }
  const before = await measure();
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/meet/availability");
  gate.resolve();
  assert.ok((await response).ok(), "Mock server must return availability");
  await page.waitForFunction((el) => el.isConnected && !el.hasAttribute("aria-busy"), element);
  const after = await measure();

  results.push({ vp: vp.name, before, after, errors });
  await browser.close();
}

let failed = 0;
for (const { vp, before, after, errors } of results) {
  const d = {
    x: after.x - before.x, y: after.y - before.y,
    w: after.w - before.w, h: after.h - before.h,
  };
  const cellDx = after.cell0 && before.cell0 ? after.cell0.x - before.cell0.x : null;
  const cellDy = after.cell0 && before.cell0 ? after.cell0.y - before.cell0.y : null;
  const stable = d.x === 0 && d.y === 0 && d.w === 0 && d.h === 0 && cellDx === 0 && cellDy === 0 &&
    before.cellCount === after.cellCount && before.cell0.w === after.cell0.w;
  if (!stable) failed++;
  console.log(`\n${vp}:`);
  console.log(`  pending  card ${before.w}x${before.h} @ (${before.x},${before.y}) cells=${before.cellCount} seeking=${before.seeking}`);
  console.log(`  loaded   card ${after.w}x${after.h} @ (${after.x},${after.y}) cells=${after.cellCount} seeking=${after.seeking}`);
  console.log(`  delta    x${d.x >= 0 ? "+" : ""}${d.x} y${d.y >= 0 ? "+" : ""}${d.y} w${d.w >= 0 ? "+" : ""}${d.w} h${d.h >= 0 ? "+" : ""}${d.h}  firstCell dx=${cellDx} dy=${cellDy}`);
  console.log(`  ${stable ? "STABLE" : "*** MOVED ***"}   console errors: ${errors.length}${errors.length ? " -> " + errors.join(" | ").slice(0, 200) : ""}`);
  if (errors.length) failed++;
}

console.log(`\n${failed === 0 ? "geometry stable across arrival, no console errors" : `${failed} problem(s)`}`);
process.exit(failed === 0 ? 0 : 1);

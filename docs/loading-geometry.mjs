/**
 * clusy/meet: does the calendar card hold its box while availability loads?
 *
 * Companion to slotpicker-invariants.mjs, and it exists for the same reason:
 * the vitest suite never renders SlotPicker, so "stable loading geometry" was
 * a stated goal that had quietly stopped being true.
 *
 *   MEET_MOCK_MODE=1 npm run dev
 *   node docs/loading-geometry.mjs http://localhost:3000
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

/*
 * Vercel Web Analytics injects /_vercel/insights/script.js, which only exists
 * on a Vercel deployment. Running the build locally therefore always logs one
 * 404 that has nothing to do with this page. Ignored NARROWLY, by exact path,
 * so any other failed request still fails the check.
 */
const isLocalOnlyNoise = (text, location) =>
  `${text} ${location?.url ?? ""}`.includes("_vercel/insights");


const url = process.argv[2] ?? "http://localhost:3000";
const viewports = [
  { name: "desktop", width: 1500, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
];

const CARD = ".rounded-lg.border.bg-paper-raise";
const results = [];

for (const vp of viewports) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });

  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !isLocalOnlyNoise(m.text(), m.location())) errors.push(m.text());
  });
  page.on("pageerror", (e) => !isLocalOnlyNoise(String(e)) && errors.push(String(e)));

  // Hold availability back so the pending frame is observable.
  await page.route("**/api/meet/availability*", async (route) => {
    await new Promise((r) => setTimeout(r, 3500));
    await route.continue();
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  // The mobile and desktop cards are BOTH mounted; one is display:none. Wait
  // for whichever is actually laid out at this viewport.
  await page.waitForFunction(
    (sel) => [...document.querySelectorAll(sel)].some((n) => n.getClientRects().length > 0),
    CARD,
    { timeout: 30000 }
  );
  await page.waitForTimeout(700); // past hydration, well before the response

  const before = await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((n) => n.getClientRects().length > 0);
    const r = el.getBoundingClientRect();
    const cells = [...el.querySelectorAll("button")].filter(
      (b) => b.className.includes("aspect-square")
    );
    const c0 = cells[0]?.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      cellCount: cells.length,
      cell0: c0 ? { x: Math.round(c0.x), y: Math.round(c0.y), w: Math.round(c0.width) } : null,
      seeking: el.className.includes("meet-seeking"),
    };
  }, CARD);

  await page.waitForTimeout(4200); // response has landed and animated

  const after = await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((n) => n.getClientRects().length > 0);
    const r = el.getBoundingClientRect();
    const cells = [...el.querySelectorAll("button")].filter(
      (b) => b.className.includes("aspect-square")
    );
    const c0 = cells[0]?.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      cellCount: cells.length,
      cell0: c0 ? { x: Math.round(c0.x), y: Math.round(c0.y), w: Math.round(c0.width) } : null,
      seeking: el.className.includes("meet-seeking"),
    };
  }, CARD);

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
  const stable = d.x === 0 && d.y === 0 && d.w === 0 && d.h === 0 && cellDx === 0 && cellDy === 0;
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

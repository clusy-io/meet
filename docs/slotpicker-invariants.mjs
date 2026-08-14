/**
 * meet — browser checks for the time column in SlotPicker.
 *
 * These exist because the vitest suite never renders SlotPicker, so it stayed
 * green through four separate production bugs in this one column. Every one of
 * them was a layout or lifecycle fact that only a real browser can observe:
 * scroll offsets, clipping, ref re-attachment, framer's exiting panels.
 *
 * Each of the last three fixes here broke one of the others, so all four
 * invariants are checked together. Treat them as one suite.
 *
 *   MEET_MOCK_MODE=1 npm run dev
 *   node docs/slotpicker-invariants.mjs http://localhost:3000
 *
 * Needs playwright-core and a local Chrome build; it is deliberately NOT a repo
 * dependency, since there is no CI to run it. Install ad hoc:
 *   npm i --no-save playwright-core && npx playwright install chromium
 */

import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = process.argv[2];
if (!BASE) {
  console.error("usage: node docs/slotpicker-invariants.mjs <url of the booking page>");
  process.exit(2);
}

function chromePath() {
  const root = `${process.env.HOME}/Library/Caches/ms-playwright`;
  const dir = fs
    .readdirSync(root)
    .filter((d) => d.startsWith("chromium-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))[0];
  for (const rel of [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux/chrome",
  ]) {
    const p = `${root}/${dir}/${rel}`;
    if (fs.existsSync(p)) return p;
  }
  throw new Error("no chromium build found under ~/Library/Caches/ms-playwright");
}

/** Geometry of the live time column, measured the way a visitor sees it. */
const COLUMN = () => {
  const chips = [...document.querySelectorAll("[data-meet-time]")].filter(
    (e) => e.getClientRects().length
  );
  const list = chips[0]?.closest(".overflow-y-auto");
  if (!list) return { list: false };
  const whole = (el) => {
    const a = el.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  };
  const chosen = chips.find((c) => c.getAttribute("aria-pressed") === "true");
  return {
    list: true,
    scrollTop: Math.round(list.scrollTop),
    scrollable: list.scrollHeight > list.clientHeight + 1,
    chosen: chosen?.textContent.trim() ?? null,
    chosenWhole: chosen ? whole(chosen) : null,
    labels: chips.map((c) => c.textContent.trim()),
  };
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1800);

// Open the day with the most times, so the column definitely scrolls.
const days = page.locator("button[aria-label*='times available']:visible:not([disabled])");
let best = 0;
let bestN = -1;
for (let i = 0; i < (await days.count()); i++) {
  const n = Number((await days.nth(i).getAttribute("aria-label")).match(/(\d+) times/)?.[1] ?? 0);
  if (n > bestN) {
    bestN = n;
    best = i;
  }
}
if (bestN < 8) {
  console.error(`no day with enough times to exercise scrolling (best was ${bestN})`);
  process.exit(2);
}
await days.nth(best).click();
await page.waitForTimeout(900);

const times = page.locator("button[data-meet-time]:visible");
const labels = (await times.allInnerTexts()).map((t) => t.trim());

// 1. Choosing a time far down the day reveals it when the slim column appears.
await times.nth(labels.length - 1).click();
await page.waitForTimeout(1500);
let s = await page.evaluate(COLUMN);
check(
  "reveals the chosen time when the column first appears",
  s.chosenWhole === true && s.scrollable,
  `chosen ${s.chosen} at scrollTop ${s.scrollTop}`
);

// 2. Choosing a chip clipped at either edge brings it fully into view.
for (const edge of ["top", "bottom"]) {
  const before = await page.evaluate(COLUMN);
  const visible = await page.evaluate(() => {
    const chips = [...document.querySelectorAll("[data-meet-time]")].filter(
      (e) => e.getClientRects().length
    );
    const list = chips[0].closest(".overflow-y-auto");
    const whole = (el) => {
      const a = el.getBoundingClientRect();
      const b = list.getBoundingClientRect();
      return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    };
    return chips.filter(whole).map((c) => c.textContent.trim());
  });
  const anchor = edge === "top" ? visible[0] : visible[visible.length - 1];
  const idx = before.labels.indexOf(anchor);
  const targetIdx = edge === "top" ? Math.max(0, idx - 1) : Math.min(before.labels.length - 1, idx + 1);
  await times.nth(targetIdx).click();
  await page.waitForTimeout(1300);
  s = await page.evaluate(COLUMN);
  check(
    `brings a chip clipped at the ${edge} fully into view when chosen`,
    s.chosen === before.labels[targetIdx] && s.chosenWhole === true,
    `chosen ${s.chosen} at scrollTop ${s.scrollTop}`
  );
}

// 3. Switching month must not move the column at all.
// Deliberately re-select the day's FIRST time: that is the reported case, and
// it is the one that discriminates. With a mid-list selection the column is
// already scrolled and a buggy re-centre lands on the same offset by accident,
// so the check passes while the bug is present.
await times.first().click();
await page.waitForTimeout(1300);
const beforeMonth = await page.evaluate(COLUMN);
const nextIdx = await page
  .locator("button:visible")
  .evaluateAll((els) => els.findIndex((e) => e.querySelector("svg.lucide-chevron-right")));
await page.locator("button:visible").nth(nextIdx).click();
await page.waitForTimeout(1600);
s = await page.evaluate(COLUMN);
check(
  "holds the column still across a month switch",
  s.scrollTop === beforeMonth.scrollTop && s.chosenWhole === true && s.chosen === beforeMonth.chosen,
  `chose ${beforeMonth.chosen}, scrollTop ${beforeMonth.scrollTop} -> ${s.scrollTop}, whole ${s.chosenWhole}`
);

// 4. Typing in the guest form must not yank a column the visitor scrolled.
await page.evaluate(() => {
  document.querySelector(".overflow-y-auto").scrollTop = 400;
});
await page.waitForTimeout(400);
const scrolled = (await page.evaluate(COLUMN)).scrollTop;
await page.locator("[data-meet-name-input]:visible").first().fill("A");
await page.waitForTimeout(700);
s = await page.evaluate(COLUMN);
check(
  "holds the column still while the visitor types",
  s.scrollTop === scrolled,
  `scrollTop ${scrolled} -> ${s.scrollTop}`
);

check("no console errors", consoleErrors.length === 0, consoleErrors.join(" ~ ").slice(0, 160));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} invariants hold`);
process.exit(failed.length ? 1 : 0);

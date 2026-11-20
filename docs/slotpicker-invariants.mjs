/**
 * Browser regression checks for the standalone booking flow.
 *
 * These exist because the vitest suite never renders SlotPicker, so it stayed
 * green through four separate production bugs in this one column. Every one of
 * them was a layout or lifecycle fact that only a real browser can observe:
 * scroll offsets, clipping, ref re-attachment, framer's exiting panels.
 *
 * Uses a mock availability response with two consecutive days in different
 * months. The browser can exercise both edges of a scrollable list without
 * relying on today's date or the hosts' schedules. Never submits a booking.
 *
 *   MEET_MOCK_MODE=1 npm run dev
 *   node docs/slotpicker-invariants.mjs http://localhost:3000/book/meeting
 *
 * Needs playwright-core and a local Chrome build; it is deliberately NOT a repo
 * dependency, since there is no CI to run it. Install ad hoc:
 *   npm i --no-save playwright-core && npx playwright install chromium
 */

import { chromium } from "playwright-core";
import fs from "node:fs";
import assert from "node:assert/strict";

const BASE = process.argv[2];
if (!BASE) {
  console.error("usage: node docs/slotpicker-invariants.mjs <url of the booking page>");
  process.exit(2);
}

function chromePath() {
  // Respect an explicit override first, then try the per-platform Playwright
  // cache roots. Hardcoding the macOS path made this crash for everyone else.
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    `${process.env.HOME}/Library/Caches/ms-playwright`,
    `${process.env.HOME}/.cache/ms-playwright`,
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/ms-playwright` : null,
  ].filter(Boolean);
  const rels = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux/chrome",
    "chrome-win/chrome.exe",
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs
      .readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const dir of dirs) {
      for (const rel of rels) {
        const p = `${root}/${dir}/${rel}`;
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error(
    "no Chromium build found. Run: npx playwright install chromium\n" +
      "or point PLAYWRIGHT_CHROMIUM_PATH at an existing browser binary."
  );
}

// A Wednesday on day one is visible as a trailing, disabled date in the
// preceding month's grid with en-US weeks. A middle-of-month selection would
// never catch a stray selection highlight on an adjacent month's date.
const year = new Date().getUTCFullYear() + 1;
const secondDay = new Date(Date.UTC(year, 0, 1));
while (secondDay.getUTCDay() !== 3) secondDay.setUTCMonth(secondDay.getUTCMonth() + 1);
const firstDay = new Date(secondDay.getTime() - 86_400_000);
const slotTimes = (day) => Array.from({ length: 25 }, (_, i) =>
  new Date(day.getTime() + (8 * 60 + i * 30) * 60_000).toISOString()
);
const firstSlots = slotTimes(firstDay);
const secondSlots = slotTimes(secondDay);
const dateLabel = (day) => new Intl.DateTimeFormat("en-US", {
  weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
}).format(day);
const slotLabel = (iso) => new Intl.DateTimeFormat("en-US", {
  hour: "numeric", minute: "2-digit", timeZone: "UTC",
}).format(new Date(iso));

const viewport = { width: 1500, height: 1000 };
const browser = await chromium.launch({ executablePath: chromePath() });

async function openBooking(options = {}) {
  const page = await browser.newPage({ viewport, timezoneId: "UTC", locale: "en-US", ...options });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.route("**/api/meet/availability*", (route) => route.fulfill({
    json: {
      meetingType: "meeting", durationMinutes: 30, minNoticeMinutes: 0, hostTimezone: "UTC",
      slots: [...firstSlots, ...secondSlots],
    },
  }));
  await page.goto(BASE);
  await page.getByRole("button", { name: dateLabel(firstDay), exact: false }).waitFor();
  return { page, errors };
}

// Read the actual scrolling ancestor and screen geometry. A highlight alone
// is not enough if it is clipped, out of view, or missing keyboard focus.
function measureColumn(chip) {
  let list = chip.parentElement;
  while (list && !["auto", "scroll"].includes(getComputedStyle(list).overflowY)) {
    list = list.parentElement;
  }
  if (!list) throw new Error("Time choices have no scrolling container");
  const rect = list.getBoundingClientRect();
  const chosen = chip.getBoundingClientRect();
  return {
    scrollable: list.scrollHeight > list.clientHeight + 1,
    scrollTop: Math.round(list.scrollTop),
    left: Math.round(rect.left), top: Math.round(rect.top),
    height: Math.round(rect.height), width: Math.round(rect.width),
    whole: chosen.top >= Math.max(rect.top, 0) - 1 &&
      chosen.bottom <= Math.min(rect.bottom, window.innerHeight) + 1,
    focused: chip === document.activeElement,
  };
}

try {
  const { page, errors } = await openBooking();
  const calendar = page.locator("[data-meet-calendar]:visible");
  const times = page.locator("button[data-meet-time]:visible");
  const confirm = page.getByRole("button", { name: "Confirm booking", exact: true });
  const changeTime = page.getByRole("button", { name: /Change time/i });
  const firstDate = page.getByRole("button", { name: dateLabel(firstDay), exact: false });
  const secondDate = page.getByRole("button", { name: dateLabel(secondDay), exact: false });

  assert.equal(await page.locator("[data-meet-calendar]").count(), 1, "The public flow mounts a single calendar");
  assert.equal(await calendar.count(), 1, "The first stage shows one date picker");
  assert.equal(await times.count(), 0, "The first stage waits for a date before showing times");
  assert.equal(await confirm.count(), 0, "The first stage has no booking form");
  await firstDate.click();
  await times.first().waitFor();
  assert.equal(await calendar.count(), 1, "Choosing a date keeps the desktop calendar visible");
  assert.equal(await confirm.count(), 0, "Choosing a date alone does not open the final form");
  assert.equal(await times.count(), firstSlots.length, "All times on the chosen day are available");
  const rail = page.getByRole("complementary", { name: "Available times" });
  assert.equal(await rail.locator("time").getAttribute("datetime"), firstSlots[0]);
  assert.ok(await rail.getByText(`${firstSlots.length} available times`, { exact: true }).isVisible(),
    "The appointment summary shows the number of available times");
  console.log("PASS  Date opens the calendar, chosen date summary and time list together");

  const fields = [
    [page.getByRole("textbox", { name: "Name", exact: true }), "Test Visitor"],
    [page.getByRole("textbox", { name: "Email", exact: true }), "visitor@example.test"],
    [page.getByRole("textbox", { name: "What would you like to talk about?" }), "A calendar demonstration"],
  ];

  // Exercise the last item first: a newly mounted list at scrollTop=0
  // cannot pass by coincidence. Then return from the first time as well.
  const clockRange = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  });
  const normalized = (text) => text.replace(/\s+/g, " ").trim();
  for (const index of [firstSlots.length - 1, 0]) {
    const iso = firstSlots[index];
    const chosen = times.nth(index);
    assert.equal((await chosen.innerText()).trim(), slotLabel(iso));
    await chosen.click();
    await confirm.waitFor();
    assert.equal(await page.locator("form:visible").count(), 1, "One click opens a single final form");
    assert.equal(await calendar.count(), 0, "The calendar is hidden while entering details");
    assert.equal(await times.count(), 0, "The time rail is hidden while entering details");
    const summaryDate = page.locator("time[datetime]:visible");
    assert.equal(await summaryDate.getAttribute("datetime"), iso, "The summary describes the selected instant");
    assert.ok((await summaryDate.innerText()).trim(), "The selected date is visible");
    const start = new Date(iso);
    const end = new Date(start.getTime() + 30 * 60_000);
    const range = normalized(clockRange.formatRange(start, end));
    assert.ok(await page.getByText(range, { exact: true }).isVisible(),
      `The summary must show the selected time range, ${range}`);
    await page.waitForFunction(() => document.activeElement?.matches("[data-meet-name-input]"),
      undefined, { timeout: 3000 });
    if (index !== 0) {
      for (const [input, value] of fields) await input.fill(value);
    } else {
      for (const [input, value] of fields) {
        assert.equal(await input.inputValue(), value, "Editing the time retains each entered field");
      }
    }
    await changeTime.click();
    await chosen.waitFor();
    assert.equal(await firstDate.getAttribute("aria-pressed"), "true", "Change time keeps the selected date");
    assert.equal(await confirm.count(), 0, "Change time returns to the time picker");
    await page.waitForFunction((label) =>
      document.activeElement?.matches("[data-meet-time]") &&
      document.activeElement.textContent.trim() === label, slotLabel(iso), { timeout: 3000 });
    assert.equal(await chosen.getAttribute("aria-pressed"), "true", "The restored time is selected");
    const rail = await chosen.evaluate(measureColumn);
    assert.ok(rail.scrollable && rail.whole && rail.focused,
      `The previous time must be wholly visible and focused on return: ${JSON.stringify(rail)}`);
    console.log(`PASS  ${slotLabel(iso)} opens final details directly and is visible and focused on return`);
  }
  console.log("PASS  Editing the time preserves the visitor's details");

  // The first time in the list reproduces the original month-switch jump.
  // Comparing the list bounds catches reflow as well as a scroll offset reset.
  async function turnMonth(direction, leaving, entering, chip) {
    // Finish the preceding stage's entrance before measuring month navigation.
    // Its expanding two-column layout legitimately moves the rail once.
    await (await chip.elementHandle()).waitForElementState("stable");
    const before = await chip.evaluate(measureColumn);
    await page.getByRole("button", { name: direction }).click();
    await entering.waitFor();
    await leaving.waitFor({ state: "hidden" });
    const after = await chip.evaluate(measureColumn);
    for (const prop of ["scrollTop", "left", "top", "width", "height"]) {
      assert.ok(Math.abs(after[prop] - before[prop]) <= 1,
        `Paging the calendar moved the time list's ${prop} from ${before[prop]} to ${after[prop]}`);
    }
    assert.ok(after.whole, "The previously visible time stays in view across a month change");
  }
  await turnMonth("Next month", firstDate, secondDate, times.first());
  console.log("PASS  Paging the calendar preserves the rail's position and scroll offset");

  await secondDate.click();
  assert.equal(await secondDate.getAttribute("aria-pressed"), "true");
  // Scroll without choosing a time. Calendar renders must not pull the rail
  // back to the highlighted/first slot or recreate it at scrollTop=0.
  await times.last().scrollIntoViewIfNeeded();
  assert.ok((await times.last().evaluate(measureColumn)).scrollTop > 0, "A user-scrolled rail is required");
  await turnMonth("Previous month", secondDate, firstDate, times.last());
  const adjacent = calendar.locator('button[aria-hidden="true"]:disabled');
  assert.ok(await adjacent.count(), "The previous month has adjacent-month cells to test");
  assert.deepEqual(await adjacent.evaluateAll((cells) => cells.filter((cell) =>
    cell.getAttribute("aria-pressed") === "true" || Array.from(cell.children).some((child) =>
      child.getAttribute("aria-hidden") === "true" && getComputedStyle(child).position === "absolute" &&
      child.getBoundingClientRect().width >= cell.getBoundingClientRect().width - 2
    )
  ).map((cell) => cell.textContent.trim())), [],
  "An adjacent-month cell must never carry a selection highlight");
  console.log("PASS  Selecting the first day of the next month leaves adjacent dates unhighlighted");
  assert.deepEqual(errors, [], "Booking controls emitted browser errors");

  // A phone presents a single stage. Resizing while editing must keep the
  // same form element, focus and draft; a hidden desktop/mobile twin cannot.
  const phone = await openBooking({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const phoneDate = phone.page.getByRole("button", { name: dateLabel(firstDay), exact: false });
  const phoneTime = phone.page.locator(`[data-meet-time="${firstSlots.at(-1)}"]`);
  await phoneDate.tap();
  assert.equal(await phone.page.locator("[data-meet-calendar]:visible").count(), 0);
  await phoneTime.tap();
  const heading = phone.page.getByRole("heading", { name: "Your details" });
  await heading.waitFor();
  await phone.page.waitForFunction(() => document.activeElement?.matches("[data-meet-details-heading]"),
    undefined, { timeout: 3000 });
  const name = phone.page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Mobile visitor");
  const original = await name.elementHandle();
  for (const size of [viewport, { width: 390, height: 844 }]) {
    await phone.page.setViewportSize(size);
    assert.equal(await phone.page.locator("[data-stage] form").count(), 1);
    assert.ok(await original.evaluate((input) => input.isConnected && input === document.activeElement),
      "Resizing preserves the active field in the same form");
    assert.equal(await name.inputValue(), "Mobile visitor");
  }
  await phone.page.getByRole("button", { name: "Change time", exact: true }).tap();
  await phone.page.waitForFunction((iso) => document.activeElement?.dataset.meetTime === iso,
    firstSlots.at(-1), { timeout: 3000 });
  const chosen = await phoneTime.boundingBox();
  assert.ok(chosen && chosen.y >= -1 && chosen.y + chosen.height <= 845,
    "The previously chosen time is visible after returning on a phone");
  await phone.page.getByRole("button", { name: "Change date", exact: true }).tap();
  await phone.page.waitForFunction((day) => document.activeElement?.dataset.meetDate === day,
    firstSlots[0].slice(0, 10), { timeout: 3000 });
  assert.ok(await phoneDate.isVisible());
  assert.equal(await phone.page.locator("[data-meet-time]:visible").count(), 0);
  assert.deepEqual(phone.errors, [], "Mobile booking controls emitted browser errors");
  console.log("PASS  Touch navigation, focus restoration and in-progress form resizing");

  const reduced = await openBooking({ reducedMotion: "reduce" });
  await reduced.page.getByRole("button", { name: dateLabel(firstDay), exact: false }).click();
  await reduced.page.locator("[data-meet-time]:visible").first().waitFor();
  assert.deepEqual(reduced.errors, [], "Reduced-motion hydration or interaction emitted browser errors");
  console.log("PASS  Both motion preferences hydrate and run without browser errors");
} finally {
  await browser.close();
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Supabase store's look_busy column, checked at the PostgREST requests it
 * sends and the rows it reads back. The column is optional on purpose: an
 * installation that has not run the 2026-11-14 migration yet must read every
 * page as off rather than fail.
 */
vi.mock("@/lib/meet/config", () => ({ getMeetConfig: () => ({ mockMode: false }) }));

import { getMeetStore } from "@/lib/meet/store";

const env = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

const row = {
  member_key: "ada",
  enabled: true,
  headline: null,
  blurb: null,
  timezone: null,
  timezone_until_date: null,
  timezone_until_zone: null,
  window_start_min: null,
  window_end_min: null,
  bookable_weekdays: null,
  duration_minutes: null,
  slot_step_minutes: null,
  min_notice_minutes: null,
  horizon_days: null,
  event_title: null,
  event_description: null,
  slack_webhook_enc: null,
  created_at: "2026-11-14T00:00:00.000Z",
  updated_at: "2026-11-14T00:00:00.000Z",
};

const bodies: unknown[] = [];

/** Answer every PostgREST call with these rows (one for a .single()). */
function answerWith(rows: unknown[]) {
  bodies.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      const headers = new Headers(init?.headers);
      const single = headers.get("accept") === "application/vnd.pgrst.object+json";
      return new Response(JSON.stringify(single ? rows[0] : rows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  delete (globalThis as Record<string, unknown>).__meet_store__;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).__meet_store__;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Supabase page settings: look busy", () => {
  it("reads a table without the column yet as off", async () => {
    answerWith([row]);
    const [settings] = await getMeetStore().listPageSettings();
    expect(settings.lookBusy).toBeNull();
  });

  it("reads the stored level, and anything unknown as off", async () => {
    answerWith([
      { ...row, look_busy: "packed" },
      { ...row, member_key: "sam", look_busy: "maximum" },
    ]);
    const [ada, sam] = await getMeetStore().listPageSettings();
    expect(ada.lookBusy).toBe("packed");
    expect(sam.lookBusy).toBeNull();
  });

  it("writes the column only when a switch is changed", async () => {
    answerWith([{ ...row, look_busy: "light" }]);
    await getMeetStore().upsertPageSettings("ada", { headline: "Ada" });
    expect(bodies.at(-1)).not.toHaveProperty("look_busy");
    await getMeetStore().upsertPageSettings("ada", { lookBusy: "light" });
    expect(bodies.at(-1)).toMatchObject({ member_key: "ada", look_busy: "light" });
    await getMeetStore().upsertPageSettings("", { lookBusy: null });
    expect(bodies.at(-1)).toMatchObject({ member_key: "", look_busy: null });
  });
});

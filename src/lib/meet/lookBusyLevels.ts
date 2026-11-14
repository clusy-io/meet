/**
 * meet — "Make my calendar look busy" levels.
 *
 * Shared by the server (lookBusy.ts, the store, the admin API) and the admin
 * console, so it stays free of node-only imports.
 *
 * A level sets how booked a day should look. Real calendars fill up as a day
 * approaches, so each level has two ends: how full a day looks when it is
 * today (`near`) and how full it looks weeks out (`far`). Every day in
 * between eases from one to the other, then wobbles a little so no two days
 * look machine-made. Real meetings always count first: a level only ever
 * hides the difference between how busy a day really is and how busy it
 * should look.
 */

export const LOOK_BUSY_LEVELS = ["light", "balanced", "packed"] as const;
export type LookBusyLevel = (typeof LOOK_BUSY_LEVELS)[number];

/** The level a fresh switch turns on at. */
export const DEFAULT_LOOK_BUSY_LEVEL: LookBusyLevel = "balanced";

export interface LookBusyLevelInfo {
  key: LookBusyLevel;
  label: string;
  /** One line for the admin control. */
  detail: string;
  /** Share of a day's times that look taken when the day is today. */
  near: number;
  /** ...and when it is weeks away. */
  far: number;
}

export const LOOK_BUSY_LEVEL_INFO: Record<LookBusyLevel, LookBusyLevelInfo> = {
  light: {
    key: "light",
    label: "Light",
    detail: "A few times taken, mostly this week",
    near: 0.4,
    far: 0.15,
  },
  balanced: {
    key: "balanced",
    label: "Balanced",
    detail: "About half of this week taken, thinning out later",
    near: 0.55,
    far: 0.25,
  },
  packed: {
    key: "packed",
    label: "Packed",
    detail: "Most of this week taken, still room further out",
    near: 0.7,
    far: 0.4,
  },
};

/** Days over which a day's look eases from `near` to `far` (e-folding). */
export const LOOK_BUSY_EASE_DAYS = 6;

/** How far one day may wander from its level's curve, either way. */
export const LOOK_BUSY_DAY_WOBBLE = 0.07;

/**
 * The least a day keeps visible while it still has that many bookable times.
 * Two, not one: a day down to a single time reads as "nearly impossible to
 * get", which costs bookings the switch was never meant to cost.
 */
export const LOOK_BUSY_MIN_VISIBLE = 2;

/** A stored or submitted value as a level; anything unknown reads as off. */
export function parseLookBusyLevel(value: unknown): LookBusyLevel | null {
  return typeof value === "string" && (LOOK_BUSY_LEVELS as readonly string[]).includes(value)
    ? (value as LookBusyLevel)
    : null;
}

/**
 * The share of one day's times that should look taken.
 *
 * @param daysAhead civil days from today (0 = today), in the page's zone
 * @param wobble a per-day number in [0, 1) from the page's key, so the day's
 *   share is stable but not the same as its neighbours'
 */
export function lookBusyShare(level: LookBusyLevel, daysAhead: number, wobble: number): number {
  const { near, far } = LOOK_BUSY_LEVEL_INFO[level];
  const eased = far + (near - far) * Math.exp(-Math.max(0, daysAhead) / LOOK_BUSY_EASE_DAYS);
  const share = eased + (wobble * 2 - 1) * LOOK_BUSY_DAY_WOBBLE;
  return Math.min(0.85, Math.max(0.05, share));
}

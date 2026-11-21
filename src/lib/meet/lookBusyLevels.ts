/** Look-busy settings shared by the availability service and admin console. */
export const LOOK_BUSY_LEVELS = ["light", "balanced", "packed"] as const;
export type LookBusyLevel = (typeof LOOK_BUSY_LEVELS)[number];

export const DEFAULT_LOOK_BUSY_LEVEL: LookBusyLevel = "balanced";

export const LOOK_BUSY_LEVEL_INFO = {
  light: {
    label: "Light",
    detail: "Show up to five times per day",
    dailyLimit: 5,
  },
  balanced: {
    label: "Balanced",
    detail: "Show up to four times per day",
    dailyLimit: 4,
  },
  packed: {
    label: "Packed",
    detail: "Show up to three times per day",
    dailyLimit: 3,
  },
} as const satisfies Record<LookBusyLevel, { label: string; detail: string; dailyLimit: number }>;

/** A stored or submitted value as a level; anything unknown reads as off. */
export function parseLookBusyLevel(value: unknown): LookBusyLevel | null {
  return typeof value === "string" && (LOOK_BUSY_LEVELS as readonly string[]).includes(value)
    ? (value as LookBusyLevel)
    : null;
}

import { getMeetConfig } from "../config";
import type { CalendarProvider, CalendarProviderId } from "../types";
import { googleProvider } from "./google";
import { microsoftProvider } from "./microsoft";
import { mockProvider } from "../mock";
import { registerMicrosoftTokenRotationPersistence } from "../tokenRotation";

/** Provider registry. Mock mode swaps both providers for the fake ones. */
export function getProvider(id: CalendarProviderId): CalendarProvider {
  if (getMeetConfig().mockMode) return mockProvider(id);
  if (id === "microsoft") {
    // Microsoft rotates refresh tokens on use; without this hook a rotated
    // token is lost and the connection dies when the old one expires.
    registerMicrosoftTokenRotationPersistence();
    return microsoftProvider;
  }
  return googleProvider;
}

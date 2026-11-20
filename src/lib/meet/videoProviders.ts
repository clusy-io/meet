import "server-only";
import type { MeetConfig } from "./config";
import { getEffectiveMeetConfig } from "./members";
import { configForMeetingType } from "./meetingTypes";
import { ensureMockReady } from "./mock";
import { getMeetStore } from "./store";
import { VIDEO_CHOICES, type CalendarAccount, type MeetingType, type VideoChoice } from "./types";

export function videoServiceForAccount(
  config: MeetConfig,
  account: Pick<CalendarAccount, "provider" | "email">,
): VideoChoice | null {
  if (account.provider === "google") return "meet";
  if (config.mockMode) return "teams";
  const domain = account.email.trim().toLowerCase().split("@")[1];
  const host = new URL(config.siteOrigin).hostname.replace(/^www\./, "");
  if (domain && (host === domain || config.teamsDomains?.includes(domain))) {
    return "teams";
  }
  return null;
}

/** Public pages receive service names only. Availability determines the actual hosts at booking time. */
export async function availableVideoProviders({
  host, meetingType = "meeting",
}: { host?: string; meetingType?: MeetingType }): Promise<VideoChoice[]> {
  try {
    const config = await getEffectiveMeetConfig();
    const eligible = configForMeetingType(config, meetingType);
    if (!eligible) return [];
    const memberKeys = eligible.members.map((member) => member.key).filter((key) => !host || key === host);
    if (config.mockMode) await ensureMockReady();
    const accounts = await getMeetStore().listConnectedVideoAccounts(memberKeys);
    const services = new Set(accounts.map((account) => videoServiceForAccount(config, account)));
    return VIDEO_CHOICES.filter((service) => services.has(service));
  } catch (error) {
    console.error("meet: could not load available video services", error);
    return [];
  }
}

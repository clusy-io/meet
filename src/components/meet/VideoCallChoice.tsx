import type { VideoChoice } from "@/lib/meet/types";
import styles from "./BookingDetails.module.css";

export const videoProviderLabels: Record<VideoChoice, string> = {
  meet: "Google Meet",
  teams: "Microsoft Teams",
};

export function VideoCallChoice({
  options,
  value,
  disabled,
  onChange,
}: {
  options: VideoChoice[];
  value: VideoChoice | undefined;
  disabled: boolean;
  onChange: (value: VideoChoice) => void;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className={styles.label}>Video call</legend>
      <div className={styles.videoChoices}>
        {options.map((provider) => (
          <label key={provider} className={styles.videoOption}>
            <input
              type="radio"
              name="video"
              value={provider}
              checked={value === provider}
              onChange={() => onChange(provider)}
            />
            {videoProviderLabels[provider]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

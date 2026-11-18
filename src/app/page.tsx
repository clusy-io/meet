import type { Metadata } from "next";
import { ArrowRight, BriefcaseBusiness, MessageCircle, Users } from "lucide-react";
import MeetShell from "@/components/meet/MeetShell";
import styles from "@/components/meet/MeetShell.module.css";
import { getMeetConfig } from "@/lib/meet/config";
import { teamMeetingTypes } from "@/lib/meet/meetingTypes";
import { SITE } from "@/meet.config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: SITE.bookingTitle,
  description: SITE.description,
  alternates: { canonical: "/" },
  openGraph: {
    title: SITE.bookingTitle,
    description: SITE.description,
    url: "/",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: SITE.bookingTitle,
    description: SITE.description,
  },
};

const icons = { chat: MessageCircle, meeting: Users, investor: BriefcaseBusiness };

export default function MeetPage() {
  const options = teamMeetingTypes(getMeetConfig());
  return (
    <MeetShell>
      <section className={styles.landing} aria-labelledby="meeting-picker-title">
        <header className={styles.intro}>
          <h1 id="meeting-picker-title" className={styles.title}>{SITE.bookingTitle}</h1>
          <p className={styles.prompt}>Choose a meeting type.</p>
        </header>
        <ul className={styles.choices}>
          {options.map(({ key, label, durationMinutes }) => {
            const Icon = icons[key];
            return (
              <li key={key}>
                {/* A document navigation lets the calendar start its availability request during HTML parsing. */}
                <a href={`/book/${key}`} className={styles.choice}>
                  <span className={styles.icon}><Icon size={20} strokeWidth={1.6} aria-hidden /></span>
                  <span className={styles.name}>{label}</span>
                  <span className={styles.duration}>{durationMinutes} min</span>
                  <ArrowRight size={16} aria-hidden className={styles.arrow} />
                </a>
              </li>
            );
          })}
        </ul>
      </section>
    </MeetShell>
  );
}

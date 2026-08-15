/**
 * Public, non-secret branding. Forks usually only need to edit this file and
 * replace the files in /public. Runtime secrets and scheduling policy belong
 * in environment variables; see .env.example.
 */
export const SITE = {
  name: "Clusy",
  legalName: "Clusy Inc.",
  bookingTitle: "Book a call with the Clusy team",
  description: "Choose an available time and book directly with the Clusy team.",
  homepage: "https://clusy.io",
  repository: "https://github.com/clusy-io/meet",
  logo: "/logo.png",

  /**
   * Optional nudge on the confirmation card and in the booker's confirmation
   * email. Omit it (or leave any field empty) and nothing renders, which is the
   * default: a scheduler should not advertise anything unless its operator
   * asked it to.
   *
   * It never appears on cancellations, reschedules, reminders, or the team's
   * copy of a booking.
   *
   *   cta: {
   *     lead: "While you wait",
   *     body: "One sentence about what you do.",
   *     linkLabel: "Take a look",
   *     href: "https://example.com",
   *   },
   */
} as const;

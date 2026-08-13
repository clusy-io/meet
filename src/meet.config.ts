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
} as const;

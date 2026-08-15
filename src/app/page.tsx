import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import SiteFooter from "@/components/SiteFooter";
import { AvailabilityPrime } from "@/components/meet/AvailabilityPrime";
import MeetBooking from "@/components/meet/MeetBooking";
import { SITE } from "@/meet.config";

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

export default function MeetPage() {
  return (
    <main className="flex min-h-screen flex-col bg-paper text-ink">
      <AvailabilityPrime />
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <Link
          href={SITE.homepage}
          aria-label={`${SITE.name} home`}
          className="inline-flex shrink-0 items-center rounded-md transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Image
            src={SITE.logo}
            alt={SITE.name}
            width={112}
            height={30}
            className="h-7 w-auto dark:brightness-0 dark:invert"
            priority
          />
        </Link>
        <ThemeToggle />
      </header>

      <div className="flex flex-1 justify-center px-5 pb-16 pt-6 sm:px-8 sm:pt-10">
        <MeetBooking />
      </div>
      <SiteFooter />
    </main>
  );
}

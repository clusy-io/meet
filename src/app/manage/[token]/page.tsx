import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import ManageBooking from "@/components/meet/ManageBooking";
import ThemeToggle from "@/components/ThemeToggle";
import { toBookingView } from "@/lib/meet/bookings";
import { getMeetConfig } from "@/lib/meet/config";
import { getMeetStore } from "@/lib/meet/store";
import { SITE } from "@/meet.config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manage links are private, token-addressed pages; keep them out of search.
export const metadata: Metadata = {
  title: "Manage booking",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ManageBookingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const booking = await getMeetStore().getBookingByToken(token);
  if (!booking) notFound();
  const hostTimezone = getMeetConfig().hostTimezone;

  return (
    <main className="flex min-h-screen flex-col bg-paper text-ink">
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between px-5 pt-8 sm:px-6">
        <Link href="/" aria-label={`${SITE.name} Meet home`} className="inline-flex shrink-0 items-center">
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

      <div className="mx-auto w-full max-w-2xl flex-1 px-5 pb-24 pt-12 sm:px-6 sm:pt-16">
        <ManageBooking initial={toBookingView(booking)} hostTimezone={hostTimezone} />
      </div>
    </main>
  );
}

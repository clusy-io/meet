import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import SiteFooter from "@/components/SiteFooter";
import MeetBooking from "@/components/meet/MeetBooking";
import { getPage } from "@/lib/meet/pages";
import { SITE } from "@/meet.config";

/**
 * One person's booking page: /<member key>.
 *
 * This is a ROOT dynamic segment, so it is the last thing the router tries.
 * Static segments win, which is why /admin and /manage/<token> keep their own
 * pages — but everything with no route of its own lands here, including bare
 * /manage and stray probes like /.env. getPage() answers null for anything
 * that is not a configured member, and for the reserved slugs, so those all
 * become an ordinary 404.
 *
 * Rendered per request rather than prerendered: whether a page is live, and
 * the copy on it, are settings edited from /admin at runtime.
 */

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ member: string }> };

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const { member } = await params;
  const page = await getPage(member);
  if (!page || !page.enabled) return { title: "Not found" };

  const title = `Book a call with ${page.member.name}`;
  const description =
    page.blurb ?? `Choose an available time and book directly with ${page.member.name}.`;
  const url = `/${page.member.key}`;
  return {
    title,
    description,
    // Personal pages are public and indexable, unlike /manage.
    alternates: { canonical: url },
    // No images: this repo ships no opengraph-image route, and naming one here
    // would resolve straight back to this page.
    openGraph: { title, description, url, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default async function MemberBookingPage({ params }: RouteParams) {
  const { member } = await params;
  const page = await getPage(member);
  // A disabled page is a 404 for visitors, exactly like an unknown slug: the
  // admin console is where its existence is still visible.
  if (!page || !page.enabled) notFound();

  return (
    <main className="flex min-h-screen flex-col bg-paper text-ink">
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
        <MeetBooking
          host={page.member.key}
          headline={`Book a call with ${page.headline}`}
          blurb={page.blurb}
        />
      </div>
      <SiteFooter />
    </main>
  );
}

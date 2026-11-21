import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import SiteFooter from "@/components/SiteFooter";
import ThemeToggle from "@/components/ThemeToggle";
import { SITE } from "@/meet.config";
import styles from "./MeetShell.module.css";

export default function MeetShell({
  children,
  prime,
  homeHref = SITE.homepage,
  calendar,
}: {
  children: ReactNode;
  prime?: ReactNode;
  homeHref?: string;
  calendar?: "team" | "personal";
}) {
  const masthead = (
    <header className={styles.masthead}>
      <Link href={homeHref} aria-label={`${SITE.name} home`} className={styles.brand}>
        <Image
          src={SITE.logo}
          alt={SITE.name}
          width={112}
          height={30}
          className="h-7 w-auto dark:brightness-0 dark:invert"
          priority
        />
      </Link>
      <div className={styles.calendarNav}>
        <ThemeToggle className="border border-hairline" />
        {calendar === "team" && (
          <Link href="/" className={styles.calendarBack}>
            Meeting types
            <ArrowRight size={15} aria-hidden />
          </Link>
        )}
      </div>
    </header>
  );
  return (
    <main className={styles.shell} data-calendar={calendar ? true : undefined}>
      {prime}
      {calendar ? (
        <div className={styles.calendarScroll}>
          {masthead}
          <div className={styles.calendarContent}>{children}</div>
        </div>
      ) : (
        <>{masthead}{children}</>
      )}
      <SiteFooter />
    </main>
  );
}

import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import SiteFooter from "@/components/SiteFooter";
import ThemeToggle from "@/components/ThemeToggle";
import { SITE } from "@/meet.config";
import styles from "./MeetShell.module.css";

export default function MeetShell({
  children,
  prime,
  homeHref = SITE.homepage,
  calendar = false,
}: {
  children: ReactNode;
  prime?: ReactNode;
  homeHref?: string;
  calendar?: boolean;
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
        {calendar && (
          <Link href="/" className={styles.calendarBack}>
            <ArrowLeft size={15} aria-hidden />
            Meeting types
          </Link>
        )}
        <ThemeToggle className="border border-hairline" />
      </div>
    </header>
  );
  return (
    <main className={styles.shell} data-calendar={calendar || undefined}>
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

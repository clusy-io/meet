import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import SiteFooter from "@/components/SiteFooter";
import ThemeToggle from "@/components/ThemeToggle";
import { SITE } from "@/meet.config";
import styles from "./MeetShell.module.css";

export default function MeetShell({
  children,
  prime,
  homeHref = SITE.homepage,
}: {
  children: ReactNode;
  prime?: ReactNode;
  homeHref?: string;
}) {
  return (
    <main className={styles.shell}>
      {prime}
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
        <ThemeToggle className="border border-hairline" />
      </header>
      {children}
      <SiteFooter />
    </main>
  );
}

import { SITE } from "@/meet.config";

export default function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-5xl px-5 pb-8 sm:px-8">
      <div className="border-t border-hairline pt-6 text-center text-xs leading-[18px] text-ink-soft">
        <p>© {new Date().getFullYear()} {SITE.legalName}</p>
        <p className="mt-1.5">
          Built with{" "}
          <a
            href={SITE.repository}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            meet<span className="sr-only"> (opens in a new tab)</span>
          </a>
          , our open-source template
        </p>
      </div>
    </footer>
  );
}

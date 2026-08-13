"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";

type ThemeToggleProps = {
  className?: string;
  iconClassName?: string;
  showLabel?: boolean;
};

export default function ThemeToggle({
  className = "",
  iconClassName = "h-4 w-4",
  showLabel = false,
}: ThemeToggleProps) {
  const { resolvedTheme, setTheme, isMounted } = useTheme();

  if (!isMounted) {
    return <span className={`inline-flex h-8 w-8 ${className}`} aria-hidden="true" />;
  }

  const isDark = resolvedTheme === "dark";
  const Icon = isDark ? Sun : Moon;
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full bg-transparent text-gray-500 transition hover:bg-gray-100/70 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 focus-visible:ring-offset-2 dark:text-stone-300 dark:hover:bg-stone-800/70 dark:hover:text-white dark:focus-visible:ring-stone-500 dark:focus-visible:ring-offset-stone-950 ${className}`}
    >
      <Icon className={iconClassName} />
      {showLabel ? <span className="ml-2 text-xs font-medium">{isDark ? "Light" : "Dark"}</span> : null}
    </button>
  );
}

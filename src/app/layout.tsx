import type { Metadata } from "next";
import { Geist, Geist_Mono, Libre_Baskerville } from "next/font/google";
import { ThemeProvider } from "@/components/ThemeProvider";
import { SITE } from "@/meet.config";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const libreBaskerville = Libre_Baskerville({
  variable: "--font-libre",
  weight: ["400", "700"],
  subsets: ["latin"],
});

const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

const THEME_INIT_SCRIPT = `
(function() {
  try {
    var stored = localStorage.getItem("meet-theme");
    var dark = stored === "dark" || (stored === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {}
})();
`;

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: SITE.bookingTitle,
  description: SITE.description,
  applicationName: `${SITE.name} Meet`,
  authors: [{ name: SITE.legalName, url: SITE.homepage }],
  creator: SITE.legalName,
  publisher: SITE.legalName,
  openGraph: {
    title: SITE.bookingTitle,
    description: SITE.description,
    url: "/",
    siteName: `${SITE.name} Meet`,
    type: "website",
  },
  twitter: {
    card: "summary",
    title: SITE.bookingTitle,
    description: SITE.description,
  },
  icons: {
    icon: [
      { url: "/logo11-favicon.ico", sizes: "any" },
      { url: "/logo11.png", type: "image/png" },
    ],
    apple: "/logo11.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} ${libreBaskerville.variable}`}>
        <script id="theme-init" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <ThemeProvider>{children}</ThemeProvider>
        <div className="paper-grain" aria-hidden />
      </body>
    </html>
  );
}

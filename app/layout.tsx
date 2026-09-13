import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeToggle } from "@/components/ThemeToggle";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Sentinel — confidential systemic-risk oracle",
  description:
    "How much borrowed value sits with addresses levered across multiple lending protocols on the same collateral — aggregated inside a TEE, published as a signed signal, with no address ever leaving.",
};

/**
 * Applies the stored theme before first paint.
 *
 * Without it a reader who chose light mode gets a frame of dark, which on a dark-heavy
 * palette is a visible flash. Inline because it must run before the stylesheet paints;
 * `next dev` will not hoist it any earlier. The default with no stored choice is the OS
 * preference, which `tokens.css` already handles in a media query.
 */
const THEME_INIT = `try{var t=localStorage.getItem("sentinel-theme");if(t==="dark"||t==="light")document.documentElement.classList.add("theme-"+t)}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <a href="#main" className="skip-link">
          Skip to the signal
        </a>
        <header className="flex items-center justify-between gap-4 border-b px-6 py-3 border-[var(--color-border)]">
          <div className="flex items-baseline gap-3">
            <a
              href="/"
              className="text-[length:var(--text-heading)] font-semibold tracking-tight no-underline text-[var(--color-text)]"
            >
              Sentinel
            </a>
            <span className="text-[length:var(--text-label)] text-[var(--color-text-muted)]">
              confidential systemic-risk oracle
            </span>
          </div>
          <nav className="flex items-center gap-4 text-[length:var(--text-label)]">
            <a href="/styleguide" className="text-[var(--color-accent)]">
              Styleguide
            </a>
            <ThemeToggle />
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}

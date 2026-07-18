import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { QueryProvider } from "@/api/query-provider";
import { AuthProvider } from "@/lib/auth-context";
import { UpdateNotifier } from "@/components/update-notifier";

export const metadata: Metadata = {
  title: "ServoSync",
  description: "ServoSync — sinhronizacija podataka iz QBigTehn",
};

// No-flash tema: pročitaj `servosync.ui.theme` i postavi <html data-theme> PRE prvog
// paint-a, da svetla/tamna varijanta ne „blesne". `light`/`dark` = eksplicitno; `system`
// uklanja atribut → odlučuje @media prefers-color-scheme; BEZ sačuvane preference →
// default 'light' (paritet sa DEFAULTS.theme u use-ui-prefs — da dark-OS korisnik bez
// izbora ne dobije dark neočekivano). Bez React-a/zavisnosti; guard try (privatni režim
// ume da baci na localStorage). Sinhrono u <head> = pre body render-a.
const THEME_INIT_SCRIPT =
  "(function(){try{var t=localStorage.getItem('servosync.ui.theme');var e=document.documentElement;if(t==='dark'||t==='light'){e.dataset.theme=t;}else if(t==='system'){delete e.dataset.theme;}else{e.dataset.theme='light';}}catch(_){}})();";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: no-flash skript menja <html data-theme> pre hydrate-a,
    // pa se server (bez atributa) i klijent (sa atributom) namerno razlikuju.
    <html lang="sr" className="h-full" suppressHydrationWarning>
      <head>
        {/* UA zna da stranica podržava obe šeme (scrollbar/native kontrole/autofill pre
            nego što CSS `color-scheme` iz tokens.css preuzme) — SIDEBAR_THEME_SPEC §3/§4. */}
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-app text-ink">
        {/* Opcioni runtime override za API base URL (LAN/offline) — vidi public/config.js.
            beforeInteractive: izvrši se pre app koda, pa je override spreman pre prvog fetch-a. */}
        <Script src="/config.js" strategy="beforeInteractive" />
        <QueryProvider>
          <AuthProvider>{children}</AuthProvider>
        </QueryProvider>
        {/* Baner "dostupna je nova verzija — osvežite" (poredi bundle vs /version.json) */}
        <UpdateNotifier />
      </body>
    </html>
  );
}

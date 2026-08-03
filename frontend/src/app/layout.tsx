import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { QueryProvider } from "@/api/query-provider";
import { AuthProvider } from "@/lib/auth-context";
import { UpdateNotifier } from "@/components/update-notifier";

export const metadata: Metadata = {
  title: "ServoSync",
  description: "ServoSync — sinhronizacija podataka iz QBigTehn",
  // iOS Safari sam „prepoznaje" nizove cifara i crta ih kao tel: linkove — RN
  // brojevi, kataloške i magacinske šifre (K-A1, 9400-123) postanu plavo-podvučeni
  // i tap otvara „Pozovi?". Paritet sa 1.0 (`index.html`
  // <meta name="format-detection" content="telephone=no">).
  formatDetection: { telephone: false },

  /**
   * PWA manifest — „Dodaj na početni ekran" za `/mob` (paritet sa 1.0, koja ima
   * svoj manifest pod `/m`). Bez njega iPhone pravi screenshot-ikonicu i otvara
   * Safari sa adresnom trakom, Android ne nudi instalaciju, a Web Push na iOS-u
   * (koji radi ISKLJUČIVO iz instalirane aplikacije) nema preduslov.
   *
   * ⚠ PUTANJA `/mob.webmanifest`, NE podrazumevana `/manifest.webmanifest`:
   * `worker/index.ts` (Cloudflare, `run_worker_first: true`) proksira na staru 1.0
   * SVE što padne u `/m`, `/m/*`, `/assets/*`, `/icons/*` i `/manifest.webmanifest`,
   * i to PRE ASSETS bindinga. Zato bi Next-ov `app/manifest.ts` (koji uvek emituje
   * baš `/manifest.webmanifest`) bio nedostupan — manifest je statički fajl u
   * `public/`, a ikone su u `public/mob-icons/`, ne u `public/icons/`. Ni jedna od
   * te dve putanje ne pada u proxy pravila: `startsWith('/m/')` traži „/m" pa kosu
   * crtu, a „/mob…" je nema.
   *
   * ⚠ `scope` u manifestu je `/mob` (od 02.08.2026; ranije `/`) i JEDNAK je scope-u
   * service worker-a `public/mob-sw.js` — .webmanifest ne trpi komentare pa
   * obrazloženje stoji ovde:
   *   • Chrome za Android nudi „Instaliraj aplikaciju" tek kad `start_url` (`/mob`)
   *     kontroliše SW sa stvarnim `fetch` rukovaocem. Scope `/mob` ga kontroliše;
   *     `/mob/` (sa kosom crtom) NE BI — poređenje je prefiks nad stringom, pa sama
   *     početna `/mob` ne bi bila u njemu.
   *   • Scope `/` bi značio da 3.0 WebAPK polaže pravo na CEO origin — uključujući
   *     `/m*`, gde `worker/index.ts` servira STARU 1.0 mobilnu. 1.0 je najtvrđe
   *     pravilo ovog repoa, pa 3.0 ostaje u svom prostoru.
   * Instalirana aplikacija svaku navigaciju VAN scope-a otvara spolja (iOS: Safari,
   * koji od 16.4 ima ODVOJEN storage → prijava bi pala u pogrešnu teglu i vrtela
   * beskonačnu petlju). Zato su oba vanredna auth toka preseljena U scope:
   *   • guard svih ~26 `/mob` strana → `/mob/prijava` (ne `/login`),
   *   • prinudna izmena lozinke → `/mob/prijava` (`lib/auth-context.tsx`).
   * Ostaje jedan svestan izlaz: dugme „desktop" u zaglavlju `/mob` početne (`/`) —
   * eksplicitan korisnikov zahtev da napusti mobilnu ljusku, i jedini gde je otvaranje
   * u pregledaču ispravno ponašanje.
   */
  manifest: "/mob.webmanifest",

  /**
   * Bez `apple-mobile-web-app-capable` iOS uopšte ne ulazi u standalone režim —
   * ikonica na ekranu bi i dalje otvarala Safari sa adresnom trakom. Vrednosti su
   * paritet sa 1.0 (`index.html`), samo je naslov 3.0.
   *
   * `statusBarStyle: 'default'` je SVESNO odstupanje od 1.0, koja ima
   * `black-translucent`: uz njega iOS crta sat/bateriju BELO, što je tačno za tamnu
   * 1.0 (`#0a0e14`), ali 3.0 starta u svetloj temi (`#f7f9f9`) — belo na svetlom
   * zaglavlju je nečitljivo, i to je prvo što korisnik vidi. `default` je čitljiv u
   * obe teme; raspored ne trpi jer `MobShell` ionako računa `env(safe-area-inset-top)`.
   * Ako 3.0 ikad postane podrazumevano tamna, `black-translucent` se vraća.
   */
  appleWebApp: {
    capable: true,
    title: "ServoSync 3.0",
    statusBarStyle: "default",
  },

  // iOS ne razume `purpose: 'maskable'` niti bira iz manifesta pouzdano — uzima
  // <link rel="apple-touch-icon">. Slika je 180×180 BEZ alfa kanala (providne
  // piksele iOS crta kao crne) i bez zaobljenja (iOS sam maskira).
  icons: {
    apple: "/mob-icons/apple-touch-icon-180.png",
  },
};

/**
 * `viewport-fit=cover` je USLOV da uređaj uopšte isporuči `env(safe-area-inset-*)`
 * (bez njega vraća 0 i sav safe-area kod je mrtav): donja traka `/mob` ljuske
 * pada pod home-indicator crtu, a notch zona nije zaštićena. Paritet sa 1.0
 * (`index.html` meta viewport). NE UKLANJATI.
 *
 * ⚠ Nije „bez efekta na uređajima bez notch-a", kako je pisalo do 02.08.2026:
 * `cover` znači da pregledač crta stranu PREKO sistemskih traka, pa i na Android
 * uređajima bez notch-a (edge-to-edge, Android 15) sadržaj ulazi u zonu
 * sistemske navigacije. Zato svaka ivica koja dodiruje ekran — fiksirana traka
 * akcije, sticky zaglavlje, footer sheeta — MORA imati `env(safe-area-inset-*)`
 * u padding-u; bez toga je CTA pod sistemskim dugmadima.
 *
 * `interactiveWidget` se NE postavlja — ostaje podrazumevano `resizes-visual`.
 * Vrednost `resizes-content` je 02.08.2026 isporučena u iPhone commitu (gde je
 * iOS ionako ignoriše), dakle bez ijedne probe na Androidu, a menja isključivo
 * Android: tastatura tada skraćuje LAYOUT viewport, pa se svaki `position: fixed`
 * element (skener overlay, donja traka akcije, tab traka) sabija na traku iznad
 * tastature. U skenerima to udara i sa `useVisualViewportFix`, koji overlay
 * dodatno lepi na visual viewport — tap u polje ručnog unosa je gasio kadar.
 * Dobitak („Sačuvaj" ostaje vidljiv) ionako pokriva `Dialog` (`max-h-[90dvh]`,
 * skroluje se telo, footer sa safe-area). Ako se ikad vrati, ide uz Android probu
 * skener ljuske i ovo obrazloženje se menja.
 *
 * `themeColor` = boja UI hroma Safarija; vrednosti su doslovne kopije tokena
 * `--bg` (`styles/tokens.css`, svetla `#f7f9f9` / tamna `#0a1116`) jer meta tag
 * ne ume da čita CSS promenljive — jedini dozvoljen „hex van tokena" (§3), i
 * menja se ZAJEDNO sa tokenom.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f9f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0a1116" },
  ],
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
        {/* `appleWebApp.capable` u metadata (gore) Next 16 emituje kao STANDARDNI
            `mobile-web-app-capable` — a njega Safari razume tek od iOS 17.4. Na
            starijim iPhone-ima jedini prekidač za standalone režim je i dalje
            `apple-mobile-web-app-capable`; bez njega ikonica sa početnog ekrana
            otvara Safari sa adresnom trakom. Zato ide ručno, kao u 1.0
            (`index.html`). Nije duplikat — to je drugo ime tag-a. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
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

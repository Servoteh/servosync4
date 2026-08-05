const UPSTREAM = 'https://servoteh-plan-montaze.pages.dev';

/* ═══════════════════════════════════════════════════════════════════════════
 * PREKIDAČ ZA POVRATAK 1.0  (cutover 05.08.2026)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   true  → 1.0 je ŽIVA. Worker proksira `/m`, `/m/*`, `/assets/*`, `/icons/*`
 *           i `/manifest.webmanifest` na stari pages.dev. To je ponašanje koje
 *           je važilo do 05.08.2026 — APK ljuska i obeleživači otvaraju 1.0.
 *
 *   false → 1.0 je UGAŠENA (današnje stanje). Ništa se ne proksira; svaki
 *           zahtev pada na ASSETS (3.0 static export). Tamo `out/m/*.html`
 *           stranice (src/app/m/…, LegacyMobRedirect) preusmeravaju radnika
 *           1:1 na odgovarajući `/mob/*` ekran, pa stari obeleživač i APK
 *           prečica završe na TAČNOM 3.0 ekranu, ne na početnoj.
 *
 * SVESNO NEPOKRIVENO dok je prekidač `false`: `/assets/*`, `/icons/*` i
 * `/manifest.webmanifest` su statika SAMO stare 1.0 — 3.0 takve putanje nema
 * (manifest joj je `/mob.webmanifest`, ikone u `/mob-icons/`), pa one vraćaju
 * 404. To je odluka, ne propust: APK ljuska i obeleživači ulaze na `/m`, a
 * desktop PWA 1.0 instaliranu preko `/manifest.webmanifest` praktično niko
 * nema. Stubovi im se namerno NE prave.
 *
 * KAKO SE VRAĆA 1.0 (~2 minuta, bez `git revert`):
 *   1. u OVOM fajlu postavi  PROXY_1_0_AKTIVAN = true
 *   2. commit poruka MORA sadržati marker  [worker-change]
 *      (brava u .github/workflows/deploy-frontend.yml inače blokira deploy)
 *   3. push na `main` → workflow „deploy-frontend" objavi za ~2 min i 1.0 je
 *      opet živa. Ručna hitna varijanta: `cd frontend && npx wrangler deploy`.
 *
 * Kod za proxy se NAMERNO NE BRIŠE — samo se zaobilazi ovim prekidačem.
 * pages.dev projekat takođe ostaje živ (rezerva), vidi
 * docs/ANALIZA_GASENJE_1.0_2026-08-03.md §3.
 * ═══════════════════════════════════════════════════════════════════════════ */
// Tip je namerno `boolean` (ne literal `false`) da TS/alati ne proglase proxy
// granu „mrtvim kodom" — ona mora ostati netaknuta radi povratka.
const PROXY_1_0_AKTIVAN: boolean = false;

/*
 * Same-origin kapija za staru 1.0 mobilnu (aktivna samo dok je prekidač `true`):
 * instalirani Capacitor APK učitava /m sa ovog domena, a nativni plugini (barkod
 * skener, STT, push) rade samo dok WebView ostaje na server.url origin-u —
 * redirect na drugi domen izbaci app u spoljni browser. Zato se 1.0 sadržaj
 * proksira odavde.
 *
 * REDOSLED ODLUČIVANJA: `run_worker_first: true` u wrangler.jsonc znači da Worker
 * odlučuje PRVI za svaki zahtev — pre ASSETS bindinga. Dok je prekidač `true`,
 * SVE /m/* rute idu na 1.0 čak i kad u static exportu postoji istoimeni 3.0 asset
 * (out/m/*.html). Kad je `false`, worker ne dira ništa i baš ti `out/m/*.html`
 * preusmerivači dolaze do izražaja. Kanonski 3.0 mobilni ekrani su pod `/mob/*`.
 *
 * Ovaj fajl je zaštićen guard-om u .github/workflows/deploy-frontend.yml:
 * izmena prolazi na deploy samo ako commit poruka nosi marker [worker-change].
 */
function jeStaraMobilna(pathname: string): boolean {
  return (
    pathname === '/m' ||
    pathname.startsWith('/m/') ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest'
  );
}

export default {
  async fetch(request: Request, env: { ASSETS: { fetch: typeof fetch } }): Promise<Response> {
    const url = new URL(request.url);
    if (
      PROXY_1_0_AKTIVAN &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      jeStaraMobilna(url.pathname)
    ) {
      return fetch(UPSTREAM + url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        redirect: 'follow',
      });
    }
    return env.ASSETS.fetch(request);
  },
};

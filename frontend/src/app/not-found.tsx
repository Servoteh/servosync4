'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 404 + poslednja stanica za DEEP LINKOVE 1.0 sa dinamičkim segmentom
 * (cutover 1.0, 05.08.2026 — docs/ANALIZA_GASENJE_1.0_2026-08-03.md).
 *
 * Statične 1.0 putanje imaju svoje stubove (`src/app/plan-montaze`,
 * `src/app/maintenance/…`, `src/app/m/…`). Ali 1.0 je bila SPA i imala rute sa
 * promenljivim segmentom — `/sastanci/<uuid>`, `/maintenance/machines/<šifra>`,
 * `/maintenance/assets/vehicles/<šifra>` … Njih 3.0 ne može da izveze kao
 * fajlove: build je `output: "export"`, a `[id]` segment bez stvarnih
 * `generateStaticParams` izveze samo placeholder `_` (frontend/CLAUDE.md §10).
 * Zato ih hvatamo ovde — Cloudflare (`not_found_handling: "404-page"`) servira
 * baš ovu stranicu na nepoznatoj putanji, a `window.location.pathname` u
 * pregledaču i dalje drži ORIGINALNI link.
 *
 * 🔴 Ne preusmerava se naslepo: mapiraju se samo poznati 1.0 prefiksi. Sve
 * ostalo je pravi 404 i ostaje 404.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizuj(putanja: string): string {
  return putanja.length > 1 && putanja.endsWith('/') ? putanja.slice(0, -1) : putanja;
}

function dekodiraj(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function upit(par: Record<string, string>): string {
  return new URLSearchParams(par).toString();
}

/** Vrati 3.0 cilj za staru 1.0 putanju, ili `null` ako je ovo stvarni 404. */
function ciljZaLegacyPutanju(putanja: string): string | null {
  const p = normalizuj(putanja);

  /* ── Sastanci ────────────────────────────────────────────────────────────
   * Najvredniji slučaj: linkove na sastanak ljudi šalju jedni drugima i u
   * mejlovima (pozivnice, zapisnici). 3.0 detalj je stanje UNUTAR strane i
   * otvara se sa `?open=<id>` (src/app/sastanci/page.tsx — `sp.get('open')`),
   * NE sa `?id=`. `?tab=` alias `podesavanja-notif` već postoji u 3.0. */
  if (p === '/sastanci/podesavanja-notifikacija') return '/sastanci?tab=podesavanja-notif';
  const sastanak = /^\/sastanci\/([^/]+)$/.exec(p);
  if (sastanak && UUID.test(sastanak[1])) {
    return `/sastanci?${upit({ open: sastanak[1] })}`;
  }

  /* ── Održavanje (CMMS) ───────────────────────────────────────────────────
   * 3.0 već ima kartone koji ključaju po ŠIFRI (isti razlog: QR nalepnice i
   * 1.0 router nose `asset_code`, ne UUID), pa deep-link sleće na sam karton,
   * ne samo na tab. Vozači nemaju karton-rutu → lista. */
  const masina = /^\/maintenance\/machines\/([^/]+)$/.exec(p);
  if (masina) return `/odrzavanje/masine?${upit({ code: dekodiraj(masina[1]) })}`;

  const vozilo = /^\/maintenance\/assets\/vehicles\/([^/]+)$/.exec(p);
  if (vozilo) return `/odrzavanje/vozila?${upit({ code: dekodiraj(vozilo[1]) })}`;

  const it = /^\/maintenance\/assets\/it\/([^/]+)$/.exec(p);
  if (it) return `/odrzavanje/sredstva?${upit({ code: dekodiraj(it[1]), kind: 'it' })}`;

  const objekat = /^\/maintenance\/assets\/facilities\/([^/]+)$/.exec(p);
  if (objekat) {
    return `/odrzavanje/sredstva?${upit({ code: dekodiraj(objekat[1]), kind: 'facility' })}`;
  }

  if (/^\/maintenance\/drivers\/[^/]+$/.test(p)) return '/odrzavanje?tab=vozaci';

  // Bilo šta drugo pod /maintenance/ → modul Održavanje.
  if (p === '/maintenance' || p.startsWith('/maintenance/')) return '/odrzavanje';

  // Nepoznata 1.0 mobilna ruta → app hub. Isto je radila i 1.0 sama
  // (appPaths.js: „Sve nepoznate `/m/*` vode na home").
  if (p === '/m' || p.startsWith('/m/')) return '/mob';

  return null;
}

export default function NotFound() {
  const router = useRouter();
  // `ceka` na prvom renderu i na serveru (prerender) — bez toga bi radnik sa
  // ispravnim starim linkom na tren video „Stranica ne postoji".
  const [stanje, setStanje] = useState<'ceka' | 'nema'>('ceka');

  useEffect(() => {
    const cilj = ciljZaLegacyPutanju(window.location.pathname);
    if (!cilj) {
      setStanje('nema');
      return;
    }
    // Query sa starog linka se prenosi; parametri cilja imaju prednost.
    const [put, ciljUpit = ''] = cilj.split('?');
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of new URLSearchParams(ciljUpit)) params.set(k, v);
    const spojen = params.toString();
    router.replace(`${put}${spojen ? `?${spojen}` : ''}${window.location.hash}`);
  }, [router]);

  if (stanje === 'ceka') {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center">
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
        <noscript>
          <p className="text-sm text-ink-secondary">
            Stranica ne postoji. <a href="/pocetna">Nazad na početnu</a>
          </p>
        </noscript>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-app p-6 text-center">
      <div>
        <h1 className="text-md font-semibold text-ink">Stranica ne postoji</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Adresa je pogrešna ili je ekran preseljen.
        </p>
        <a
          href="/pocetna"
          className="mt-4 inline-flex min-h-11 items-center rounded-control bg-accent px-4 text-sm font-semibold text-accent-fg"
        >
          Nazad na početnu
        </a>
      </div>
    </main>
  );
}

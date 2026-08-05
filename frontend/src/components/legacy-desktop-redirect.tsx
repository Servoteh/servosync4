'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Redirect sa STARE 1.0 desktop rute (`/plan-montaze`, `/maintenance/*`, …) na
 * kanonsku 3.0 rutu (cutover 1.0, 05.08.2026 — docs/ANALIZA_GASENJE_1.0_2026-08-03.md §1.3).
 *
 * Postoji zbog obeleživača, mejl-linkova i prečica koje su ljudi pravili dok je
 * 1.0 bila živa. Desktop 1.0 je bila SPA sa `history.pushState` rutiranjem, pa
 * njene putanje nikad nisu postojale u 3.0 static exportu — bez ovih stubova
 * stari link vraća 404 stranicu.
 *
 * `?query` sa starog linka se PRENOSI, ali parametri iz samog `to` imaju prednost
 * (npr. `/stampa-nalepnica?tab=nesto` i dalje sleti na `?tab=stampa`). Hash se
 * prenosi kakav jeste (`#tab=` obrazac 1.0 linkova).
 *
 * Vidljiv `<a>` fallback je u prerenderovanom HTML-u, pa ruta radi i ako JS ne
 * krene (stari pregledač, spora mreža).
 *
 * Mobilni parnjak je `src/app/m/_components/legacy-redirect.tsx`.
 */
export function LegacyDesktopRedirect({ to, label }: { to: string; label: string }) {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === 'undefined') {
      router.replace(to);
      return;
    }
    const [put, ciljUpit = ''] = to.split('?');
    const params = new URLSearchParams(window.location.search);
    // Cilj presuđuje: `?tab=stampa` iz mape ne sme da ga pregazi stari link.
    for (const [k, v] of new URLSearchParams(ciljUpit)) params.set(k, v);
    const upit = params.toString();
    router.replace(`${put}${upit ? `?${upit}` : ''}${window.location.hash}`);
  }, [to, router]);

  return (
    <main className="grid min-h-screen place-items-center bg-app p-6 text-center">
      <div>
        <h1 className="text-md font-semibold text-ink">{label}</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Modul se preselio u ServoSync 3.0 — prebacujem…
        </p>
        <a
          href={to}
          className="mt-4 inline-flex min-h-11 items-center rounded-control bg-accent px-4 text-sm font-semibold text-accent-fg"
        >
          Otvori {to}
        </a>
      </div>
    </main>
  );
}

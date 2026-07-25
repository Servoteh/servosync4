'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Redirect sa STARE 3.0 mobilne rute `/m/<modul>` na kanonsku `/mob/<modul>`
 * (PLAN_MOB_3.0.md, Faza 0 — seoba ekrana).
 *
 * ⚠️ Ovaj kod postoji SAMO zbog LAN bake-a na `:3000` (i obeleživača/linkova
 * nastalih dok su 3.0 ekrani živeli pod `/m/*`). Na javnom domenu se NIKAD ne
 * služi: Cloudflare worker (`run_worker_first`) presreće sve `/m/*` zahteve i
 * proksira ih na 1.0 mobilnu (pages.dev). Rutiranje `/m/*` se ne dira.
 *
 * `?query` se prenosi (deep-link `/m/sastanci?open=<id>`, `?id=N` obrazac static
 * export-a). Vidljiv `<a>` fallback je u prerenderovanom HTML-u, pa ruta radi i
 * ako JS ne krene (stari WebView, spor uređaj).
 */
export function LegacyMobRedirect({ to, label }: { to: string; label: string }) {
  const router = useRouter();

  useEffect(() => {
    const search = typeof window === 'undefined' ? '' : window.location.search;
    router.replace(`${to}${search}`);
  }, [to, router]);

  return (
    <main className="grid min-h-screen place-items-center bg-app p-6 text-center">
      <div>
        <h1 className="text-md font-semibold text-ink">{label}</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Ekran se preselio na novu adresu — prebacujem…
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

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Redirect sa stare mobilne rute `/m/<modul>` na kanonsku `/mob/<modul>`
 * (PLAN_MOB_3.0.md, Faza 0 — seoba ekrana; cutover 1.0 od 05.08.2026).
 *
 * Pokriva OBA nasleđa pod `/m/*`: rute 1.0 mobilne (obeleživači radnika + APK
 * ljuska koja gađa `servosync.servoteh.com/m`) i rute 3.0 ekrana dok su živeli
 * pod `/m/*` (LAN bake na `:3000`).
 *
 * ⚠️ Vidljivost zavisi od prekidača `PROXY_1_0_AKTIVAN` u `worker/index.ts`:
 * dok je `true`, Cloudflare worker (`run_worker_first`) presreće sve `/m/*` i
 * proksira ih na 1.0 (pages.dev), pa se ovi stubovi služe samo na LAN-u. Od
 * cutover-a je `false` → worker ne dira `/m/*` i ovi stubovi su JEDINO što
 * radnik sa starim obeleživačem vidi. Zato mapiranje mora ostati 1:1.
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

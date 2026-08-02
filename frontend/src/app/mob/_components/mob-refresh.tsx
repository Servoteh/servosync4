'use client';

import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';

/**
 * Osvežavanje podataka u mobilnoj ljusci `/mob` — VIDLJIVO DUGME, jer drugog
 * načina nema.
 *
 * Zašto postoji (02.08.2026):
 *  · `globals.css` drži `overscroll-behavior-y: contain` nad `/mob` (da povlačenje
 *    nadole usred skeniranja ne pojede unos) — a Chrome za Android time gasi i
 *    NATIVNI pull-to-refresh;
 *  · `api/query-provider.tsx` ima `refetchOnWindowFocus: false`, pa povratak u
 *    aplikaciju ne osvežava ništa;
 *  · instalirana PWA (`display: standalone`, `mob.webmanifest`) nema ni adresnu
 *    traku ni dugme za ponovno učitavanje.
 * Uz sve troje je uputstvo „osveži stranicu" iz ~18 poruka o grešci bilo doslovno
 * neizvodljivo. Zato poruke sada upućuju na ovo dugme, a ono radi
 * `invalidateQueries()` bez argumenata — jedan potez osvežava i podatke ekrana i
 * `/auth/me/permissions` (koji ima `retry: false`, pa bi inače ostao pao za celu
 * sesiju).
 */

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

export function MobRefreshButton({
  /** `true` = ikona + reč „Osveži" (samostalna poruka); podrazumevano samo ikona (zaglavlje). */
  withLabel = false,
  className = '',
}: {
  withLabel?: boolean;
  className?: string;
}) {
  const qc = useQueryClient();
  const busy = useIsFetching() > 0;

  return (
    <button
      type="button"
      onClick={() => void qc.invalidateQueries()}
      disabled={busy}
      aria-label="Osveži podatke"
      title="Osveži podatke"
      className={`inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-control border border-line bg-surface-2 text-sm font-semibold text-ink active:bg-surface disabled:opacity-60 ${
        withLabel ? 'px-4' : 'w-11'
      } ${FOCUS} ${className}`}
    >
      <RefreshCw className={`h-5 w-5 ${busy ? 'animate-spin' : ''}`} aria-hidden />
      {withLabel && (busy ? 'Osvežavam…' : 'Osveži')}
    </button>
  );
}

/**
 * Pad učitavanja dozvola (`/auth/me/permissions`, `retry: false`) — NIJE zabrana,
 * nego mreža. Bilo je 17 doslovnih kopija ovog ekrana po `/mob` stranama; sada je
 * jedna komponenta, uz dugme kojim se pad zaista može ispraviti bez reload-a
 * (u instaliranoj PWA reload-a nema).
 */
export function MobPermissionsError() {
  return (
    <main className="grid min-h-dvh place-items-center bg-app p-6">
      <div className="grid justify-items-center gap-4 text-center text-sm text-ink-secondary">
        <p>Ne mogu da učitam tvoja prava (mreža?). Proveri vezu pa dodirni „Osveži".</p>
        <MobRefreshButton withLabel />
      </div>
    </main>
  );
}

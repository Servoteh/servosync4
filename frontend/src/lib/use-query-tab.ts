'use client';

// Dvosmerna sinhronizacija „tab u strani ↔ URL ↔ podmeni u sidebaru" (PLAN_NAV_PODMENIJI
// §4.3, F1). Rešava ključnu zamku podmenija: Next App Router NE remount-uje stranicu kad se
// menja SAMO query (`/odrzavanje?tab=kvarovi` → `?tab=masine`), a strane su `?tab=` čitale
// isključivo na mount-u — pa klik na podstavku dok si VEĆ u modulu nije radio ništa.
//
// Kanal je custom DOM event `servosync:nav`:
//   • sidebar/paleta ga emituju PRE navigacije (`emitNavEvent(href)` — URL još nije ažuran,
//     pa cilj putuje u `detail.href`);
//   • strana ga emituje POSLE `history.replaceState` (`emitNavEvent()` bez detalja — URL je
//     već ažuran, potrošači čitaju `window.location`).
// Isti event sluša i `useCurrentSearch` u app-shell-u (highlight podstavke).
//
// SSR/static-export bezbedno: kreće od `defaultKey` (isto na serveru i pri prvom klijentskom
// paint-u → nema hydration mismatch-a), `window.location` se čita tek u efektu. NIKAD
// `useSearchParams` — pod `output: "export"` traži Suspense bailout.

import { useCallback, useEffect, useRef, useState } from 'react';

/** Ime custom event-a kojim se javlja promena query-ja bez remount-a strane. */
export const NAV_EVENT = 'servosync:nav';

/** Nosilac cilja kad URL JOŠ NIJE ažuran (klik na link/`router.push` u toku). */
export interface NavEventDetail {
  /** Pun href ka kome se navigira (sme da nosi query). */
  href?: string;
}

/**
 * Javi da se navigacija desila ili upravo dešava.
 *  • `href` zadat = navigacija je u toku (Link/`router.push`), URL još nije promenjen —
 *    potrošači čitaju query iz href-a, ali SAMO ako je pathname isti (ista strana ostaje
 *    montirana); za drugu rutu se strana remount-uje pa se čita posle navigacije.
 *  • bez `href` = URL je već ažuran (`history.replaceState` iz strane) — čita se `window.location`.
 */
export function emitNavEvent(href?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<NavEventDetail>(NAV_EVENT, { detail: href ? { href } : {} }));
}

/**
 * Query iz `detail.href` ako je isti pathname; `null` kad poruku treba ignorisati
 * (druga ruta — nju hvata remount/promena pathname-a), `undefined` kad detalja nema
 * (pozivalac tada čita `window.location.search`).
 *
 * Izvezeno jer isti kanal koristi i `useIdParam` (`?id=` na ruti detalja) — logika
 * „da li se ova poruka mene tiče" sme da postoji samo na jednom mestu.
 */
export function searchFromNavEvent(e: Event): string | null | undefined {
  const href = (e as CustomEvent<NavEventDetail>).detail?.href;
  if (!href) return undefined;
  try {
    const url = new URL(href, window.location.origin);
    return url.pathname === window.location.pathname ? url.search : null;
  } catch {
    return null; // neispravan href — ne diraj tekuće stanje
  }
}

export interface UseQueryTabOptions<T extends string> {
  /**
   * Dozvoljeni ključevi. Vrednost van skupa (ili prazna) pada na `defaultKey` — URL je
   * korisnički unos, ne sme da ubaci nepostojeći tab u stanje strane.
   */
  valid?: readonly T[] | ReadonlySet<string>;
  /**
   * Mapa starih (1.0) imena na tekuće ključeve — npr. `{ dashboard: 'pregled' }`. Stari
   * linkovi iz mejlova MORAJU da nastave da rade; upisuje se uvek kanonski ključ.
   */
  alias?: Record<string, string>;
  /**
   * Podrazumevani ključ se NE upisuje u URL nego se parametar briše (npr. `/montaza`
   * bez `?view=` = hub). Default `false`: parametar se uvek upisuje, pa je highlight
   * podstavke u sidebaru tačan i za prvi tab.
   */
  omitDefault?: boolean;
}

/**
 * Tab/pogled strane vezan za query parametar — `[tab, setTab]` (PLAN_NAV_PODMENIJI §4.3).
 *
 * Čita `?<key>=` na mount-u i osvežava se na `popstate` (nazad/napred) i na `servosync:nav`
 * (klik u sidebaru/paleti). `setTab` upisuje URL kroz `history.replaceState` (bez novog
 * unosa u istoriji — tab nije „stranica") i emituje isti event, pa sidebar highlight prati
 * klik unutar strane.
 *
 * @param key    ime query parametra (`'tab'`, `'view'`)
 * @param defaultKey  ključ kad parametra nema ili je neispravan
 */
export function useQueryTab<T extends string>(
  key: string,
  defaultKey: T,
  options?: UseQueryTabOptions<T>,
): [T, (next: T) => void] {
  const [tab, setTabState] = useState<T>(defaultKey);

  // Opcije se čitaju kroz ref: pozivaoci ih zadaju inline (nov objekat u svakom renderu),
  // pa bi u dep listi efekta stalno re-registrovale listenere.
  const optsRef = useRef(options);
  optsRef.current = options;

  const resolve = useCallback(
    (search: string): T => {
      const raw = new URLSearchParams(search).get(key);
      if (!raw) return defaultKey;
      const o = optsRef.current;
      const mapped = o?.alias?.[raw] ?? raw;
      if (!o?.valid) return mapped as T;
      const ok = o.valid instanceof Set ? o.valid.has(mapped) : (o.valid as readonly string[]).includes(mapped);
      return ok ? (mapped as T) : defaultKey;
    },
    [key, defaultKey],
  );

  useEffect(() => {
    // `setTabState` sa istom vrednošću React odbacuje (bail-out), pa višestruki izvori
    // istog signala (sopstveni `setTab` + event koji on emituje) ne prave dupli render.
    const apply = (search: string) => setTabState(resolve(search));
    apply(window.location.search);

    const onPop = () => apply(window.location.search);
    const onNav = (e: Event) => {
      const fromEvent = searchFromNavEvent(e);
      if (fromEvent === null) return; // druga ruta — ignoriši (strana se remount-uje)
      apply(fromEvent ?? window.location.search);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener(NAV_EVENT, onNav);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener(NAV_EVENT, onNav);
    };
  }, [resolve]);

  const setTab = useCallback(
    (next: T) => {
      setTabState(next);
      if (typeof window === 'undefined') return;
      const url = new URL(window.location.href);
      if (optsRef.current?.omitDefault && next === defaultKey) url.searchParams.delete(key);
      else url.searchParams.set(key, next);
      window.history.replaceState(null, '', url.toString());
      // URL je već ažuran → event bez detalja (potrošači čitaju `window.location`).
      emitNavEvent();
    },
    [key, defaultKey],
  );

  return [tab, setTab];
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Reads the document id from `?id=N` on a STATIC detail route.
 *
 * Zašto ne `[id]` segment: frontend je `output: "export"` (static export). Dinamički
 * segment bez `generateStaticParams` sa stvarnim id-jevima izveze SAMO placeholder fajl
 * (`_`), pa `/modul/12` na objavljenoj aplikaciji vraća 404 — backend mapira samo
 * `/put` → `/put.html` i nema SPA fallback. Zato detalj živi na statičkoj ruti
 * `/modul/detalj?id=N` (isti obrazac kao `/zahtevi/detalj`).
 *
 * Zašto ne `useSearchParams`: pod `output: "export"` bi tražio `<Suspense>` oko cele
 * stranice; čitanje iz `window.location` u efektu je jednostavnije i već ustaljeno.
 *
 * - `resolved` — false do prvog efekta. BEZ njega bi prvi render (pre efekta) uvek
 *   pokazao lažno „nije pronađen", jer je `id` još null.
 * - `popstate` — browser Nazad/Napred između dva dokumenta ISTE rute menja samo query,
 *   pa se komponenta ne remontira; bez slušaoca bi se URL promenio a sadržaj ne.
 * - `go(nextId)` — navigacija detalj → detalj (npr. prepis predračuna u račun).
 *   `router.push` NE okida `popstate`, zato state postavljamo i ručno.
 */
export function useIdParam(paramName = 'id'): {
  id: number | null;
  resolved: boolean;
  go: (nextId: number) => void;
} {
  const router = useRouter();
  const [id, setId] = useState<number | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    setId(readIdFromLocation(paramName));
    setResolved(true);
    const onPop = () => setId(readIdFromLocation(paramName));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [paramName]);

  const go = useCallback(
    (nextId: number) => {
      router.push(`${window.location.pathname}?${paramName}=${nextId}`);
      setId(nextId);
    },
    [router, paramName],
  );

  return { id, resolved, go };
}

/**
 * Ključ pod kojim se pamti POSLEDNJE stanje jedne radne liste (filteri, strana,
 * tab) — da povratak sa detalja vrati listu tačno kakva je bila.
 */
function listStateKey(listPath: string): string {
  return `listState:${listPath}`;
}

/**
 * Filteri / strana / tab radne liste, DRŽANI U URL-u.
 *
 * Zašto: detalj dokumenta je zasebna ruta, pa povratak na listu remontira
 * stranicu i čist `useState` filter se gubi. Knjigovođa koji kontroliše KUF od
 * 625 faktura je posle svake odštampane fakture ostajao bez oba filtera i bez
 * strane 7 — stotine klikova po jednom PDV periodu.
 *
 * - stanje se upisuje u URL preko `router.replace` (NE `push`): promena filtera
 *   ne sme da pravi novi unos u istoriji, inače „Nazad" prolazi kroz svaki
 *   filter koji je korisnik probao;
 * - isto stanje ide i u `sessionStorage`, odakle ga detalj čita za dugme
 *   „Nazad" (vidi `listHref`) — radi i posle osvežavanja i za deljen link;
 * - `popstate` se sluša da browser Nazad/Napred vrati i vrednosti filtera.
 */
export function useListQueryState<T extends Record<string, string>>(
  defaults: T,
): { values: T; resolved: boolean; setValues: (patch: Partial<T>) => void } {
  const router = useRouter();
  const [values, setState] = useState<T>(defaults);
  const [resolved, setResolved] = useState(false);
  // `defaults` je po pravilu inline objekat (nova referenca u svakom renderu) —
  // drži se u ref-u da efekti ne bi krenuli u petlju.
  const defaultsRef = useRef(defaults);

  const readFromLocation = useCallback((): T => {
    const q = new URLSearchParams(window.location.search);
    const next = { ...defaultsRef.current };
    for (const key of Object.keys(defaultsRef.current)) {
      const v = q.get(key);
      if (v != null) (next as Record<string, string>)[key] = v;
    }
    return next;
  }, []);

  useEffect(() => {
    const initial = readFromLocation();
    setState(initial);
    setResolved(true);
    const onPop = () => setState(readFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [readFromLocation]);

  const setValues = useCallback(
    (patch: Partial<T>) => {
      setState((prev) => {
        const next = { ...prev, ...patch };
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(next)) {
          // Podrazumevana vrednost se NE piše u URL — adresa ostaje čitljiva.
          if (v !== '' && v !== (defaultsRef.current as Record<string, string>)[k]) {
            q.set(k, v);
          }
        }
        const search = q.toString();
        const path = window.location.pathname;
        router.replace(search ? `${path}?${search}` : path);
        try {
          window.sessionStorage.setItem(listStateKey(path), search);
        } catch {
          // privatni režim / pun storage — povratak radi i bez pamćenja
        }
        return next;
      });
    },
    [router],
  );

  return { values, resolved, setValues };
}

/**
 * Adresa radne liste SA poslednjim filterima — za dugme „Nazad" na detalju.
 * Kad ničega nema u pamćenju (deljen link, novi tab), vraća čistu listu.
 */
export function listHref(listPath: string): string {
  if (typeof window === 'undefined') return listPath;
  try {
    const search = window.sessionStorage.getItem(listStateKey(listPath));
    return search ? `${listPath}?${search}` : listPath;
  } catch {
    return listPath;
  }
}

/** `?id=N` → pozitivan ceo broj; sve ostalo (fali, prazno, „abc", 0, −5) → null. */
function readIdFromLocation(paramName = 'id'): number | null {
  const raw = new URLSearchParams(window.location.search).get(paramName);
  if (raw == null || raw.trim() === '') return null;
  // SAMO dekadni zapis. `Number()` prima i „0x10" (=16), „1e3" (=1000) i „+5" —
  // prelomljen link iz mejla tako otvara TUĐI dokument umesto da javi grešku.
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

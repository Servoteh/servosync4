'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseIdParam } from './deep-link';
import { NAV_EVENT, emitNavEvent, searchFromNavEvent } from './use-query-tab';

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
 * stranice, a hook se zove IZNAD auth-gejta (`if (!user) return …`) — tamo bi se pri
 * `next build` stvarno izvršio i oborio build. Reaktivnost se zato dobija kroz kućni
 * kanal `servosync:nav` (isti koji koriste sidebar i paleta), ne kroz `useSearchParams`.
 *
 * - `resolved` — false do prvog efekta. BEZ njega bi prvi render (pre efekta) uvek
 *   pokazao lažno „nije pronađen", jer je `id` još null.
 * - `popstate` — browser Nazad/Napred između dva dokumenta ISTE rute menja samo query,
 *   pa se komponenta ne remontira; bez slušaoca bi se URL promenio a sadržaj ne.
 * - `servosync:nav` (C20) — detalj → detalj SA DRUGE komponente (npr. „Otvori drugu
 *   stranu" u panelu prenosa `/robno/detalj`). `router.push`/`<Link>` na ISTU rutu ne
 *   remount-uje stranu (Next namerno izostavlja query iz ključa za remount) i ne okida
 *   `popstate`, pa je adresa pokazivala drugi dokument a ekran stari — magacioner je posle
 *   storna prenosa gledao dokument koji misli da je nov. Pozivalac koji navigira na istu
 *   rutu MORA da emituje `emitNavEvent(href)` pre navigacije.
 * - `go(nextId)` — navigacija detalj → detalj iz same strane; emituje isti event, pa se
 *   usaglase i drugi čitaoci na ekranu.
 *
 * `?id=` na ruti detalja je TRAJNO stanje adrese (osvežavanje/bookmark moraju da pogode
 * isti dokument) — zato se ovde NIKAD ne „troši" (v. `consumeParam` u `deep-link.ts`,
 * koji je za jednokratne deep-linkove tipa `?open=`).
 *
 * ⚠️ CENA KOJU STRANA MORA DA PLATI: ovaj hook menja identitet zapisa U MESTU — komponenta
 * se NE remontira, pa svako stanje strane preživi promenu `?id=`. Pre nego što se hook uvede
 * na nov ekran, mora se proći kroz SVE što taj ekran drži: otvorene dijaloge (naročito one
 * bez `dismissable`), nacrte unosa, priloge, odabrane redove, `pending` prozore. Ili se veže
 * za identitet (`key={id}`, `docId` u samom stanju — v. `/robno/detalj`), ili se hook NE
 * uvodi. Ekran koji to ne izdrži upisuje polja jednog zapisa na drugi; zbog toga
 * `/zahtevi/detalj` NAMERNO ostaje na sopstvenom čitaču bez `popstate` (C20, 07.08.2026).
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
    const apply = (search: string) =>
      setId(parseIdParam(new URLSearchParams(search).get(paramName)));
    apply(window.location.search);
    setResolved(true);

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
  }, [paramName]);

  const go = useCallback(
    (nextId: number) => {
      const href = `${window.location.pathname}?${paramName}=${nextId}`;
      // URL još nije promenjen → cilj putuje u `detail.href` (isto kao klik u sidebaru).
      emitNavEvent(href);
      router.push(href);
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

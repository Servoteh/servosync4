'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  citajZapisPozicije,
  kljucPozicijeListe,
  odlukaOPoziciji,
  type ZapisPozicijeListe,
} from './povratak-na-listu';
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

/**
 * MESTO U LISTI SA BESKONAČNIM SKROLOM — pamti se preko odlaska na detalj.
 *
 * `useListQueryState` vraća FILTERE, ali ne i gde je korisnik stao: lager lista nadovezuje
 * strane po 200 redova, pa povratak sa detalja spušta magacionera na vrh spiska od 3.000
 * redova kroz koji je upravo skrolovao (prijava vlasnika 07.08.2026).
 *
 * 🔴 ZAŠTO `sessionStorage`, a NE URL:
 *   • `setValues` piše kroz `router.replace`, pa bi svaki događaj skrola pravio unos u
 *     istoriji pregledača;
 *   • adresa liste se po dizajnu šalje kolegi u poruci, a `?strane=15` bi kod primaoca
 *     okinuo 15 sekvencijalnih zahteva nad ogledalom.
 * Uz to `sessionStorage` radi i za dugme „Nazad" u aplikaciji i za Nazad pregledača, pa
 * oba daju isti rezultat — bez prelaska na `router.back()`, koji bi iz deljenog linka ili
 * novog taba izbacio korisnika IZ aplikacije.
 *
 * 🔴 NAJVIŠE JEDAN AUTOMATSKI ZAHTEV PRI MONTIRANJU. Kad keš više ne drži onoliko strana
 * koliko je bilo učitano, restauracija se NAPUŠTA (v. `odlukaOPoziciji`) i vraća se
 * `izgubljenoRedova` — ekran to kaže rečenicom umesto da vrti `fetchNextPage` u petlji.
 *
 * @param kljuc        putanja liste, npr. `/artikli/lager`
 * @param potpis       potpis tekućih filtera; njegova promena briše zapis i vraća skrol na vrh
 * @param spremno      `true` tek kad su redovi STVARNO u DOM-u (prvi render sa `redovi.length > 0`)
 * @param straneUKesu  koliko strana keš upita drži u ovom trenutku
 * @param redova       koliko je redova sada u tabeli (za poruku o ranije učitanom)
 */
export function useZapamcenaPozicijaListe({
  kljuc,
  potpis,
  spremno,
  straneUKesu,
  redova,
}: {
  kljuc: string;
  potpis: string;
  spremno: boolean;
  straneUKesu: number;
  redova: number;
}): {
  /** Zakači na `DataTable scrollRef` — okvir koji tabela stvarno skroluje. */
  okvirRef: (el: HTMLDivElement | null) => void;
  /** > 0 samo kad je restauracija NAPUŠTENA jer keš više ne drži toliko strana. */
  izgubljenoRedova: number;
} {
  const elRef = useRef<HTMLDivElement | null>(null);
  const odjaviRef = useRef<(() => void) | null>(null);
  const rafRef = useRef(0);

  /**
   * Zapis se čita JEDNOM, pri prvom renderu — pre nego što ga upis pregazi. `undefined`
   * znači „još nije čitano"; `null` je uredan odgovor „nema zapisa".
   */
  const zapamcenoRef = useRef<ZapisPozicijeListe | null | undefined>(undefined);
  if (zapamcenoRef.current === undefined) {
    let raw: string | null = null;
    // `typeof window` jer se ekran PRERENDERUJE pri statičkom izvozu (`/artikli/lager` je
    // u izlazu `next build`), a tamo `window` ne postoji. Čita se u renderu, a ne u
    // efektu, da bi zapis bio u ruci PRE nego što ga prvi upis pregazi.
    if (typeof window !== 'undefined') {
      try {
        raw = window.sessionStorage.getItem(kljucPozicijeListe(kljuc));
      } catch {
        // privatni režim / pun storage — lista radi i bez pamćenja
      }
    }
    zapamcenoRef.current = citajZapisPozicije(raw);
  }

  /** Restauracija se izvodi TAČNO JEDNOM; do tada se u pamćenje NIŠTA ne upisuje. */
  const resenoRef = useRef(false);
  const potpisRef = useRef(potpis);
  const [izgubljenoRedova, setIzgubljenoRedova] = useState(0);

  // Ogledalo tekućih vrednosti — čita ih slušalac skrola, koji se ne prevezuje po renderu.
  const stanjeRef = useRef({ potpis, straneUKesu, redova });
  stanjeRef.current = { potpis, straneUKesu, redova };

  const upisi = useCallback(() => {
    if (!resenoRef.current) return;
    const s = stanjeRef.current;
    if (s.straneUKesu <= 0) return;
    try {
      window.sessionStorage.setItem(
        kljucPozicijeListe(kljuc),
        JSON.stringify({
          potpis: s.potpis,
          strane: s.straneUKesu,
          redova: s.redova,
          skrol: elRef.current?.scrollTop ?? 0,
        } satisfies ZapisPozicijeListe),
      );
    } catch {
      // isto kao gore — pamćenje je udobnost, ne uslov
    }
  }, [kljuc]);

  /**
   * Callback ref, ne objektni: okvir se pojavljuje TEK kad ekran prođe kapiju prijave i
   * učitavanja, a običan `useEffect` sa praznim nizom bi do tada već odradio svoje i
   * slušalac skrola se nikad ne bi zakačio.
   */
  const [okvirPostoji, setOkvirPostoji] = useState(false);
  const okvirRef = useCallback(
    (el: HTMLDivElement | null) => {
      odjaviRef.current?.();
      odjaviRef.current = null;
      elRef.current = el;
      // Dolazak okvira mora da OKINE RENDER: restauracija čeka i redove i okvir, a ref
      // sam po sebi ne prijavljuje promenu. Bez ovoga bi ekran koji redove dobije iz keša
      // pre nego što prođe kapiju prijave „potrošio" jedinu priliku za vraćanje skrola.
      setOkvirPostoji(!!el);
      if (!el) return;
      let zakazano = 0;
      const onScroll = () => {
        // Skrol okida na svakih nekoliko piksela; upis se sabija na jedan po kadru.
        if (zakazano) return;
        zakazano = requestAnimationFrame(() => {
          zakazano = 0;
          upisi();
        });
      };
      el.addEventListener('scroll', onScroll, { passive: true });
      odjaviRef.current = () => {
        el.removeEventListener('scroll', onScroll);
        if (zakazano) cancelAnimationFrame(zakazano);
      };
    },
    [upisi],
  );

  // ── Restauracija: tek kad su redovi u DOM-u, kroz `requestAnimationFrame`, jednom.
  // Bez `spremno` bi se `scrollTop` postavljao na okvir bez sadržaja i pregledač bi ga
  // odsekao na 0; bez zastavice bi „Učitaj još" i klik na sort vraćali korisnika unazad.
  useEffect(() => {
    if (resenoRef.current || !spremno || !okvirPostoji) return;
    resenoRef.current = true;
    potpisRef.current = potpis;
    // `?? null` je samo za tip: do ovog efekta je zapis već pročitan pri prvom renderu.
    const odluka = odlukaOPoziciji(zapamcenoRef.current ?? null, potpis, straneUKesu);
    if (odluka.vrsta === 'odustani') {
      setIzgubljenoRedova(odluka.ranijeRedova);
    } else if (odluka.vrsta === 'vrati') {
      const { skrol } = odluka;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        if (elRef.current) elRef.current.scrollTop = skrol;
        upisi();
      });
      return;
    }
    upisi();
  }, [spremno, okvirPostoji, potpis, straneUKesu, upisi]);

  // ── Promena filtera = druga lista: zapis se briše, skrol ide na vrh.
  // Ne dira se pre prve restauracije — do tada `potpis` još putuje od podrazumevanog
  // ka onome iz adrese, pa bi ovo obrisalo baš ono što tek treba da se vrati.
  useEffect(() => {
    if (!resenoRef.current) return;
    if (potpisRef.current === potpis) return;
    potpisRef.current = potpis;
    setIzgubljenoRedova(0);
    try {
      window.sessionStorage.removeItem(kljucPozicijeListe(kljuc));
    } catch {
      // bez pamćenja i dalje radi
    }
    if (elRef.current) elRef.current.scrollTop = 0;
  }, [potpis, kljuc]);

  // ── Dovučena nova strana / promenjen broj redova — zapiši novo stanje.
  useEffect(() => {
    upisi();
  }, [straneUKesu, redova, potpis, upisi]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      odjaviRef.current?.();
    },
    [],
  );

  return { okvirRef, izgubljenoRedova };
}

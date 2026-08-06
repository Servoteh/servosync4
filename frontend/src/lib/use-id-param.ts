'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  citajZapisPozicije,
  kljucPozicijeListe,
  odlukaOPoziciji,
  type ZapisPozicijeListe,
} from './povratak-na-listu';

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

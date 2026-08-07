/**
 * POVRATAK NA LISTU — čista logika, bez React-a i bez `next/*`.
 *
 * Posle detalja dokumenta postavljaju se DVA odvojena pitanja, i oba su ovde:
 *
 *  1. NA KOJU listu se vraćam. Artikal ima DVA ravnopravna ulaza (pregled artikala i
 *     lager lista), pa „Nazad" ne sme da bude zakucan — povratak na tuđu listu, sa
 *     tuđim filterima, korisnik vidi kao „izbacilo me na početnu stranu"
 *     (prijava vlasnika 07.08.2026).
 *  2. NA KOJE MESTO u toj listi. Lista je beskonačan skrol, pa nije dovoljno vratiti
 *     putanju: mora i koliko je strana bilo učitano i gde je skrol stajao.
 *
 * Zašto zaseban fajl, a ne `use-id-param.ts` gde je `useListQueryState`: taj modul uvozi
 * `next/navigation`, pa se pod `node --test` (bez bundlera) ne može učitati — a ovo je
 * jedina logika koja se ovde da izmeriti testom. Zato su OVDE i `listHref`/`listStateKey`
 * (ne koriste `next/*`), pa `hrefIzvora` može da ih pozove bez povlačenja Next-a u čist
 * modul; `use-id-param.ts` ih re-eksportuje da zatečeni uvozi ostanu netaknuti. Hookovi
 * (`useListQueryState`, `useZapamcenaPozicijaListe`) ostaju tamo.
 */

// ───────────────────────────────── 0. ADRESA RADNE LISTE SA POSLEDNJIM FILTERIMA

/**
 * Ključ pod kojim se pamti POSLEDNJE stanje jedne radne liste (filteri, strana, tab) —
 * da povratak sa detalja vrati listu tačno kakva je bila.
 */
export function listStateKey(listPath: string): string {
  return `listState:${listPath}`;
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
 * Kanonski oblik stanja liste: samo ključevi koje ta lista POSEDUJE (`defaults`), bez
 * praznih i bez podrazumevanih vrednosti.
 *
 * 🔴 Nikad se ne piše sirov `window.location.search`: na ruti liste umeju da stoje i
 * tuđi, jednokratni parametri (deep-link `?open=`, `?izvor=`), a oni bi se kroz „Nazad"
 * vratili korisniku kao filteri — ili bi ponovo otvorili dijalog koji je već zatvorio.
 */
export function serijalizujStanjeListe(
  values: Record<string, string>,
  defaults: Record<string, string>,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, k)) continue;
    if (v !== '' && v !== defaults[k]) q.set(k, v);
  }
  return q.toString();
}

/**
 * Stanje za upis pri MONTIRANJU liste (i na `popstate`) — spoj sopstvenih ključeva sa
 * onima koje drži drugi pogled na istoj ruti.
 *
 * Zašto spajanje, a ne prost upis: jedna ruta ume da ima DVA pisca istog ključa —
 * `/glavna-knjiga` drži `tab` u roditelju, a filtere u detetu (`DnevnikView`). React
 * pušta efekte deteta PRE roditeljevih, pa bi roditeljev upis bez spajanja obrisao
 * filtere koje je dete upravo zapisalo.
 *
 * Zadržava se SAMO ključ koji (a) nije u sopstvenom `defaults` i (b) je i dalje u adresi —
 * time zapamćeno stanje ostaje verno ogledalo tekuće adrese: zastareli filter iz ranije
 * posete se ne vaskrsava, a tuđi parametar iz adrese se ne usvaja.
 */
export function spojiStanjeListe(
  postojeci: string | null,
  urlSearch: string,
  values: Record<string, string>,
  defaults: Record<string, string>,
): string {
  const q = new URLSearchParams(serijalizujStanjeListe(values, defaults));
  if (!postojeci) return q.toString();
  const uAdresi = new URLSearchParams(urlSearch);
  for (const k of new URLSearchParams(postojeci).keys()) {
    if (Object.prototype.hasOwnProperty.call(defaults, k)) continue; // ovaj pogled je vlasnik
    if (q.has(k)) continue;
    const v = uAdresi.get(k);
    if (v == null) continue; // više nije u adresi → ne vaskrsavaj
    q.set(k, v);
  }
  return q.toString();
}

// ─────────────────────────────────────────────── 1. ODAKLE SE DOŠLO (koja lista)

/**
 * Jedan ULAZ u ekran detalja — mesto sa kog se došlo i na koje „Nazad" mora da vrati.
 *
 * 🔴 `radnaLista: false` postoji zato što svaki ulaz NIJE lista: u detalj komitenta se
 * ulazi i iz kartice „Dupli PIB" u Podešavanjima (`/podesavanja?tab=integracije`). Za
 * takvu metu ne postoji zapis `listState:`, pa bi je `listHref` svukao na podrazumevani
 * tab („Korisnici") — administrator koji čisti spisak duplih PIB-ova bi posle svakog
 * komitenta morao ponovo: Podešavanja → tab Integracije → skrol do kartice.
 */
export interface UlazUDetalj {
  /** Putanja mesta sa kog se došlo. */
  putanja: string;
  /** `false` = meta nije radna lista sa `useListQueryState`, pa se NE ide kroz `listHref`. */
  radnaLista?: boolean;
  /** Fiksan query za metu koja nije radna lista (npr. `tab=integracije`). */
  query?: string;
}

/**
 * `?…&izvor=<ključ>` → ključ iz TABELE ULAZA tog modula; sve ostalo → podrazumevani.
 *
 * Nepoznata vrednost NAMERNO pada na podrazumevani ulaz umesto da baci grešku: adresa je
 * korisnički unos (deljen link, prelomljena poruka), a dugme „Nazad" sme da promaši
 * listu — ne sme da prestane da radi.
 *
 * 🔴 Provera je `hasOwnProperty`, ne `in`: `?izvor=constructor` bi kroz `in` prošao kao
 * validan ključ, pa bi `hrefIzvora` dobio funkciju iz prototipa umesto ulaza i dugme
 * „Nazad" bi puklo.
 *
 * Zašto tabela PO MODULU, a ne jedan globalan registar: podrazumevana vrednost mora biti
 * po modulu. Sa globalnim skupom bi `/komitenti/detalj?izvor=lager` „radio" i odveo
 * korisnika u lager listu artikala; ovako svaki detalj vidi samo svoje ulaze i svaka
 * promašena vrednost pada na SVOJU listu.
 */
export function citajIzvor<T extends string>(
  search: string,
  ulazi: Readonly<Record<T, UlazUDetalj>>,
  podrazumevani: T,
): T {
  const v = new URLSearchParams(search).get('izvor');
  if (v != null && Object.prototype.hasOwnProperty.call(ulazi, v)) return v as T;
  return podrazumevani;
}

/**
 * KONAČNA adresa za „Nazad": radnoj listi se dopisuju poslednji filteri (`listHref`),
 * ostalim ulazima njihov fiksan query.
 */
export function hrefIzvora(ulaz: UlazUDetalj): string {
  if (ulaz.radnaLista === false) {
    return ulaz.query ? `${ulaz.putanja}?${ulaz.query}` : ulaz.putanja;
  }
  return listHref(ulaz.putanja);
}

/**
 * Ulazi u karticu i detalj ARTIKLA. Podrazumevani (`artikli`) se NE upisuje u adresu —
 * deljen link ostaje čitljiv, a izostavljena vrednost pada baš na njega.
 */
export const ULAZI_ARTIKAL = {
  artikli: { putanja: '/artikli' },
  lager: { putanja: '/artikli/lager' },
} satisfies Record<string, UlazUDetalj>;

export type IzvorArtikla = keyof typeof ULAZI_ARTIKAL;

/**
 * Ulazi u detalj ROBNOG DOKUMENTA.
 *
 * Scenario koji je ovo tražio: zaključen popis → dugme „Višak (dokument #N)" → „Nazad"
 * je vodio u listu robnih dokumenata, a magacioner je došao iz popisa i tamo mu je i
 * ostatak posla (dokument manjka, razlike).
 */
export const ULAZI_ROBNI_DOKUMENT = {
  robno: { putanja: '/robno' },
  popis: { putanja: '/robno/popis' },
} satisfies Record<string, UlazUDetalj>;

export type IzvorRobnogDokumenta = keyof typeof ULAZI_ROBNI_DOKUMENT;

/**
 * Ulazi u detalj KOMITENTA — jedini modul u kome drugi ulaz NIJE radna lista.
 *
 * Kartica „Dupli PIB kod komitenata" (Podešavanja → Integracije, O-7 spisak od
 * 30.07.2026) je tab, a ne lista sa `useListQueryState`: za nju ne postoji zapis
 * `listState:/podesavanja`, pa bi `listHref` vratio go `/podesavanja` i izbacio
 * administratora na podrazumevani tab „Korisnici". Zato `radnaLista: false` + fiksan
 * `query`; `useQueryTab` taj `?tab=` čita pri montiranju.
 */
export const ULAZI_KOMITENT = {
  komitenti: { putanja: '/komitenti' },
  podesavanja: { putanja: '/podesavanja', radnaLista: false, query: 'tab=integracije' },
} satisfies Record<string, UlazUDetalj>;

export type IzvorKomitenta = keyof typeof ULAZI_KOMITENT;

// ────────────────────────────────────────────── 2. GDE SE STALO (mesto u listi)

/** Zapamćeno mesto u jednoj radnoj listi. */
export interface ZapisPozicijeListe {
  /**
   * Potpis filtera pod kojim je mesto zapamćeno. Restauracija se izvodi SAMO uz isti
   * potpis: posle promene filtera je to druga lista, pa bi vraćen skrol korisnika
   * spustio nasred spiska koji nikad nije video.
   */
  potpis: string;
  /** Koliko je strana beskonačnog skrola bilo učitano. */
  strane: number;
  /** Koliko je redova bilo u tabeli — za poruku „ranije učitano N redova". */
  redova: number;
  /** `scrollTop` skrol-okvira tabele (tabela skroluje sopstveni okvir, ne prozor). */
  skrol: number;
}

/** Ključ pod kojim jedna lista pamti svoje mesto (odvojen od ključa filtera). */
export function kljucPozicijeListe(listPath: string): string {
  return `listPos:${listPath}`;
}

/** Ceo, konačan, ne-negativan broj — sve ostalo (NaN, ∞, string, minus) je smeće. */
function jeBroj(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * `sessionStorage` → zapis, uz punu proveru oblika. Sve što ne valja daje `null`:
 * pamćenje pozicije je udobnost, pa prelomljen zapis (druga verzija aplikacije, ručno
 * dirano) sme samo da je izgubi — nikad da obori ekran.
 */
export function citajZapisPozicije(raw: string | null | undefined): ZapisPozicijeListe | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const z = o as Record<string, unknown>;
  if (typeof z.potpis !== 'string') return null;
  if (!jeBroj(z.strane) || !jeBroj(z.redova) || !jeBroj(z.skrol)) return null;
  // Strana 0 znači „ništa nije bilo učitano" — nema se čemu vratiti.
  if (z.strane < 1) return null;
  return { potpis: z.potpis, strane: z.strane, redova: z.redova, skrol: z.skrol };
}

/**
 * Šta uraditi sa zapamćenim mestom pri montiranju liste.
 *
 * `odustani` NIJE greška nego svesna granica: kad keš više ne drži onoliko strana
 * koliko je bilo učitano (istekao `gcTime`, drugi tab), povratak na 15. stranu bi
 * tražio 15 uzastopnih zahteva nad ogledalom. Umesto toga se prikazuje prva strana i
 * kaže koliko je ranije bilo učitano, pa korisnik sam odluči.
 */
export type OdlukaOPoziciji =
  | { vrsta: 'nista' }
  | { vrsta: 'vrati'; skrol: number }
  | { vrsta: 'odustani'; ranijeRedova: number };

/**
 * @param zapis        zapamćeno mesto (ili `null` kad ga nema)
 * @param potpis       potpis filtera koji je SADA na ekranu
 * @param straneUKesu  koliko strana keš upita stvarno drži u ovom trenutku
 */
export function odlukaOPoziciji(
  zapis: ZapisPozicijeListe | null,
  potpis: string,
  straneUKesu: number,
): OdlukaOPoziciji {
  if (!zapis) return { vrsta: 'nista' };
  // Drugi filter = druga lista. Zapis se ne koristi ni delimično.
  if (zapis.potpis !== potpis) return { vrsta: 'nista' };
  // Keš ne drži sve što je bilo učitano — NE dovlačimo strane u petlji.
  if (zapis.strane > straneUKesu) return { vrsta: 'odustani', ranijeRedova: zapis.redova };
  // Skrol na vrhu je isto što i ništa; nema razloga dirati okvir.
  if (zapis.skrol <= 0) return { vrsta: 'nista' };
  return { vrsta: 'vrati', skrol: zapis.skrol };
}

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
 * Zašto zaseban fajl, a ne `use-id-param.ts` gde su `useListQueryState`/`listHref`:
 * taj modul uvozi `next/navigation`, pa se pod `node --test` (bez bundlera) ne može
 * učitati — a ovo je jedina logika koja se ovde da izmeriti testom. Hook koji je
 * koristi (`useZapamcenaPozicijaListe`) ostaje uz ostale, u `use-id-param.ts`.
 */

// ─────────────────────────────────────────────── 1. ODAKLE SE DOŠLO (koja lista)

/** Lista sa koje je otvoren detalj/kartica artikla. */
export type IzvorListeArtikala = 'artikli' | 'lager';

const PUTANJE_LISTE_ARTIKALA: Record<IzvorListeArtikala, string> = {
  artikli: '/artikli',
  lager: '/artikli/lager',
};

/**
 * `?…&izvor=lager` → `'lager'`; sve ostalo → `'artikli'`.
 *
 * Nepoznata vrednost NAMERNO pada na pregled artikala umesto da baci grešku: adresa je
 * korisnički unos (deljen link, prelomljena poruka), a dugme „Nazad" sme da promaši
 * listu — ne sme da prestane da radi.
 */
export function citajIzvorListeArtikala(search: string): IzvorListeArtikala {
  const v = new URLSearchParams(search).get('izvor');
  return v === 'lager' ? 'lager' : 'artikli';
}

/**
 * Putanja liste iz koje se došlo, BEZ filtera — filtere dopisuje `listHref`
 * (`use-id-param.ts`), koji ih čita iz `sessionStorage`.
 */
export function putanjaListeArtikala(izvor: IzvorListeArtikala): string {
  return PUTANJE_LISTE_ARTIKALA[izvor];
}

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

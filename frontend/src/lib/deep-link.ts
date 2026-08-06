'use client';

// Deep-link parametri u adresi — deljena logika, bez React-a i bez DOM-a gde god je moguće
// (pa je testabilna golim `node --test`).
//
// Dve vrste query parametara u aplikaciji se NE smeju mešati:
//
//  • TRAJNO STANJE adrese — `?tab=`, `?view=`, `?id=` na ruti detalja, filteri liste.
//    Mora da PREŽIVI osvežavanje, bookmark i deljen link; nikad se ne „troši".
//  • JEDNOKRATAN DEEP-LINK — `?open=`, `?id=` na listi/tabu (zvonce, mejl, QR).
//    Odradi svoje jednom pa se skida sa adrese (`consumeParam`), inače se isti zapis
//    ponovo otvara pri SVAKOM kasnijem remount-u (Nazad, F5, PWA reload, povratak u tab).
//
// Ovo je drugi uzrok buga 077/26 („Otkucaj TP otvara neki već otkucan nalog") i C20
// („klik na obaveštenje iz zvonca ne radi na pola ekrana").

/** Opcije za `parseIdParam`. */
export interface ParseIdOptions {
  /** Dozvoli 0 kao ispravan id (komitent 0 = Servoteh d.o.o., interni). Podrazumevano ne. */
  allowZero?: boolean;
}

/**
 * `?id=N` → pozitivan ceo broj; sve ostalo → `null`.
 *
 * SAMO dekadni zapis. Goli `Number()` prima i „0x10" (=16), „1e3" (=1000), „+5" i „ 7 ",
 * pa prelomljen link iz mejla otvara TUĐI dokument umesto da bude odbijen. Zapis duži od
 * `Number.MAX_SAFE_INTEGER` takođe pada (inače bi „99999999999999999999" postao 1e20 i
 * otišao u API kao broj koji nikad nije postojao).
 */
export function parseIdParam(
  raw: string | null | undefined,
  options?: ParseIdOptions,
): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return null;
  if (n > 0) return n;
  return options?.allowZero && n === 0 ? 0 : null;
}

/**
 * Href bez datog parametra, ili `null` kad parametra nema (nema šta da se menja —
 * pozivalac tada preskače `replaceState` i ne dira istoriju bez potrebe).
 */
export function hrefWithoutParam(href: string, name: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null; // neispravan href — ne diraj adresu
  }
  if (!url.searchParams.has(name)) return null;
  url.searchParams.delete(name);
  return url.toString();
}

/**
 * „Potroši" jednokratan deep-link parametar: skini ga sa TEKUĆEG unosa istorije.
 *
 * `replaceState` (ne `pushState`): Nazad ne sme da vrati parametar, inače auto-otvaranje
 * prestaje da bude jednokratno. Uzgred rešava i ponovni klik na ISTI zapis — parametar ide
 * „X" → nema ga → „X", pa čitač ponovo okine.
 */
export function consumeParam(name: string): void {
  if (typeof window === 'undefined') return;
  const next = hrefWithoutParam(window.location.href, name);
  if (next == null) return;
  window.history.replaceState(null, '', next);
}

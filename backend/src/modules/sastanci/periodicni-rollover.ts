import { plusDana } from "./weekly-rollover";

/**
 * Sledeći termin PERIODIČNOG sastanka — čista fn, ogledalo iste filozofije kao
 * `weekly-rollover.ts` (zahtev 024/26, predlog d1 potvrđen 28.07.2026).
 *
 * PRAVILO: sledeći termin = `datum + intervalDays`, uz dva popravna koraka:
 *   1. CATCH-UP: ako je tako dobijen termin već PROŠAO (serija je stajala —
 *      npr. sastanak zatvoren sa mesec dana zakašnjenja), interval se dodaje
 *      dok termin ne stigne u danas-ili-kasnije. Tako serija ne „ispaljuje"
 *      gomilu zaostalih termina, nego nastavlja od prvog smislenog.
 *   2. PRAZNIK: neradni praznik (kadr_holidays.is_workday=false) pomera termin
 *      NAPRED na prvi dan koji nije praznik (paritet `sast_adjust_for_holiday`;
 *      vikend se NE preskače namerno — interval 7/14 čuva dan u nedelji, a za
 *      ostale intervale dan bira čovek pri zakazivanju).
 *
 * Koriste je scheduler automatika (`sastanci-periodicni.service.ts` — stvarno
 * kreiranje termina) i lista sastanaka (najava „Sledeći" dok automatika još
 * nije napravila red) — ISTO pravilo na oba mesta, da najava ne laže.
 */
export interface SledeciPeriodicniUlaz {
  /** Datum poslednjeg termina serije ('YYYY-MM-DD'). */
  datum: string;
  /** Broj dana između dva termina (1..365 — brani DB CHECK + DTO). */
  intervalDays: number;
  /** Danas u Europe/Belgrade ('YYYY-MM-DD'). */
  danas: string;
  /** Neradni praznici ('YYYY-MM-DD'). */
  praznici: string[];
}

/** Najviše pomeranja za praznik — brana od beskonačne petlje na lošim podacima. */
const MAX_PRAZNIK_KORAKA = 14;

export function sledeciPeriodicniTermin(u: SledeciPeriodicniUlaz): string {
  const interval = Math.max(1, Math.floor(u.intervalDays));
  let termin = plusDana(u.datum, interval);
  // Catch-up: granica 1000 koraka je čisto osiguranje (interval>=1 garantuje kraj).
  for (let i = 0; termin < u.danas && i < 1000; i++) {
    termin = plusDana(termin, interval);
  }
  const praznici = new Set(u.praznici);
  for (let i = 0; i < MAX_PRAZNIK_KORAKA && praznici.has(termin); i++) {
    termin = plusDana(termin, 1);
  }
  return termin;
}

/**
 * Naslov novog termina serije: osnova starog naslova + novi datum, po obrascu
 * sedmične automatike (`Sedmični sastanak — 03.08.2026.`). Ako stari naslov već
 * završava datumom („… — 20.07.2026." / „… - 20.7.2026"), taj rep se skida da
 * se datumi ne bi nizali jedan za drugim.
 */
export function periodicniNaslov(stariNaslov: string, noviDatum: string): string {
  const osnova = stariNaslov
    .replace(/\s*[—–-]\s*\d{1,2}\.\d{1,2}\.\d{4}\.?\s*$/u, "")
    .trim();
  const [y, m, d] = noviDatum.split("-");
  return `${osnova || "Periodični sastanak"} — ${d}.${m}.${y}.`;
}

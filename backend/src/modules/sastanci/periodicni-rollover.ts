import { Prisma } from "@prisma-sy15/client";
import { plusDana } from "./weekly-rollover";

/**
 * Sledeći termin PERIODIČNOG sastanka — čista fn, ogledalo iste filozofije kao
 * `weekly-rollover.ts` (zahtev 024/26, predlog d1 potvrđen 28.07.2026).
 *
 * PRAVILO: sledeći termin = `BAZNI datum + intervalDays`, uz popravke:
 *   1. CATCH-UP: ako je tako dobijen termin već PROŠAO (serija je stajala —
 *      npr. sastanak zatvoren sa mesec dana zakašnjenja), interval se dodaje
 *      dok termin ne stigne u danas-ili-kasnije. Korak je uvek PUN interval,
 *      pa catch-up ne kvari ritam (ostaje na rešetki baza + k·interval).
 *   2. PRAZNIK: neradni praznik (kadr_holidays.is_workday=false) pomera termin
 *      NAPRED na prvi dan koji nije praznik (paritet `sast_adjust_for_holiday`;
 *      vikend se NE preskače namerno — interval 7/14 čuva dan u nedelji, a za
 *      ostale intervale dan bira čovek pri zakazivanju).
 *
 * ⚠️ ULAZNI `datum` MORA biti BAZNI (nepomeren) datum repa serije, ne upisani
 * `sastanci.datum` (review 024/26, MAJOR-2): pomeranje za praznik je popravka
 * JEDNOG termina i NE sme da uđe u ritam — inače bi serija „petkom" posle
 * jednog praznika trajno prešla na subotu. Bazni datum se izvodi unazad kroz
 * lanac `prethodni_sastanak_id` (v. `bazaLancaUpit`), a pomeranje se primenjuje
 * TEK na izračunati sledeći termin. `posle` čuva da naslednik pomerenog repa ne
 * padne pre samog repa.
 *
 * Koriste je scheduler automatika (`sastanci-periodicni.service.ts` — stvarno
 * kreiranje termina) i lista sastanaka (najava „Sledeći" dok automatika još
 * nije napravila red) — ISTO pravilo na oba mesta, da najava ne laže.
 */
export interface SledeciPeriodicniUlaz {
  /** BAZNI datum repa serije ('YYYY-MM-DD') — nepomeren ritam; v. `bazaLancaUpit`. */
  datum: string;
  /** Broj dana između dva termina (1..365 — brani DB CHECK + DTO). */
  intervalDays: number;
  /** Danas u Europe/Belgrade ('YYYY-MM-DD'). */
  danas: string;
  /** Neradni praznici ('YYYY-MM-DD'). */
  praznici: string[];
  /** Termin mora pasti STROGO POSLE ovog datuma (UPISANI datum repa) — rep
   *  pomeren za praznik ne sme dobiti naslednika pre sebe. */
  posle?: string;
}

/** Najviše pomeranja za praznik — brana od beskonačne petlje na lošim podacima. */
const MAX_PRAZNIK_KORAKA = 14;

export function sledeciPeriodicniTermin(u: SledeciPeriodicniUlaz): string {
  const interval = Math.max(1, Math.floor(u.intervalDays));
  let termin = plusDana(u.datum, interval);
  // Catch-up po PUNIM intervalima (čuva ritam); 1000 je čisto osiguranje.
  for (
    let i = 0;
    (termin < u.danas || (u.posle !== undefined && termin <= u.posle)) &&
    i < 1000;
    i++
  ) {
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

/**
 * BAZNI (nepomeren) ritam za date sastanke, izveden UNAZAD kroz lanac
 * `prethodni_sastanak_id` (MAJOR-2): koren lanca (bez prethodnika) je sidro
 * ritma — njegov datum je izabrao čovek; svaki naslednik je na
 * `baza(roditelja) + interval(roditelja)`. Upisani `datum` naslednika se NE
 * koristi (može biti pomeren za praznik) — zato serija posle praznika sama
 * „legne" nazad na svoj dan. Catch-up preskoci automatike rešetki ne smetaju:
 * izvedena baza je najviše RANIJA od stvarne, na ISTOJ rešetki, a
 * `sledeciPeriodicniTermin` je catch-up petljom dovede do prvog smislenog
 * termina (`danas`/`posle`).
 *
 * Vraća po red za id iz `ids` (id::text, baza::text, interval_days). Id koji
 * nije dohvatljiv iz korena (prekinut lanac) izostaje — pozivalac pada na
 * upisani datum. Dubina 400 = brana (dnevna serija ~godinu dana i po).
 * Koriste ga lista („Sledeći" najava) i scheduler automatika — ISTI upit.
 */
export function bazaLancaUpit(ids: string[]): Prisma.Sql {
  return Prisma.sql`WITH RECURSIVE lanac AS (
      SELECT s.id, s.datum::date AS baza, s.interval_days, 0 AS dubina
      FROM sastanci s
      WHERE s.prethodni_sastanak_id IS NULL AND s.interval_days IS NOT NULL
      UNION ALL
      SELECT s.id,
             (l.baza + COALESCE(l.interval_days, s.interval_days))::date,
             s.interval_days,
             l.dubina + 1
      FROM sastanci s
      JOIN lanac l ON s.prethodni_sastanak_id = l.id
      WHERE l.dubina < 400
    )
    SELECT id::text AS id, baza::text AS baza, interval_days
    FROM lanac WHERE id = ANY(${ids}::uuid[])`;
}

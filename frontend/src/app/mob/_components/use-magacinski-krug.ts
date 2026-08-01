'use client';

import { usePosition } from '@/api/moj-profil';

/**
 * Ko dobija „magacinsku" početnu `/mob` — PLAN_MOB_IZGLED_1.0_PARITET, F2.
 *
 * ODLUKA NENADA (01.08.2026): ekran dobijaju Duško + magacin (9 ljudi), vezano
 * **po sistematizaciji, a NE po roli** — da nov čovek na tom radnom mestu dobije
 * ekran automatski, bez ijedne ručne dodele.
 *
 * Zašto ne rola i ne permisija (nalaz iz plana §4): rola `magacioner` postoji, ali
 * „vozač"/„logistika" kao role NE postoje, pa bi pola ekipe ostalo bez ekrana; a
 * prava `lokacije.read/move` ima NAMERNO svako u firmi, pa ona ne razlikuju
 * magacinsku ekipu ni od koga. Radno mesto je jedini podatak koji to zna.
 *
 * ⚠️ Ovo bira SAMO RASPORED početnog ekrana. Pristup ekranima i dalje presuđuju
 * permisije (`mob-modules.ts` / backend guard) — magacinska početna ne otvara
 * nijedna vrata koja opšti hub ne otvara.
 */

/**
 * Pod-odeljenje 22 = „Magacin i logistika" (provereno u bazi 01.08.2026).
 * Obuhvata pozicije: 54 Tim lider–magacin · 55 Magacioner · 56 Viljuškarista ·
 * 57 Vozač · 58 Referent voznog parka.
 */
export const MAGACIN_SUB_DEPT = 22;

/**
 * Pozicija 51 = „Menadžer operativne infrastrukture i logistike" (Duško Kostić) —
 * vodi Sektor logistike i nabavke, ali sedi u pod-odeljenju 20, pa ga uslov iznad
 * ne hvata i mora se navesti posebno.
 */
export const LOGISTIKA_MENADZER_POS = 51;

export interface MagacinskiKrug {
  /** Korisnik je na magacinskom radnom mestu → magacinski raspored početne. */
  isMagacin: boolean;
  /** Radno mesto se još učitava — pozivalac dotle crta OPŠTI raspored (bez treperenja). */
  isLoading: boolean;
}

/**
 * Izvor podatka je POSTOJEĆI `GET /v1/profile/position` (`usePosition`) — bez
 * ijedne backend izmene i bez nove rute. Isti hook koristi i „Moj profil", pa je
 * odgovor obično već u TanStack Query kešu.
 *
 * Ako se sistematizacija promeni, menja se samo konstanta iznad — ne i ovaj kod.
 */
export function useMagacinskiKrug(): MagacinskiKrug {
  const { data, isLoading, isError } = usePosition();
  const position = data?.data ?? null;

  // Greška ili zaposleni bez pozicije → NIJE magacin. Opšti hub je bezbedan
  // default (nosi SVE module), dok bi lažno pozitivan magacinski ekran čoveku
  // sakrio ostatak aplikacije iza „Svi moduli".
  const isMagacin =
    !isError &&
    position != null &&
    (position.subDepartmentId === MAGACIN_SUB_DEPT || position.id === LOGISTIKA_MENADZER_POS);

  return { isMagacin, isLoading };
}

// grid-payroll.ts — čisti obračun sati za Mesečni grid (Σ isplata red + karnet blok).
// Veran TS port 1.0 `src/services/payrollCalc.js` (pure fns) + `gridPayrollSum.js`.
// Bez I/O: prima eksplicitne ulaze, vraća eksplicitne izlaze (kao 1.0 SSOT).
//
// Napomena: BE izlaže `GET /v1/kadrovska/grid/payable` sa istim agregatom za
// SNIMLJENE vrednosti; ovaj port se koristi za ŽIVI (dirty-merged) prikaz Σ
// isplata i karnet blok, da neizmenjene ćelije + lokalne izmene budu tačne.

import { parseDateLocal } from './grid-utils';

export const REGULAR_DAY_HOURS = 8;
export const BOLOVANJE_OBICNO_FACTOR = 0.65;
export const BOLOVANJE_PUNO_FACTOR = 1.0;
export const VALID_WORK_TYPES = ['ugovor', 'praksa', 'dualno', 'penzioner'];

const FULL_RIGHTS_WORK_TYPES = new Set(['ugovor']);
const PAID_FREE_DAY_CODES = new Set(['sl', 'sv', 'pl']);

const NUM = (v: unknown): number => (v == null || isNaN(Number(v)) ? 0 : Number(v));
function round2(v: number): number {
  if (v == null || isNaN(v)) return 0;
  return Math.round(Number(v) * 100) / 100;
}
function normAbsCode(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  return s || null;
}

export interface HoursAgg {
  redovanRadSati: number;
  prekovremeniSati: number;
  praznikRadSati: number;
  praznikPlaceniSati: number;
  godisnjiSati: number;
  slobodniDaniSati: number;
  bolovanje65Sati: number;
  bolovanje100Sati: number;
  dveMasineSati: number;
  neplacenoDays: number;
}

/** Red sati za jedan dan (dirty-merged effective row ili sy15 WorkHours). */
export interface RowLike {
  hours?: number | string | null;
  overtimeHours?: number | string | null;
  overtime_hours?: number | string | null;
  twoMachineHours?: number | string | null;
  two_machine_hours?: number | string | null;
  fieldHours?: number | string | null;
  absenceCode?: string | null;
  absence_code?: string | null;
  absenceSubtype?: string | null;
  absence_subtype?: string | null;
}

export interface HolidayOpts {
  workType?: string | null;
  hireDate?: string | null;
}

function isAutoPaidHolidayEligible(ymd: string, opts?: HolidayOpts | null): boolean {
  const o = opts || {};
  if (o.workType && o.workType !== 'ugovor') return false;
  if (o.hireDate && ymd < o.hireDate) return false;
  return true;
}

/** Agregira work_hours mesec u HoursAgg (za obračun/karnet). Veran port. */
export function aggregateWorkHoursForMonth(
  year: number,
  month: number,
  rowsByYmd: Map<string, RowLike> | Record<string, RowLike>,
  holidayYmdSet: Set<string> | string[],
  opts?: HolidayOpts | null,
): HoursAgg {
  const hol = holidayYmdSet instanceof Set ? holidayYmdSet : new Set(Array.isArray(holidayYmdSet) ? holidayYmdSet : []);
  const last = new Date(year, month, 0).getDate();
  const out: HoursAgg = {
    redovanRadSati: 0,
    prekovremeniSati: 0,
    praznikRadSati: 0,
    praznikPlaceniSati: 0,
    godisnjiSati: 0,
    slobodniDaniSati: 0,
    bolovanje65Sati: 0,
    bolovanje100Sati: 0,
    dveMasineSati: 0,
    neplacenoDays: 0,
  };
  const get = (ymd: string): RowLike | null =>
    (rowsByYmd instanceof Map ? rowsByYmd.get(ymd) : rowsByYmd?.[ymd]) || null;

  for (let day = 1; day <= last; day++) {
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const ymd = `${year}-${mm}-${dd}`;
    const r = get(ymd);
    const h = r ? NUM(r.hours) : 0;
    const ot = r ? NUM(r.overtimeHours ?? r.overtime_hours) : 0;
    const tm = r ? NUM(r.twoMachineHours ?? r.two_machine_hours) : 0;
    const abs = normAbsCode(r?.absenceCode ?? r?.absence_code);
    const sub = normAbsCode(r?.absenceSubtype ?? r?.absence_subtype);

    out.prekovremeniSati += ot;
    out.dveMasineSati += tm;

    const dt = parseDateLocal(ymd);
    const dow = dt ? dt.getDay() : new Date(year, month - 1, day).getDay();
    const weekend = dow === 0 || dow === 6;
    const isHol = hol.has(ymd);

    if (weekend) {
      if (!abs && h > 0) {
        out.redovanRadSati += h;
        continue;
      }
      if (isHol && h > 0) {
        out.praznikRadSati += h;
        continue;
      }
      if (abs === 'go') out.godisnjiSati += REGULAR_DAY_HOURS;
      else if (abs === 'bo') {
        if (sub === 'povreda_na_radu' || sub === 'odrzavanje_trudnoce') out.bolovanje100Sati += REGULAR_DAY_HOURS;
        else out.bolovanje65Sati += REGULAR_DAY_HOURS;
      } else if (abs === 'sp') out.praznikPlaceniSati += REGULAR_DAY_HOURS;
      else if (abs && PAID_FREE_DAY_CODES.has(abs)) out.slobodniDaniSati += REGULAR_DAY_HOURS;
      continue;
    }

    if (isHol) {
      if (h > 0) {
        out.praznikRadSati += h;
        continue;
      }
      if (abs === 'go') out.godisnjiSati += REGULAR_DAY_HOURS;
      else if (abs === 'bo') {
        if (sub === 'povreda_na_radu' || sub === 'odrzavanje_trudnoce') out.bolovanje100Sati += REGULAR_DAY_HOURS;
        else out.bolovanje65Sati += REGULAR_DAY_HOURS;
      } else if (abs === 'sp') out.praznikPlaceniSati += REGULAR_DAY_HOURS;
      else if (abs && PAID_FREE_DAY_CODES.has(abs)) out.slobodniDaniSati += REGULAR_DAY_HOURS;
      else if (abs === 'np' || abs === 'pr' || abs === 'nop') {
        /* ne plaća se */
      } else if (isAutoPaidHolidayEligible(ymd, opts)) {
        out.praznikPlaceniSati += REGULAR_DAY_HOURS;
      }
      continue;
    }

    // Običan radni dan
    if (abs === 'go') out.godisnjiSati += REGULAR_DAY_HOURS;
    else if (abs === 'bo') {
      if (sub === 'povreda_na_radu' || sub === 'odrzavanje_trudnoce') out.bolovanje100Sati += REGULAR_DAY_HOURS;
      else out.bolovanje65Sati += REGULAR_DAY_HOURS;
    } else if (abs === 'sp') out.praznikPlaceniSati += REGULAR_DAY_HOURS;
    else if (abs && PAID_FREE_DAY_CODES.has(abs)) out.slobodniDaniSati += REGULAR_DAY_HOURS;
    else if (abs === 'np' || abs === 'pr' || abs === 'nop') out.neplacenoDays += 1;
    else out.redovanRadSati += h;
  }

  return out;
}

/** Nuluje plaćena odsustva za tipove rada bez punih prava. Veran port. */
export function sanitizeHoursForWorkType(hours: HoursAgg, workType: string): HoursAgg {
  const safe = { ...hours };
  const hasRights = FULL_RIGHTS_WORK_TYPES.has(workType);
  if (!hasRights) {
    safe.godisnjiSati = 0;
    safe.slobodniDaniSati = 0;
    safe.praznikPlaceniSati = 0;
    safe.bolovanje65Sati = 0;
    safe.bolovanje100Sati = 0;
  }
  return safe;
}

/** Payable hours (težinski) — 'satnica'/'dva_dela'/'praksa' = weighted_full. */
export function computePayableHours(hours: HoursAgg, model: string): number {
  const h = {
    redovanRadSati: NUM(hours.redovanRadSati),
    prekovremeniSati: NUM(hours.prekovremeniSati),
    praznikRadSati: NUM(hours.praznikRadSati),
    dveMasineSati: NUM(hours.dveMasineSati),
    praznikPlaceniSati: NUM(hours.praznikPlaceniSati),
    godisnjiSati: NUM(hours.godisnjiSati),
    slobodniDaniSati: NUM(hours.slobodniDaniSati),
    bolovanje100Sati: NUM(hours.bolovanje100Sati),
    bolovanje65Sati: NUM(hours.bolovanje65Sati),
  };
  let payable: number;
  if (model === 'fiksno' || model === 'jednokratno') {
    payable = h.prekovremeniSati + h.praznikRadSati + h.dveMasineSati;
  } else {
    payable =
      h.redovanRadSati +
      h.prekovremeniSati +
      h.praznikRadSati +
      h.dveMasineSati +
      h.praznikPlaceniSati +
      h.godisnjiSati +
      h.slobodniDaniSati +
      h.bolovanje100Sati * BOLOVANJE_PUNO_FACTOR +
      h.bolovanje65Sati * BOLOVANJE_OBICNO_FACTOR;
  }
  return round2(payable);
}

/** Σ isplata za jednog zaposlenog u mesecu (payrollCalc agregat, 'satnica'). */
export function gridPayableHoursForEmployee(
  year: number,
  month: number,
  rowsByYmd: Map<string, RowLike>,
  holidaySet: Set<string>,
  workType?: string | null,
  hireDate?: string | null,
): number {
  const agg = aggregateWorkHoursForMonth(year, month, rowsByYmd, holidaySet, { workType, hireDate });
  const sanitized = sanitizeHoursForWorkType(agg, workType || 'ugovor');
  return computePayableHours(sanitized, 'satnica');
}

/**
 * Doprinos jednog dana zbiru „Redovni” reda (prikazni: GO/BO/plaćeno = 8h).
 * Automatski državni praznik (bez unosa) samo ako je dan eligibilan.
 */
export function gridRedovniUnitsOneDay(
  ymd: string,
  row: RowLike | null | undefined,
  holidayYmdSet: Set<string>,
  opts?: HolidayOpts | null,
): number {
  const hol = holidayYmdSet instanceof Set ? holidayYmdSet : new Set<string>();
  const eff = row || {};
  const h = NUM(eff.hours);
  const abs = normAbsCode(eff.absence_code ?? eff.absenceCode);

  const dt = parseDateLocal(ymd);
  if (!dt) return 0;
  const dow = dt.getDay();
  const weekend = dow === 0 || dow === 6;
  const isHol = hol.has(ymd);

  if (weekend) {
    if (!abs && h > 0) return h;
    if (isHol && h > 0) return h;
    if (isHol) {
      if (abs === 'go' || abs === 'bo' || abs === 'sp' || (abs && PAID_FREE_DAY_CODES.has(abs))) return REGULAR_DAY_HOURS;
      return 0;
    }
    if (abs === 'go' || abs === 'sp' || abs === 'bo' || (abs && PAID_FREE_DAY_CODES.has(abs))) return REGULAR_DAY_HOURS;
    return 0;
  }
  if (isHol) {
    if (h > 0) return h;
    if (abs === 'go' || abs === 'bo' || abs === 'sp' || (abs && PAID_FREE_DAY_CODES.has(abs))) return REGULAR_DAY_HOURS;
    if (abs === 'np' || abs === 'pr' || abs === 'nop') return 0;
    return isAutoPaidHolidayEligible(ymd, opts) ? REGULAR_DAY_HOURS : 0;
  }
  if (abs === 'go' || abs === 'sp' || abs === 'bo' || (abs && PAID_FREE_DAY_CODES.has(abs))) return REGULAR_DAY_HOURS;
  if (abs === 'np' || abs === 'pr' || abs === 'nop') return 0;
  return h;
}

/** Zbir „Redovni" reda za ceo mesec (prikazne obračunske jedinice). */
export function gridRedovniSumUnitsForMonth(
  year: number,
  month: number,
  rowsByYmd: Map<string, RowLike>,
  holidayYmdSet: Set<string>,
  opts?: HolidayOpts | null,
): number {
  const agg = aggregateWorkHoursForMonth(year, month, rowsByYmd, holidayYmdSet, opts);
  return (
    agg.redovanRadSati +
    agg.praznikPlaceniSati +
    agg.godisnjiSati +
    agg.slobodniDaniSati +
    agg.bolovanje65Sati +
    agg.bolovanje100Sati +
    agg.praznikRadSati
  );
}

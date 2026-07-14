// grid-utils.ts — čiste pomoćne funkcije za Mesečni grid radnih sati (P6).
// Veran TypeScript port 1.0 `src/ui/kadrovska/gridUtils.js` + `gridRights.js`.
// ⚠️ ŠIFRE ODSUSTVA SU KANON — NE menjaj vrednosti (sy15 baza ih očekuje takve).
//
// Šifre odsustva u Redovni redu:
//   go  = godišnji odmor
//   bo  = bolovanje 65% (obično)
//   bop = bolovanje 100% (povreda na radu)      — mapira se na bo + subtype
//   bot = bolovanje 100% (održavanje trudnoće)  — mapira se na bo + subtype
//   sp  = službeni put
//   np  = neopravdano (legacy)
//   sl  = slobodan dan
//   sv  = krsna slava (plaćeno, 8h)
//   pl  = plaćeno odsustvo (plaćeno, 8h)
//   pr  = prazan dan
//   nop = neplaćeno odsustvo

export const GRID_ABS_CODES = ['go', 'bo', 'sp', 'np', 'sl', 'sv', 'pl', 'pr', 'nop'] as const;

/** Prikazne šifre bolovanja → skladišni {code:'bo', subtype}. */
export const GRID_BO_SUBTYPE_MAP: Record<string, string> = {
  bo: 'obicno',
  bop: 'povreda_na_radu',
  bot: 'odrzavanje_trudnoce',
};

/** Index 0 = nedelja. */
export const GRID_DAY_LETTERS = ['N', 'P', 'U', 'S', 'Č', 'P', 'S'];

export const GRID_FIELD_SUBTYPE_DEFAULT = 'domestic';

/** Legenda šifri (kolabilna legenda + save-confirm/tooltip). */
export const GRID_CODE_LEGEND: { code: string; label: string }[] = [
  { code: 'go', label: 'godišnji odmor' },
  { code: 'bo', label: 'bolovanje 65%' },
  { code: 'bop', label: 'bolovanje 100% (povreda na radu)' },
  { code: 'bot', label: 'bolovanje 100% (održavanje trudnoće)' },
  { code: 'sp', label: 'službeni put' },
  { code: 'sl', label: 'slobodan dan' },
  { code: 'sv', label: 'krsna slava (plaćeno 8h)' },
  { code: 'pl', label: 'plaćeno odsustvo (8h)' },
  { code: 'pr', label: 'prazan dan' },
  { code: 'np', label: 'neopravdano' },
  { code: 'nop', label: 'neplaćeno odsustvo' },
];

/** Parse 'YYYY-MM-DD' u lokalni Date (bez UTC pomeraja). */
export function parseDateLocal(ymd: string): Date | null {
  if (!ymd || typeof ymd !== 'string') return null;
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** "YYYY-MM-DD" iz (year, month1based, day). */
export function ymdOf(y: number, m1: number, d: number): string {
  return `${y}-${String(m1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Današnji datum kao 'YYYY-MM-DD' (lokalni kalendar). */
export function gridIsoToday(): string {
  const t = new Date();
  return ymdOf(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

/** Stabilan key za dirty Map: 'empId|ymd'. */
export function gridDirtyKey(empId: string, ymd: string): string {
  return empId + '|' + ymd;
}

export interface GridDay {
  day: number;
  ymd: string;
  dow: number;
  isWeekend: boolean;
  letter: string;
}

/** Niz dana za (year, month1based). Svaki: { day, ymd, dow, isWeekend, letter }. */
export function gridDaysInMonth(year: number, month: number): GridDay[] {
  if (!year || !month) return [];
  const last = new Date(year, month, 0).getDate();
  const out: GridDay[] = [];
  for (let d = 1; d <= last; d++) {
    const ymd = ymdOf(year, month, d);
    const dt = parseDateLocal(ymd);
    const dow = dt ? dt.getDay() : new Date(year, month - 1, d).getDay();
    out.push({ day: d, ymd, dow, isWeekend: dow === 0 || dow === 6, letter: GRID_DAY_LETTERS[dow] });
  }
  return out;
}

export type GridCellParse =
  | { kind: 'empty' }
  | { kind: 'abs'; code: string; subtype: string | null }
  | { kind: 'num'; value: number }
  | { kind: 'err' };

/**
 * Parsiranje sirovog teksta ćelije Redovni reda.
 *  - prazan → empty
 *  - šifra odsustva (uklj. bop/bot → bo+subtype) → abs
 *  - broj 0..24 (zarez ili tačka) → num
 *  - sve ostalo → err
 */
export function gridParseCellText(raw: string): GridCellParse {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return { kind: 'empty' };
  if (Object.prototype.hasOwnProperty.call(GRID_BO_SUBTYPE_MAP, v)) {
    return { kind: 'abs', code: 'bo', subtype: GRID_BO_SUBTYPE_MAP[v] };
  }
  if ((GRID_ABS_CODES as readonly string[]).includes(v)) return { kind: 'abs', code: v, subtype: null };
  const num = parseFloat(v.replace(',', '.'));
  if (isFinite(num) && num >= 0 && num <= 24 && /^[0-9]+([.,][0-9]+)?$/.test(v)) {
    return { kind: 'num', value: Math.round(num * 100) / 100 };
  }
  return { kind: 'err' };
}

/** Format broja za ćeliju — prazno za 0, do 2 decimale. */
export function gridFormatNum(n: number | string | null | undefined): string {
  if (n == null || Number(n) === 0) return '';
  const r = Math.round(Number(n) * 100) / 100;
  if (Number.isInteger(r)) return String(r);
  return String(r).replace(/0+$/, '').replace(/\.$/, '');
}

/** Format zbira za footer red — '0' za 0, do 2 decimale. */
export function gridFormatSum(n: number | string | null | undefined): string {
  if (!n || Number(n) === 0) return '0';
  const r = Math.round(Number(n) * 100) / 100;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Prikazna oznaka šifre za ćeliju/karnet (ćelija Redovni). Za bo — po podtipu.
 */
export function gridAbsCellLabel(code: string | null | undefined, subtype?: string | null): string {
  const c = String(code || '').toLowerCase();
  const s = String(subtype || '').toLowerCase();
  if (c === 'bo') {
    if (s === 'povreda_na_radu') return 'BOP';
    if (s === 'odrzavanje_trudnoce') return 'BOT';
    return 'BO';
  }
  return c ? c.toUpperCase() : '';
}

// ── Prava po tipu rada (port gridRights.js) ──────────────────────────

export const GRID_PAID_ABSENCE_CODES = new Set(['go', 'bo', 'sp', 'sl', 'sv', 'pl']);

export function gridWorkType(emp: Record<string, unknown> | null | undefined): string {
  return (emp?.work_type as string) || (emp?.workType as string) || 'ugovor';
}

/** Prikazni GO/bolovanje/praznik za praksu itd. — ne ulazi u isplatu. */
export function gridRegCellNoPayRight(workType: string, absenceCode: string | null | undefined): boolean {
  if (!absenceCode || workType === 'ugovor') return false;
  return GRID_PAID_ABSENCE_CODES.has(String(absenceCode).toLowerCase());
}

export function gridWorkTypeLabel(workType: string): string {
  switch (workType) {
    case 'praksa':
      return 'praksa';
    case 'dualno':
      return 'dualno';
    case 'penzioner':
      return 'penzioner';
    default:
      return 'ugovor';
  }
}

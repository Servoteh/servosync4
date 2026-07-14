// ============================================================================
// Kadrovska P8 — Odsustva/Nadoknade/Kalendar: deljena logika (bit-paritet 1.0).
// Port iz servoteh-plan-montaze: services/absenceGrid.js, lib/constants.js,
// lib/date.js, ui/kadrovska/{absencesTab,odsustvaPregledTab,calendarTab,odsutniTab}.
// Bez JSX — čiste funkcije + konstante. Boje = SEMANTIČKI TOKENI (Tailwind klase).
// ============================================================================

import type { GridRowInput, WorkHours } from '@/api/kadrovska';

// ── Tipovi odsustava + razlozi (paritet absencesTab ABS_TYPE_OPTS …) ─────────

export interface Opt {
  v: string;
  l: string;
}

export const ABS_TYPE_OPTS: Opt[] = [
  { v: 'godisnji', l: 'Godišnji odmor' },
  { v: 'bolovanje', l: 'Bolovanje' },
  { v: 'sluzbeno', l: 'Službeni put' },
  { v: 'slava', l: 'Krsna slava' },
  { v: 'placeno', l: 'Plaćeno odsustvo' },
  { v: 'neplaceno', l: 'Neplaćeno odsustvo' },
  { v: 'slobodan', l: 'Slobodan dan' },
  { v: 'ostalo', l: 'Ostalo' },
];

export const PAID_REASON_OPTS: Opt[] = [
  { v: 'rodjenje', l: 'Rođenje deteta' },
  { v: 'svadba', l: 'Svadba' },
  { v: 'smrt', l: 'Smrtni slučaj' },
  { v: 'selidba', l: 'Selidba' },
  { v: 'ostalo', l: 'Ostalo' },
];

export const SLOBODAN_REASON_OPTS: Opt[] = [
  { v: 'brak', l: 'Zaključenje braka' },
  { v: 'rodjenje_deteta', l: 'Rođenje deteta' },
  { v: 'selidba', l: 'Selidba' },
  { v: 'smrt_clana_porodice', l: 'Smrt člana porodice' },
  { v: 'dobrovoljno_davanje_krvi', l: 'Dobrovoljno davanje krvi' },
  { v: 'slava', l: 'Krsna slava' },
  { v: 'ostalo', l: 'Ostalo' },
];
export const SLOBODAN_REASON_LABELS: Record<string, string> = Object.fromEntries(
  SLOBODAN_REASON_OPTS.map((o) => [o.v, o.l]),
);

/** Podtipovi bolovanja — poklapaju se sa grid bo/bop/bot i CHECK constraint-om. */
export const SICK_SUBTYPE_OPTS: Opt[] = [
  { v: 'obicno', l: 'Obično (65%)' },
  { v: 'povreda_na_radu', l: 'Povreda na radu (100%)' },
  { v: 'odrzavanje_trudnoce', l: 'Održavanje trudnoće (100%)' },
];
export const SICK_SUBTYPE_LABELS: Record<string, string> = Object.fromEntries(
  SICK_SUBTYPE_OPTS.map((o) => [o.v, o.l]),
);

/** Labele tipova odsustva (lib/constants.js KADR_ABS_TYPE_LABELS). */
export const KADR_ABS_TYPE_LABELS: Record<string, string> = {
  godisnji: 'Godišnji odmor',
  bolovanje: 'Bolovanje',
  sluzbeno: 'Službeni put',
  sluzbeni: 'Službeni put', // legacy kod
  slobodan: 'Slobodan dan',
  neplaceno: 'Neplaćeno odsustvo',
  placeno: 'Plaćeno odsustvo',
  slava: 'Krsna slava',
  ostalo: 'Ostalo',
};
export const KADR_PAID_REASON_LABELS: Record<string, string> = {
  rodjenje: 'Rođenje deteta',
  svadba: 'Svadba',
  smrt: 'Smrtni slučaj',
  selidba: 'Selidba',
  ostalo: 'Ostalo',
};

/** Osnovi plaćenog odsustva (paidLeaveRequests.js PAID_LEAVE_CATALOG). */
export const PAID_LEAVE_CATALOG = [
  { code: 'brak', label: 'Sklapanje braka' },
  { code: 'rodjenje_deteta', label: 'Porođaj supruge / rođenje deteta' },
  { code: 'bolest_uze', label: 'Teža bolest člana uže porodice' },
  { code: 'nepogoda', label: 'Elementarna nepogoda u domaćinstvu' },
  { code: 'selidba', label: 'Selidba domaćinstva (isto mesto)' },
  { code: 'selidba_drugo', label: 'Selidba domaćinstva (drugo naseljeno mesto)' },
  { code: 'ispit', label: 'Polaganje stručnog ili drugog ispita' },
  { code: 'smrt_uze', label: 'Smrt člana uže porodice' },
  { code: 'krv', label: 'Dobrovoljno davanje krvi' },
  { code: 'ostalo', label: 'Drugo (uz obrazloženje)' },
];
export const PAID_LEAVE_LABEL: Record<string, string> = Object.fromEntries(
  PAID_LEAVE_CATALOG.map((c) => [c.code, c.label]),
);

// ── Boje po tipu (semantički tokeni; kategorijalna paleta bez novih hex-ova) ──
// GO=zeleno, BO=crveno, SP=plavo, PL/Slava=žuto, Slobodan=teal(accent),
// Neplaćeno=sivo, Ostalo=neutralno. Skraćenice = 1.0 calendarTab ABS_SHORT.

export interface AbsStyle {
  /** Klase za pill/badge (bg + tekst). */
  badge: string;
  /** Klasa za traku/tačku (solid bg). */
  bar: string;
  short: string;
}
export const ABS_STYLE: Record<string, AbsStyle> = {
  godisnji: { badge: 'bg-status-success-bg text-status-success', bar: 'bg-status-success', short: 'GO' },
  bolovanje: { badge: 'bg-status-danger-bg text-status-danger', bar: 'bg-status-danger', short: 'BO' },
  sluzbeno: { badge: 'bg-status-info-bg text-status-info', bar: 'bg-status-info', short: 'SP' },
  slava: { badge: 'bg-status-warn-bg text-status-warn', bar: 'bg-status-warn', short: 'SL' },
  placeno: { badge: 'bg-status-warn-bg text-status-warn', bar: 'bg-status-warn', short: 'PL' },
  slobodan: { badge: 'bg-accent-subtle text-accent', bar: 'bg-accent', short: 'SL' },
  neplaceno: { badge: 'bg-status-neutral-bg text-status-neutral', bar: 'bg-status-neutral', short: 'NP' },
  ostalo: { badge: 'bg-surface-2 text-ink-secondary', bar: 'bg-ink-disabled', short: '·' },
};
export function absStyle(type: string): AbsStyle {
  return ABS_STYLE[type] ?? ABS_STYLE.ostalo;
}
export function absLabel(type: string): string {
  return KADR_ABS_TYPE_LABELS[type] ?? type;
}
/** Puna labela sa podtipom/razlogom (paritet absencesTab red badge). */
export function absTypeFullLabel(a: {
  type: string;
  paidReason?: string | null;
  slobodanReason?: string | null;
  absenceSubtype?: string | null;
}): string {
  let lbl = absLabel(a.type);
  if (a.type === 'placeno' && a.paidReason) lbl += ' — ' + (KADR_PAID_REASON_LABELS[a.paidReason] || a.paidReason);
  if (a.type === 'slobodan' && a.slobodanReason)
    lbl += ' — ' + (SLOBODAN_REASON_LABELS[a.slobodanReason] || a.slobodanReason);
  if (a.type === 'bolovanje' && a.absenceSubtype)
    lbl += ' — ' + (SICK_SUBTYPE_LABELS[a.absenceSubtype] || a.absenceSubtype);
  return lbl;
}

// ── Most odsustvo → grid (services/absenceGrid.js) ───────────────────────────

/** type → grid absence_code; null = nema grid ekvivalent (samo 'ostalo'). */
export const ABSENCE_TYPE_TO_GRID_CODE: Readonly<Record<string, string>> = Object.freeze({
  godisnji: 'go',
  bolovanje: 'bo',
  slobodan: 'sl',
  neplaceno: 'nop',
  slava: 'sv',
  placeno: 'pl',
  sluzbeno: 'sp',
});
export const GRID_CODE_TO_ABSENCE_TYPE: Readonly<Record<string, string>> = Object.freeze({
  go: 'godisnji',
  bo: 'bolovanje',
  sl: 'slobodan',
  nop: 'neplaceno',
  sv: 'slava',
  pl: 'placeno',
  sp: 'sluzbeno',
});
const SICK_SUBTYPES = new Set(['obicno', 'povreda_na_radu', 'odrzavanje_trudnoce']);

export function absenceTypeToGridCode(type: string): string | null {
  return ABSENCE_TYPE_TO_GRID_CODE[String(type || '').toLowerCase()] || null;
}
export function absenceGoesToGrid(type: string): boolean {
  return absenceTypeToGridCode(type) != null;
}
export function gridCodeToAbsenceType(code: string | null | undefined): string | null {
  return GRID_CODE_TO_ABSENCE_TYPE[String(code || '').toLowerCase()] || null;
}

/** Pseudo-odsustvo iz jednog work_hours reda (za kalendar/odsutni). null ako nije odsustvo. */
export interface AbsenceView {
  employeeId: string;
  type: string;
  dateFrom: string;
  dateTo: string;
  daysCount: number;
  absenceSubtype: string | null;
  slobodanReason?: string | null;
  paidReason?: string | null;
  note: string;
  _fromGrid: true;
}
export function workHourToAbsenceView(row: WorkHours): AbsenceView | null {
  if (!row || !row.employeeId || !row.workDate) return null;
  const type = gridCodeToAbsenceType(row.absenceCode);
  if (!type) return null;
  const ymd = String(row.workDate).slice(0, 10);
  return {
    employeeId: row.employeeId,
    type,
    dateFrom: ymd,
    dateTo: ymd,
    daysCount: 1,
    absenceSubtype: row.absenceSubtype || null,
    note: row.note || '',
    _fromGrid: true,
  };
}

/** Radni dani u [from,to], preskačući vikende i praznike. */
export function expandPeriodToWorkdays(from: string, to: string, holidaySet: Set<string> = new Set()): string[] {
  if (!from || !to || from > to) return [];
  const out: string[] = [];
  let cur = from;
  for (let guard = 0; guard < 800 && cur <= to; guard++) {
    if (!isWeekendYmd(cur) && !holidaySet.has(cur)) out.push(cur);
    cur = ymdAddDays(cur, 1);
  }
  return out;
}

/** Grid batch redovi za period odsustva (jedan po radnom danu, hours=0 + šifra). */
export function buildAbsenceGridRows(args: {
  employeeId: string;
  type: string;
  absenceSubtype?: string | null;
  dateFrom: string;
  dateTo: string;
  holidaySet?: Set<string>;
}): { rows: GridRowInput[]; days: string[]; code: string } | null {
  const code = absenceTypeToGridCode(args.type);
  if (!code || !args.employeeId) return null;
  const days = expandPeriodToWorkdays(args.dateFrom, args.dateTo, args.holidaySet || new Set());
  if (!days.length) return null;
  const subtype =
    code === 'bo' && SICK_SUBTYPES.has(String(args.absenceSubtype || '').toLowerCase())
      ? String(args.absenceSubtype).toLowerCase()
      : code === 'bo'
        ? 'obicno'
        : undefined;
  const rows: GridRowInput[] = days.map((workDate) => ({
    employeeId: args.employeeId,
    workDate,
    hours: 0,
    overtimeHours: 0,
    fieldHours: 0,
    twoMachineHours: 0,
    absenceCode: code,
    absenceSubtype: subtype,
  }));
  return { rows, days, code };
}

/** Da li je tip dozvoljen za tip rada (paritet validateAbsenceForWorkType). */
export function validateAbsenceForWorkType(
  type: string,
  workType: string | null | undefined,
): { ok: true } | { ok: false; msg: string } {
  if (!workType || type === 'neplaceno' || type === 'sluzbeno' || type === 'ostalo') return { ok: true };
  const needsContract = ['godisnji', 'bolovanje', 'placeno', 'slobodan', 'slava'];
  if (needsContract.includes(type) && workType !== 'ugovor') {
    return {
      ok: false,
      msg: `Tip odsustva nije dozvoljen za tip rada „${workType}" — samo za zaposlene sa ugovorom o radu.`,
    };
  }
  return { ok: true };
}

// ── Datumski helperi (lib/date.js paritet) ───────────────────────────────────

export function todayYmd(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
export function ymd(y: number, m1: number, d: number): string {
  return `${y}-${String(m1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function parseYmdLocal(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export function ymdAddDays(s: string, n: number): string {
  const d = parseYmdLocal(s);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function isWeekendYmd(s: string): boolean {
  const dow = parseYmdLocal(s).getDay();
  return dow === 0 || dow === 6;
}
export function dowYmd(s: string): number {
  return parseYmdLocal(s).getDay();
}
export function mondayOf(s: string): string {
  const dow = parseYmdLocal(s).getDay();
  return ymdAddDays(s, dow === 0 ? -6 : 1 - dow);
}
/** Broj dana u zatvorenom intervalu [from,to] (inclusive). */
export function daysInclusive(from: string, to: string): number {
  if (!from || !to || from > to) return 0;
  const a = parseYmdLocal(from).getTime();
  const b = parseYmdLocal(to).getTime();
  return Math.round((b - a) / 86400000) + 1;
}
/** Clamp broj dana odsustva na period. */
export function clampDays(dateFrom: string, dateTo: string, periodFrom: string, periodTo: string): number {
  if (!dateFrom || !dateTo) return 0;
  const f = dateFrom < periodFrom ? periodFrom : dateFrom;
  const t = dateTo > periodTo ? periodTo : dateTo;
  if (f > t) return 0;
  return daysInclusive(f, t);
}

export interface MonthDay {
  day: number;
  ymd: string;
  dow: number;
  isWeekend: boolean;
}
/** Dani u mesecu iz 'YYYY-MM'. */
export function daysInMonthKey(monthKey: string): MonthDay[] {
  if (!monthKey) return [];
  const [y, m] = monthKey.split('-').map((n) => parseInt(n, 10));
  if (!y || !m) return [];
  const last = new Date(y, m, 0).getDate();
  const out: MonthDay[] = [];
  for (let d = 1; d <= last; d++) {
    const s = ymd(y, m, d);
    const dow = new Date(y, m - 1, d).getDay();
    out.push({ day: d, ymd: s, dow, isWeekend: dow === 0 || dow === 6 });
  }
  return out;
}
export function defaultMonthKey(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
}
export function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map((n) => parseInt(n, 10));
  let ny = y;
  let nm = m + delta;
  while (nm < 1) {
    nm += 12;
    ny -= 1;
  }
  while (nm > 12) {
    nm -= 12;
    ny += 1;
  }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

// ── Normalizacija reda direktorijuma (kadrovska /directory ViewRow) ───────────

export interface EmpRow {
  id: string;
  name: string;
  position: string;
  department: string;
  team: string;
  workType: string;
  isActive: boolean;
  birthDate: string | null;
  medicalExamExpires: string | null;
  departmentId: number | null;
  subDepartmentId: number | null;
}
function pickStr(row: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
}
function pickNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== '') return Number(v);
  }
  return null;
}
/**
 * Direktorijum je bespoke ViewRow — polja `is_active`, `work_type`, `birth_date`,
 * `medical_exam_expires`, `sub_department_id` NISU garantovana (PII maska).
 * Čitamo defanzivno; gde nedostaju, degradira mirno (⚠️ TODO(P1a): izložiti u view-u).
 */
export function normEmp(row: Record<string, unknown>): EmpRow {
  const active = row.is_active ?? row.isActive;
  return {
    id: pickStr(row, ['id', 'employee_id']),
    name: pickStr(row, ['full_name', 'name']) || '—',
    position: pickStr(row, ['position']),
    department: pickStr(row, ['department']),
    team: pickStr(row, ['team']),
    workType: pickStr(row, ['work_type', 'workType']),
    isActive: active == null ? true : Boolean(active) && active !== 'false',
    birthDate: pickStr(row, ['birth_date', 'birthDate']) || null,
    medicalExamExpires: pickStr(row, ['medical_exam_expires', 'medicalExamExpires']) || null,
    departmentId: pickNum(row, ['department_id', 'departmentId']),
    subDepartmentId: pickNum(row, ['sub_department_id', 'subDepartmentId']),
  };
}
/** Poređenje po imenu (srpski locale). */
export function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, 'sr');
}

// ── sessionStorage (persist filtera/pogleda) ─────────────────────────────────

export const SS_KEYS = {
  subtab: 'ss2_kadr_odsustva_subtab_v1',
  period: 'ss2_kadr_odsustva_period_v1',
  sort: 'ss2_kadr_odsustva_sort_v1',
} as const;

export function ssGet(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  try {
    return window.sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function ssSet(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

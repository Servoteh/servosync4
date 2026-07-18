// P9 ZARADE — deljeni helperi (labele, prozori isplate, preračun, live totali).
// Finansijske formule: NETO↔BRUTO iz `@/lib/salary-tax` (zlatne, ne dirati).
// Grid live-preview = mirror DB trigera (computeLiveTotals). Autoritativni K3.3
// obračun je BE (`/salary/payroll/recompute`); FE NE duplira engine.

import { grossToNet, netToGross } from '@/lib/salary-tax';

/* ── Snake-case view redovi (v_employee_current_salary / v_salary_payroll_month) ── */

export type ViewRow = Record<string, unknown>;

export function n(row: ViewRow | null | undefined, key: string): number {
  const v = row?.[key];
  return v == null || v === '' || isNaN(Number(v)) ? 0 : Number(v);
}
export function s(row: ViewRow | null | undefined, key: string): string {
  const v = row?.[key];
  return v == null ? '' : String(v);
}

/* ── Labele ──────────────────────────────────────────────────── */

export function salaryTypeLabel(t: string | null | undefined): string {
  switch (t) {
    case 'ugovor': return 'Ugovor (mesečno)';
    case 'dogovor': return 'Dogovor (mesečno)';
    case 'satnica': return 'Satnica';
    default: return t || '—';
  }
}

export const COMPENSATION_MODELS = ['fiksno', 'dva_dela', 'satnica', 'jednokratno', 'praksa'] as const;
export type CompensationModel = (typeof COMPENSATION_MODELS)[number];

export function compensationModelLabel(m: string | null | undefined): string {
  switch (m) {
    case 'fiksno': return 'Fiksno (01–05)';
    case 'dva_dela': return 'Dva dela (01–05 + 15–20)';
    case 'satnica': return 'Satnica (01–05 + 15–20)';
    case 'jednokratno': return 'Jednokratno — portiri (15–20)';
    case 'praksa': return 'Praksa — po satu (15–20)';
    default: return m || '—';
  }
}

export const PAYROLL_GROUPS: [string, string][] = [
  ['standard', '— Standardna lista (bez olakšica)'],
  ['olaksice', 'O — Stare olakšice (čl. 21v/21d)'],
  ['razvoj', 'R — Razvoj (čl. 21i / 45z)'],
  ['stranci', 'S — Stranci (nerezidenti)'],
  ['hapfluid', 'H — HAP Fluid (HOLPEN)'],
  ['kes', 'K — Keš (ne šalje se)'],
];
export const PAYROLL_GROUP_LETTER: Record<string, string> = {
  olaksice: 'O', razvoj: 'R', stranci: 'S', hapfluid: 'H', kes: 'K',
};

/** Legacy salary_type → compensation_model heuristika (port 1.0/BE). */
export function deriveCompensationModel(salaryType: string | null | undefined, model?: string | null): string | null {
  if (model && (COMPENSATION_MODELS as readonly string[]).includes(model)) return model;
  switch (salaryType) {
    case 'satnica': return 'satnica';
    case 'ugovor':
    case 'dogovor': return 'fiksno';
    default: return null;
  }
}

/* ── Prozori isplate (port 1.0 payrollCalc.js / BE payroll-calc.ts) ── */

export const PAYMENT_WINDOW_LABELS: Record<string, string> = {
  '01_05': '01–05. u mesecu',
  '15_20': '15–20. u mesecu',
};

export function paymentWindowsForModel(model: string | null | undefined, override?: string | null): string[] {
  if (override === '01_05' || override === '15_20') return [override];
  switch (model) {
    case 'fiksno': return ['01_05'];
    case 'dva_dela':
    case 'satnica': return ['01_05', '15_20'];
    case 'jednokratno':
    case 'praksa': return ['15_20'];
    default: return [];
  }
}

export function paymentWindowLabel(model: string | null | undefined, override?: string | null): string {
  return paymentWindowsForModel(model, override).map((w) => PAYMENT_WINDOW_LABELS[w]).join(' + ');
}

/** Da li YMD datum pada u prozor isplate? Bez datuma/prozora → true. */
export function isDateInPaymentWindow(ymd: string | null | undefined, windowKey: string): boolean {
  const d = parseInt(String(ymd || '').slice(8, 10), 10);
  if (!d) return true;
  if (windowKey === '01_05') return d >= 1 && d <= 5;
  if (windowKey === '15_20') return d >= 15 && d <= 20;
  return true;
}

/* ── Formatiranje (sr-RS) ────────────────────────────────────── */

export function fmtMoney(amount: number | string | null | undefined, currency = 'RSD'): string {
  if (amount == null || amount === '' || isNaN(Number(amount))) return '—';
  const str = Number(amount).toLocaleString('sr-RS', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${str} ${currency}`;
}
export function fmtRsd(amount: number | string | null | undefined): string {
  return `${Number(amount || 0).toLocaleString('sr-RS', { maximumFractionDigits: 2 })} RSD`;
}
export function fmtRsd2(amount: number | string | null | undefined): string {
  return `${Number(amount || 0).toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} RSD`;
}
export function fmtNum(amount: number | string | null | undefined): string {
  return Number(amount || 0).toLocaleString('sr-RS', { maximumFractionDigits: 2 });
}
export function round2(v: number): number {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/* ── NETO ↔ BRUTO I preračun (za kalkulator u modalu i snapshot na redu) ── */

export interface ContractSalary {
  netoRsd: number;
  brutoRsd: number;
  breakdown: ReturnType<typeof grossToNet>;
}

/**
 * JEDAN izvor istine: izvedi mesečni NETO/BRUTO I iz (Iznos, Neto/Bruto, Tip, Valuta).
 * Vraća null kad preračun ne važi (satnica, ne-RSD valuta, nevažeći iznos).
 */
export function computeContractSalaryFromValues(
  salaryType: string,
  amountType: string,
  amount: number,
  currency = 'RSD',
): ContractSalary | null {
  if (salaryType === 'satnica' || (currency || 'RSD') !== 'RSD' || !(amount > 0)) return null;
  let netoRsd: number;
  let brutoRsd: number;
  if (amountType === 'bruto') { brutoRsd = amount; netoRsd = grossToNet(amount).neto; }
  else { netoRsd = amount; brutoRsd = netToGross(amount); }
  return { netoRsd, brutoRsd, breakdown: grossToNet(brutoRsd) };
}

/* ── Grid live totals — mirror DB trigera (port 1.0 computeTotals) ── */

export interface LiveTotals {
  baseRsd: number;
  totalRsd: number;
  totalEur: number;
  secondPartRsd: number;
}

/**
 * Ogledalo DB trigera (`salary_payroll` total_rsd/total_eur/second_part_rsd) za
 * live preview pre save-a. isHourly: satnica × sati; ostalo: fiksna plata.
 */
export function computeLiveTotals(inp: {
  salaryType: string;
  hoursWorked: number;
  hourlyRate: number;
  fixedSalary: number;
  transportRsd: number;
  domesticDays: number;
  perDiemRsd: number;
  foreignDays: number;
  perDiemEur: number;
  advanceAmount: number;
}): LiveTotals {
  const base = inp.salaryType === 'satnica' ? inp.hoursWorked * inp.hourlyRate : inp.fixedSalary;
  const totalRsd = base + inp.transportRsd + inp.perDiemRsd * inp.domesticDays;
  const totalEur = inp.perDiemEur * inp.foreignDays;
  const secondPartRsd = totalRsd - inp.advanceAmount;
  return { baseRsd: base, totalRsd: round2(totalRsd), totalEur: round2(totalEur), secondPartRsd: round2(secondPartRsd) };
}

/** Nazivi meseca (latinica, za PDF/tabele knjigovođe). */
export const MONTHS_SR_LAT = [
  'januar', 'februar', 'mart', 'april', 'maj', 'jun',
  'jul', 'avgust', 'septembar', 'oktobar', 'novembar', 'decembar',
];
/** Nazivi meseca (velika slova, latinica). */
export const MONTHS_SR_UPPER = [
  'Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun',
  'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar',
];

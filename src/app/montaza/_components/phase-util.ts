// Plan montaže — phase helpers, bit-paritetno sa 1.0 src/lib/phase.js + constants.js
// (doktrina §C: NE redizajniraj poslovni tok/labele/pravila).

import type { PmPhase } from '@/api/plan-montaze';

export const STATUSES = ['Nije počelo', 'U toku', 'Završeno', 'Na čekanju'] as const;

export const CHECK_LABELS = [
  'Montažni crteži',
  'Mašinske komponente',
  'Gotova roba',
  'Vijčana roba',
  'Električni materijal',
  'Alati / oprema',
  'Termin potvrđen',
  'Dostupna ekipa',
] as const;

export const CHECK_SHORT = ['Crteži', 'Mašin.', 'Got.rob', 'Vijci', 'Elektro', 'Alati', 'Termin', 'Ekipa'] as const;

export const NUM_CHECKS = CHECK_LABELS.length;

export const DEFAULT_LOCATIONS = ['Dobanovci', 'Kruševac'] as const;

/** Deterministička boja lokacije (Gantt trake). */
const LOC_PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#ca8a04'];
export function locationColor(loc: string | null | undefined): string {
  const s = String(loc ?? '').trim();
  if (!s) return '#64748b';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return LOC_PALETTE[h % LOC_PALETTE.length];
}

export function statusLabel(s: number | null | undefined): string {
  return STATUSES[s ?? 0] ?? STATUSES[0];
}

export function checks8(row: Pick<PmPhase, 'checks'>): boolean[] {
  const c = Array.isArray(row.checks) ? row.checks : [];
  return Array.from({ length: NUM_CHECKS }, (_, i) => !!c[i]);
}

export interface Readiness {
  ready: boolean;
  reasons: string[];
  done: boolean;
}

/** Spremnost faze (paritet calcReadiness): status=2 (Završeno) je done. */
export function calcReadiness(row: PmPhase): Readiness {
  const reasons: string[] = [];
  if (row.status === 2) return { ready: false, reasons: ['Završeno'], done: true };
  const checks = checks8(row);
  for (let ci = 0; ci < NUM_CHECKS; ci++) {
    if (!checks[ci]) reasons.push(`${CHECK_LABELS[ci]}: NE`);
  }
  if (!row.montageLead) reasons.push('Nema vođe');
  if (!row.startDate) reasons.push('Nema datuma početka');
  return { ready: reasons.length === 0, reasons, done: false };
}

export type RiskLevel = 'none' | 'low' | 'med' | 'high';

function daysFromToday(d: string | null): number | null {
  if (!d) return null;
  const t = new Date(`${d.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(t.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((t.getTime() - now.getTime()) / 86_400_000);
}

/** Rizik faze (paritet calcRisk). */
export function calcRisk(row: PmPhase): { level: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  const checks = checks8(row);
  if (row.startDate && row.endDate && new Date(row.endDate) < new Date(row.startDate)) {
    reasons.push('🔴 Kraj pre početka');
  }
  if (row.status === 2 && !checks.every((c) => c)) reasons.push('🔴 Završeno ali nepotpuno');
  if (row.startDate && row.status !== 2) {
    const d = daysFromToday(row.startDate);
    if (d !== null && d >= 0 && d <= 7 && !calcReadiness(row).ready) {
      reasons.push('🟠 Počinje uskoro, nije spremno');
    }
  }
  if (!row.montageLead && row.status !== 2) reasons.push('🟡 Nema vođe');
  if ((!row.startDate || !row.endDate) && row.status !== 2) reasons.push('⚪ Nedostaju datumi');
  if (row.status === 3 && !row.blocker?.trim()) reasons.push('🟠 Na čekanju bez blokatora');

  let level: RiskLevel = 'none';
  if (reasons.some((r) => r.startsWith('🔴'))) level = 'high';
  else if (reasons.some((r) => r.startsWith('🟠'))) level = 'med';
  else if (reasons.some((r) => r.startsWith('🟡') || r.startsWith('⚪'))) level = 'low';
  return { level, reasons };
}

export interface DraftPhase {
  status: number;
  pct: number;
  startDate: string | null;
  endDate: string | null;
}

/**
 * Business rules (paritet applyBusinessRules): status↔pct sync + end≥start.
 * `changedField` razrešava kontradikciju (status pobeđuje kad je eksplicitno dirnut).
 */
export function applyBusinessRules<T extends DraftPhase>(row: T, changedField?: 'status' | 'pct' | 'start' | 'end'): T {
  if (changedField !== 'status') {
    if (row.pct > 0 && row.status === 0) row.status = 1;
    if (row.pct === 100 && row.status !== 2) row.status = 2;
  }
  if (row.status === 2) row.pct = 100;
  if (row.status === 0) row.pct = 0;
  if (row.startDate && row.endDate && new Date(row.endDate) < new Date(row.startDate)) {
    row.endDate = row.startDate;
  }
  return row;
}

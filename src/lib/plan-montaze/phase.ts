// Plan montaže — poslovna pravila faze (port 1:1 iz 1.0 src/lib/phase.js).
// Spremnost/rizik su ČISTO KLIJENTSKE derivacije (SPEC §0): status↔pct sync, end≥start,
// 8 checkova. Logika mora ostati bit-paritetna sa 1.0 — testovi to čuvaju.
//
// Razlika prema 1.0: emoji prefiksi iz reason stringova (🔴🟠🟡⚪) se NE prikazuju
// (DESIGN_SYSTEM §2 „bez emoji-ja u UI"); severity se nosi kao polje, prikaz je čist tekst.

import type { Tone } from '@/components/ui-kit/status-badge';
import { NUM_CHECKS, CHECK_LABELS, STATUSES, LOC_PALETTE, LOC_EMPTY_COLOR } from './constants';
import { calcDuration, dayDiffFromToday, parseDateLocal } from './date';

/** Minimalni oblik faze koji pravila diraju (podskup PhaseVM). `checks` = 8 bool. */
export interface PhaseRuleInput {
  status: number;
  pct: number;
  checks: boolean[];
  /** Vođa montaže (1.0 `person` = montageLead). */
  montageLead: string;
  /** Datum početka 'YYYY-MM-DD' (1.0 `start`). */
  startDate: string;
  /** Datum kraja 'YYYY-MM-DD' (1.0 `end`). */
  endDate: string;
  blocker?: string;
}

export type RiskLevel = 'none' | 'low' | 'med' | 'high';
export type RiskSeverity = 'low' | 'med' | 'high';

export interface ReadinessResult {
  ready: boolean;
  reasons: string[];
  done: boolean;
}

export interface RiskReason {
  severity: RiskSeverity;
  text: string;
}
export interface RiskResult {
  level: RiskLevel;
  reasons: RiskReason[];
}

export function normalizePhaseType(t: string | null | undefined): 'mechanical' | 'electrical' {
  const v = String(t || '').toLowerCase();
  return v === 'electrical' || v === 'elektro' || v === 'e' ? 'electrical' : 'mechanical';
}

/**
 * Spremnost faze: sve završeno (status=2) → done; inače traži svih 8 checkova + vođu + datum.
 * Paritet 1.0 calcReadiness.
 */
export function calcReadiness(row: PhaseRuleInput): ReadinessResult {
  const reasons: string[] = [];
  if (row.status === 2) return { ready: false, reasons: ['Završeno'], done: true };
  for (let ci = 0; ci < NUM_CHECKS; ci++) {
    if (!row.checks[ci]) reasons.push(CHECK_LABELS[ci] + ': NE');
  }
  if (!row.montageLead) reasons.push('Nema vođe');
  if (!row.startDate) reasons.push('Nema datuma početka');
  return { ready: reasons.length === 0, reasons, done: false };
}

/**
 * Rizik faze. Paritet 1.0 calcRisk — iste provere i ista derivacija nivoa
 * (🔴=high, 🟠=med, 🟡/⚪=low), samo bez emoji-ja u tekstu.
 */
export function calcRisk(row: PhaseRuleInput): RiskResult {
  const reasons: RiskReason[] = [];
  const dur = calcDuration(row.startDate, row.endDate);
  if (dur === -1) reasons.push({ severity: 'high', text: 'Kraj pre početka' });
  if (row.status === 2 && !row.checks.every((c) => c)) {
    reasons.push({ severity: 'high', text: 'Završeno ali nepotpuno' });
  }
  if (row.startDate && row.status !== 2) {
    const d = dayDiffFromToday(row.startDate);
    if (d !== null && d >= 0 && d <= 7 && !calcReadiness(row).ready) {
      reasons.push({ severity: 'med', text: 'Počinje uskoro, nije spremno' });
    }
  }
  if (!row.montageLead && row.status !== 2) reasons.push({ severity: 'low', text: 'Nema vođe' });
  if ((!row.startDate || !row.endDate) && row.status !== 2) {
    reasons.push({ severity: 'low', text: 'Nedostaju datumi' });
  }
  if (row.status === 3 && !row.blocker?.trim()) {
    reasons.push({ severity: 'med', text: 'Na čekanju bez blokatora' });
  }

  let level: RiskLevel = 'none';
  if (reasons.some((r) => r.severity === 'high')) level = 'high';
  else if (reasons.some((r) => r.severity === 'med')) level = 'med';
  else if (reasons.some((r) => r.severity === 'low')) level = 'low';
  return { level, reasons };
}

/**
 * Mutira row da poštuje pravila (paritet 1.0 applyBusinessRules):
 *  - status=2 → pct=100; status=0 → pct=0
 *  - pct>0 i status=0 → status=1 (D-5); pct=100 i status≠2 → status=2
 *  - end<start → end=start
 *
 * `changedField` razrešava kontradikciju status=0↔pct>0: eksplicitno dirnuto polje pobeđuje.
 * Bez njega (drag/bulk) prioritet ima pct→status.
 */
export function applyBusinessRules<T extends PhaseRuleInput>(row: T, changedField?: string): T {
  if (changedField !== 'status') {
    if (row.pct > 0 && row.status === 0) row.status = 1;
    if (row.pct === 100 && row.status !== 2) row.status = 2;
  }
  if (row.status === 2) row.pct = 100;
  if (row.status === 0) row.pct = 0;
  if (row.startDate && row.endDate) {
    const s = parseDateLocal(row.startDate);
    const e = parseDateLocal(row.endDate);
    if (s && e && e < s) row.endDate = row.startDate;
  }
  return row;
}

// ── Prikaz statusa (2.0: StatusBadge tone umesto 1.0 'st-0'..'st-3' CSS klasa) ──

const STATUS_TONE: Tone[] = ['neutral', 'info', 'success', 'warn'];

/** Status faze (0..3) → {tone,label} za StatusBadge (kanonska mapa DESIGN_SYSTEM §7). */
export function phaseStatusBadge(status: number): { tone: Tone; label: string } {
  const idx = status >= 0 && status <= 3 ? status : 0;
  return { tone: STATUS_TONE[idx], label: STATUSES[idx] };
}

/** Rizik nivo → StatusBadge tone (za prikaz kolone rizika). */
export function riskTone(level: RiskLevel): Tone {
  return level === 'high' ? 'danger' : level === 'med' ? 'warn' : level === 'low' ? 'info' : 'neutral';
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  none: 'Nema rizika',
  low: 'Nizak',
  med: 'Srednji',
  high: 'Visok',
};

// ── Boja lokacije (2.0 online-only: deterministički hash → paleta, bez localStorage sidecar-a) ──

/** Stabilna boja za naziv lokacije (paritet 1.0 palete; prazno = neutralna). */
export function locationColor(loc: string | null | undefined): string {
  const s = (loc ?? '').trim();
  if (!s) return LOC_EMPTY_COLOR;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return LOC_PALETTE[Math.abs(h) % LOC_PALETTE.length];
}

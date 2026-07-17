'use client';

import { cn } from '@/lib/cn';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import type { OpRow } from '@/api/plan-proizvodnje';

/**
 * Odeljenja (chip-tabovi „Po mašini"-ja) — DOSLOVNI port 1.0
 * `planProizvodnje/departments.js`. Filter je kod-based (rj_code mašine /
 * effective_machine_code operacije). `kind:'machines'` prvo prikazuje LISTU
 * mašina (numerički sort) pa drill-down na operacije; `kind:'all'` = „Sve"
 * (dropdown) ili „Ostalo" (isFallback). `row` (1|2) forsira 2 fiksna reda.
 * Korisnik je 22.04.2026 eksplicitno tražio ovaj obrazac (lista mašina → klik).
 */
export interface Dept {
  slug: string;
  label: string;
  row: 1 | 2;
  kind: 'machines' | 'all';
  machinePrefixes?: string[];
  machineCodes?: string[];
  excludeMachineCodes?: string[];
  isFallback?: boolean;
}

export const DEPARTMENTS: Dept[] = [
  /* ── Red 1 ── */
  { slug: 'sve', label: 'Sve', row: 1, kind: 'all' },
  { slug: 'glodanje', label: 'Glodanje', row: 1, kind: 'machines', machinePrefixes: ['3'] },
  { slug: 'struganje', label: 'Struganje', row: 1, kind: 'machines', machinePrefixes: ['2'], excludeMachineCodes: ['21.1', '21.2'] },
  { slug: 'brusenje', label: 'Brušenje', row: 1, kind: 'machines', machinePrefixes: ['6'], excludeMachineCodes: ['6.8'] },
  { slug: 'erodiranje', label: 'Erodiranje', row: 1, kind: 'machines', machineCodes: ['10.1', '10.2', '10.3', '10.4', '10.5'] },
  { slug: 'azistiranje', label: 'Ažistiranje', row: 1, kind: 'machines', machineCodes: ['8.2'] },
  /* ── Red 2 ── */
  { slug: 'secenje', label: 'Sečenje i savijanje', row: 2, kind: 'machines', machineCodes: ['1.10', '1.2', '1.30', '1.40', '1.50', '1.60', '1.71', '1.72'] },
  { slug: 'bravarsko', label: 'Bravarsko', row: 2, kind: 'machines', machineCodes: ['4.1', '4.11', '4.12', '4.2', '4.3', '4.4'] },
  { slug: 'farbanje', label: 'Farbanje i površinska zaštita', row: 2, kind: 'machines', machineCodes: ['5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8', '5.11'] },
  { slug: 'cam', label: 'CAM programiranje', row: 2, kind: 'machines', machineCodes: ['17.0', '17.1'] },
  { slug: 'ostalo', label: 'Ostalo', row: 2, kind: 'all', isFallback: true },
];

export const DEPARTMENTS_ROW_1 = DEPARTMENTS.filter((d) => d.row === 1);
export const DEPARTMENTS_ROW_2 = DEPARTMENTS.filter((d) => d.row === 2);

/** „3.21" → „3", „10" → „10" (prefiks pre prve tačke). */
export function codePrefix(code: string | null | undefined): string | null {
  if (!code) return null;
  const s = String(code);
  const dot = s.indexOf('.');
  return dot < 0 ? s : s.slice(0, dot);
}

/** Numeričko poređenje kodova „X.Y.Z" segment-po-segment → „3.2" PRE „3.11". */
export function compareCodes(a: string, b: string): number {
  const pa = String(a || '').split('.').map((s) => parseInt(s, 10) || 0);
  const pb = String(b || '').split('.').map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function getDepartment(slug: string | null | undefined): Dept | null {
  return DEPARTMENTS.find((d) => d.slug === slug) || null;
}

/** Da li mašina (rj_code) pripada datom odeljenju (exclude → codes → prefixes). */
export function machineMatchesDept(machine: { rj_code?: string | null }, dept: Dept | null): boolean {
  if (!dept) return false;
  if (dept.kind === 'all' && !dept.isFallback) return true;
  const code = String(machine?.rj_code || '');
  if (!code) return false;
  if (Array.isArray(dept.excludeMachineCodes) && dept.excludeMachineCodes.includes(code)) return false;
  if (Array.isArray(dept.machineCodes) && dept.machineCodes.includes(code)) return true;
  if (Array.isArray(dept.machinePrefixes)) {
    const prefix = codePrefix(code);
    if (prefix != null && dept.machinePrefixes.includes(prefix)) return true;
  }
  return false;
}

/** Mašina koja ne upada ni u jedan `machines` tab → „Ostalo". */
export function machineFallsIntoOstalo(machine: { rj_code?: string | null }): boolean {
  const machineDepts = DEPARTMENTS.filter((d) => d.kind === 'machines');
  return !machineDepts.some((d) => machineMatchesDept(machine, d));
}

/** Operacija (effective_machine_code) ide u „Ostalo" ako njen kod ne pripada nijednom tabu. */
export function operationFallsIntoOstalo(op: { effective_machine_code?: string | null }): boolean {
  const code = String(op?.effective_machine_code || '');
  if (!code) return true;
  return machineFallsIntoOstalo({ rj_code: code });
}

/** Filtriraj listu mašina za dato odeljenje (klijentski, sortirano numerički). */
export function filterMachinesForDept<T extends { rj_code: string }>(allMachines: T[], dept: Dept | null): T[] {
  if (!Array.isArray(allMachines) || !dept) return [];
  if (dept.kind === 'all' && !dept.isFallback) return allMachines.slice();
  if (dept.isFallback) {
    return allMachines.filter((m) => machineFallsIntoOstalo(m)).sort((a, b) => compareCodes(a.rj_code, b.rj_code));
  }
  return allMachines.filter((m) => machineMatchesDept(m, dept)).sort((a, b) => compareCodes(a.rj_code, b.rj_code));
}

/**
 * Da li mašina (rj_code) „pripada" departmentu — validacija LS restore-a
 * (spreči drill-down u mašinu koja ne pripada trenutnom tabu).
 */
export function machineFitsDept(rjCode: string, dept: Dept | null): boolean {
  if (!dept) return false;
  if (dept.kind === 'all' && !dept.isFallback) return true;
  if (dept.kind === 'machines') return machineMatchesDept({ rj_code: rjCode }, dept);
  if (dept.isFallback) return machineFallsIntoOstalo({ rj_code: rjCode });
  return false;
}

/** Slug `machines` taba kome mašina pripada (za skok iz Zauzetost/Pregled). */
export function findDeptForMachineCode(rjCode: string | null | undefined): string {
  if (!rjCode) return 'sve';
  const m = { rj_code: rjCode };
  const hit = DEPARTMENTS.find((d) => d.kind === 'machines' && machineMatchesDept(m, d));
  return hit?.slug || 'ostalo';
}

const STATUS_TONE: Record<string, Tone> = {
  waiting: 'neutral',
  in_progress: 'info',
  blocked: 'danger',
  completed: 'success',
};
const STATUS_LABEL: Record<string, string> = {
  waiting: 'Čeka',
  in_progress: 'U radu',
  blocked: 'Blokirano',
  completed: 'Završeno',
};

/** Ciklus klika statusa (waiting→in_progress→blocked→waiting; completed se NE piše ručno). */
export function nextStatus(cur: string | null): 'waiting' | 'in_progress' | 'blocked' {
  if (cur === 'waiting' || cur == null) return 'in_progress';
  if (cur === 'in_progress') return 'blocked';
  return 'waiting';
}

export function StatusPill({ status, onClick, disabled }: { status: string | null; onClick?: () => void; disabled?: boolean }) {
  const s = status ?? 'waiting';
  const tone = STATUS_TONE[s] ?? 'neutral';
  const label = STATUS_LABEL[s] ?? s;
  if (!onClick || disabled) return <StatusBadge tone={tone} label={label} />;
  return (
    <button onClick={onClick} title="Promeni status" className="cursor-pointer">
      <StatusBadge tone={tone} label={label} />
    </button>
  );
}

export function opTitle(o: OpRow): string {
  return `${o.broj_crteza ?? o.naziv_dela ?? '—'}`;
}

/** Kolone/vrednosti sa fallback-om. */
export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function progressLabel(o: OpRow): string {
  const done = num(o.komada_done);
  const total = num(o.komada_total);
  return total ? `${done}/${total}` : '—';
}

export function machineLabel(o: OpRow): string {
  return String(o.effective_machine_code ?? o.assigned_machine_code ?? '—');
}

/**
 * Procena preostalog planiranog tehnološkog vremena u SEKUNDAMA — DOSLOVNI port
 * 1.0 `plannedSeconds` (services/planProizvodnje.js:1482). tpz/tk su u minutama.
 * TPZ se NE računa ako je već prijavljen bar jedan komad (done>0 → setupMin=0),
 * a remaining=0 daje 0 (nema „ili 1" fallback-a — v. GAP-PM-13 tiha laž).
 */
export function plannedSeconds(o: OpRow): number {
  const tpz = num(o.tpz_min);
  const tk = num(o.tk_min);
  const total = num(o.komada_total);
  const done = Math.max(0, num(o.komada_done));
  const remaining = Math.max(0, total - done);
  const setupMin = done > 0 ? 0 : tpz;
  return Math.round((setupMin + tk * remaining) * 60);
}

/** Sekunde → „Xh Ym" (1.0 formatSecondsHm). Prazno/0 = „–". */
export function formatSecondsHm(secs: number | null | undefined): string {
  const s = num(secs);
  if (!s || s <= 0) return '–';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Klasa hitnosti roka — DOSLOVNI port 1.0 `rokUrgencyClass` (planProizvodnje.js:1452).
 *   overdue (<juče) / today / soon (≤3d) / warn (4–7d) / ok (>7d) / '' (nema roka)
 */
export type UrgencyClass = 'overdue' | 'today' | 'soon' | 'warn' | 'ok' | '';
export function rokUrgencyClass(rokIzrade: string | null | undefined): UrgencyClass {
  if (!rokIzrade) return '';
  const now = Date.now();
  const rok = new Date(rokIzrade).getTime();
  if (Number.isNaN(rok)) return '';
  const diffDays = Math.floor((rok - now) / (24 * 3600 * 1000));
  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'today';
  if (diffDays <= 3) return 'soon';
  if (diffDays <= 7) return 'warn';
  return 'ok';
}

/** Tekst boje/pozadine roka po urgency klasi (pill). */
const URGENCY_PILL: Record<Exclude<UrgencyClass, ''>, string> = {
  overdue: 'bg-status-danger-bg text-status-danger',
  today: 'bg-status-warn-bg text-status-warn',
  soon: 'bg-status-warn-bg/60 text-status-warn',
  warn: 'bg-status-info-bg text-status-info',
  ok: 'bg-status-success-bg text-status-success',
};
export function urgencyPillClass(u: UrgencyClass): string {
  return u ? URGENCY_PILL[u] : 'text-ink-secondary';
}

/** Blaga pozadina reda za probijen/današnji rok (⚠ ostaje rezervisan za ručno HITNO). */
export function urgencyRowClass(u: UrgencyClass): string {
  if (u === 'overdue') return 'bg-status-danger-bg/25';
  if (u === 'today') return 'bg-status-warn-bg/25';
  return '';
}

/** Kupac — fallback lanac 1.0: customer_short → customer_name → #id → „—". */
export function customerLabel(o: OpRow): string {
  return (
    (o.customer_short as string | null) ||
    (o.customer_name as string | null) ||
    (o.customer_id != null ? `#${o.customer_id}` : '—')
  );
}

/**
 * Sanitizacija broja crteža — port 1.0 `sanitizeDrawingNo` (services/drawings.js:57).
 * Skida leading/trailing tačke i razmake; pure-dot/garbage („.", „..") → null.
 */
export function sanitizeDrawingNo(broj: unknown): string | null {
  if (broj == null) return null;
  let s = String(broj).trim();
  if (!s) return null;
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) return null;
  if (/^[.\s]*$/.test(s)) return null;
  return s;
}

/**
 * Klijentski „RN ili crtež" filter — DOSLOVNI port 1.0 `operationMatchesRnOrDrawing`
 * (services/planProizvodnje.js:1559). Case-insensitive contains preko rn_ident_broj,
 * ident_broj i broj_crteza. Prazan upit → prolazi sve.
 */
export function operationMatchesRnOrDrawing(o: OpRow, query: string): boolean {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [o.rn_ident_broj, (o as { ident_broj?: unknown }).ident_broj, o.broj_crteza]
    .filter((v) => v != null && v !== '')
    .map((v) => String(v).toLowerCase());
  return haystack.some((v) => v.includes(q));
}

export function filterOpsByRnOrDrawing(rows: OpRow[], query: string): OpRow[] {
  if (!Array.isArray(rows)) return [];
  if (!String(query || '').trim()) return rows;
  return rows.filter((o) => operationMatchesRnOrDrawing(o, query));
}

export function rowClasses(o: OpRow): string {
  const u = rokUrgencyClass(o.rok_izrade);
  return cn(
    o.is_urgent && 'bg-status-danger-bg/40',
    !o.is_urgent && urgencyRowClass(u),
    o.local_status === 'blocked' && 'opacity-70',
  );
}

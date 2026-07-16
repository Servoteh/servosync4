'use client';

import { cn } from '@/lib/cn';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import type { OpRow } from '@/api/plan-proizvodnje';

/** Odeljenja (slug/label) — paritet 1.0 planProizvodnje/departments.js. */
export const DEPARTMENTS: { slug: string; label: string }[] = [
  { slug: 'sve', label: 'Sve' },
  { slug: 'glodanje', label: 'Glodanje' },
  { slug: 'struganje', label: 'Struganje' },
  { slug: 'brusenje', label: 'Brušenje' },
  { slug: 'erodiranje', label: 'Erodiranje' },
  { slug: 'azistiranje', label: 'Ažistiranje' },
  { slug: 'secenje', label: 'Sečenje i savijanje' },
  { slug: 'bravarsko', label: 'Bravarsko' },
  { slug: 'farbanje', label: 'Farbanje i površinska zaštita' },
  { slug: 'cam', label: 'CAM programiranje' },
  { slug: 'ostalo', label: 'Ostalo' },
];

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

export function rowClasses(o: OpRow): string {
  const u = rokUrgencyClass(o.rok_izrade);
  return cn(
    o.is_urgent && 'bg-status-danger-bg/40',
    !o.is_urgent && urgencyRowClass(u),
    o.local_status === 'blocked' && 'opacity-70',
  );
}

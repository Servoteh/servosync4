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

export function rowClasses(o: OpRow): string {
  return cn(o.is_urgent && 'bg-status-danger-bg/40', o.local_status === 'blocked' && 'opacity-70');
}

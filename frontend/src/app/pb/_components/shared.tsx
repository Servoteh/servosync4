'use client';

import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';

// Projektni biro — deljene mape/labeli (paritet 1.0 src/ui/pb/shared.js).

/** Status → ton (1.0 statusBadgeClass): Završeno=ok, Blokirano=danger, U toku/Pregled=warn, Nije počelo=neutral. */
export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'Završeno':
      return 'success';
    case 'Blokirano':
      return 'danger';
    case 'U toku':
    case 'Pregled':
      return 'warn';
    default:
      return 'neutral';
  }
}

/** Prioritet → ton (1.0 prioClass): Visok=high(danger), Srednji=mid(warn), Nizak=low(neutral). */
export function prioTone(prio: string | null | undefined): Tone {
  switch (prio) {
    case 'Visok':
      return 'danger';
    case 'Nizak':
      return 'neutral';
    default:
      return 'warn';
  }
}

export function TaskStatusBadge({ status }: { status: string | null | undefined }) {
  return <StatusBadge tone={statusTone(status)} label={status || '—'} />;
}
export function PrioBadge({ prio }: { prio: string | null | undefined }) {
  return <StatusBadge tone={prioTone(prio)} label={prio || '—'} />;
}

/** dd.MM. (kratko, bez godine — paritet 1.0 datumske ćelije). */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

/** Broj radnih dana (Pon–Pet) između dva datuma, uključivo (paritet 1.0 trajanja). */
export function workDaysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const s = new Date(from);
  const e = new Date(to);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return null;
  let n = 0;
  const cur = new Date(s);
  while (cur <= e) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

/** Napredak bar (procenat 0–100). */
export function ProgressBar({ value }: { value: number | null | undefined }) {
  const pct = Math.max(0, Math.min(100, Number(value ?? 0)));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="tnums text-xs text-ink-secondary">{pct}%</span>
    </div>
  );
}

'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

// Deljeni primitivci Kadrovske (paritet 1.0 renderSummaryChips / kadr-type-badge).

/** Statistička traka (chips) — labela + vrednost. */
export function SummaryChips({ items }: { items: { label: string; value: ReactNode; tone?: 'default' | 'warn' | 'danger' | 'accent' }[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((it, i) => (
        <div
          key={i}
          className={cn(
            'rounded-panel border border-line bg-surface px-3 py-2',
            it.tone === 'danger' && 'border-status-danger/40 bg-status-danger-bg',
            it.tone === 'warn' && 'border-status-warn/40 bg-status-warn-bg',
            it.tone === 'accent' && 'border-accent/40 bg-accent-subtle',
          )}
        >
          <div className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{it.label}</div>
          <div className="tnums mt-0.5 text-lg font-semibold text-ink">{it.value}</div>
        </div>
      ))}
    </div>
  );
}

/** Bezbedan pristup polju snake_case view reda. */
export function sv(row: Record<string, unknown> | null | undefined, key: string): string {
  const v = row?.[key];
  return v == null ? '' : String(v);
}
export function svNum(row: Record<string, unknown> | null | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
}

/** Prikaz decimalnog stringa (Prisma Decimal → string) kao broj bez suvišnih nula. */
export function h1(v: string | number | null | undefined): string {
  const n = Number(v || 0);
  return n ? String(Math.round(n * 100) / 100) : '';
}

/** Osnovno info-polje u dosijeu. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{label}</div>
      <div className="mt-0.5 text-sm text-ink">{children || <span className="text-ink-disabled">—</span>}</div>
    </div>
  );
}

/** Zaključana PII sekcija (nema kadrovska.pii). */
export function LockedNote({ text }: { text: string }) {
  return (
    <div className="rounded-panel border border-dashed border-line bg-surface-2 px-4 py-6 text-center text-sm text-ink-secondary">
      🔒 {text}
    </div>
  );
}

const CYR_MONTHS = ['јануар', 'фебруар', 'март', 'април', 'мај', 'јун', 'јул', 'август', 'септембар', 'октобар', 'новембар', 'децембар'];
/** ćir. naziv meseca + godina. */
export function cyrMonthLabel(year: number, month: number): string {
  return `${CYR_MONTHS[month - 1] ?? ''} ${year}.`;
}

const DAY_LETTERS = ['Н', 'П', 'У', 'С', 'Ч', 'П', 'С']; // Sun..Sat (getDay index)
export function dayLetterCyr(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return DAY_LETTERS[new Date(y, m - 1, d).getDay()] ?? '';
}

/** Broj dana u mesecu + niz YMD. */
export function monthDays(year: number, month: number): { ymd: string; day: number }[] {
  const n = new Date(year, month, 0).getDate();
  const out: { ymd: string; day: number }[] = [];
  for (let d = 1; d <= n; d++) {
    out.push({ ymd: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`, day: d });
  }
  return out;
}

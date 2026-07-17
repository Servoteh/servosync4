'use client';

import { Fragment, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useTasks, type PbTask } from '@/api/projektni-biro';
import { statusTone, shortDate, workDaysBetween } from './shared';
import type { PlanFilters } from './plan-tab';

const TONE_BG: Record<string, string> = {
  success: 'bg-status-success',
  warn: 'bg-status-warn',
  danger: 'bg-status-danger',
  info: 'bg-status-info',
  neutral: 'bg-status-neutral',
};

const WINDOWS = [
  { key: '1', label: 'Mesec', months: 1 },
  { key: '3', label: 'Kvartal', months: 3 },
  { key: '6', label: '6 meseci', months: 6 },
] as const;

export function GanttTab({ filters, onOpenTask }: { filters: PlanFilters; onOpenTask: (id: string | null) => void }) {
  const tasksQ = useTasks({ ...filters, pageSize: 500 });
  const [win, setWin] = useState<'1' | '3' | '6'>('3');
  const [anchor, setAnchor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  // „danas" fiksiran na mount (izbegava hydration mismatch / re-render drift).
  const [todayMs] = useState(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t.getTime();
  });

  const months = WINDOWS.find((w) => w.key === win)!.months;
  const start = anchor;
  const end = useMemo(() => {
    const e = new Date(anchor);
    e.setMonth(e.getMonth() + months);
    return e;
  }, [anchor, months]);
  const spanMs = end.getTime() - start.getTime();

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; rows: PbTask[] }>();
    for (const t of tasksQ.data?.data ?? []) {
      if (t.deleted_at) continue;
      const key = t.employee_id ?? '—';
      const name = t.employee_name ?? 'Bez inženjera';
      if (!map.has(key)) map.set(key, { name, rows: [] });
      map.get(key)!.rows.push(t);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'sr'));
  }, [tasksQ.data]);

  function barStyle(from: string | null, to: string | null): { left: string; width: string } | null {
    if (!from || !to) return null;
    const s = new Date(from).getTime();
    const e = new Date(to).getTime();
    if (Number.isNaN(s) || Number.isNaN(e)) return null;
    const cs = Math.max(s, start.getTime());
    const ce = Math.min(e, end.getTime());
    if (ce < start.getTime() || cs > end.getTime()) return null;
    const left = ((cs - start.getTime()) / spanMs) * 100;
    const width = Math.max(1.5, ((ce - cs) / spanMs) * 100);
    return { left: `${left}%`, width: `${width}%` };
  }

  const monthLabel = start.toLocaleDateString('sr-Latn', { month: 'long', year: 'numeric' });

  // Pozicija „danas" (%) u prozoru — null ako je van [start, end).
  const todayPct = useMemo(() => {
    if (todayMs < start.getTime() || todayMs >= end.getTime()) return null;
    return ((todayMs - start.getTime()) / spanMs) * 100;
  }, [todayMs, start, end, spanMs]);

  function shift(delta: number) {
    setAnchor((a) => {
      const n = new Date(a);
      n.setMonth(n.getMonth() + delta);
      return n;
    });
  }

  function goToday() {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    setAnchor(d);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWin(w.key)}
              className={cn('rounded-control px-2.5 py-1 text-sm', win === w.key ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2')}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => shift(-1)} className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2">
            ←
          </button>
          <span className="min-w-32 text-center text-sm font-medium text-ink">{monthLabel}</span>
          <button onClick={() => shift(1)} className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2">
            →
          </button>
          <button onClick={goToday} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-surface-2" aria-label="Skoči na tekući mesec">
            Danas
          </button>
        </div>
      </div>

      <p className="text-xs text-ink-disabled">
        Legenda: puna traka = plan (boja po statusu), donja traka = ostvareno, crvena vertikala = danas. Prevlačenje datuma stiže naknadno.
      </p>

      {groups.length === 0 ? (
        <EmptyState title="Nema zadataka za prikaz" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.name}>
                  <tr className="bg-surface-2/60">
                    <td colSpan={2} className="px-3 py-1.5 text-xs font-semibold text-ink">
                      {g.name}
                    </td>
                  </tr>
                  {g.rows.map((t) => {
                    const plan = barStyle(t.datum_pocetka_plan, t.datum_zavrsetka_plan);
                    const real = barStyle(t.datum_pocetka_real, t.datum_zavrsetka_real);
                    const tone = TONE_BG[statusTone(t.status)];
                    return (
                      <tr key={t.id} className="border-b border-line-soft">
                        <td className="w-56 max-w-56 px-3 py-2">
                          <button onClick={() => onOpenTask(t.id)} className="truncate text-left text-ink hover:underline">
                            {t.naziv}
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <div
                            className="relative h-6"
                            title={`${t.naziv}\nPlan: ${shortDate(t.datum_pocetka_plan)} → ${shortDate(t.datum_zavrsetka_plan)}\nOstvareno: ${shortDate(
                              t.datum_pocetka_real,
                            )} → ${shortDate(t.datum_zavrsetka_real)}\nTrajanje: ${workDaysBetween(t.datum_pocetka_plan, t.datum_zavrsetka_plan) ?? '—'} rd\nStatus: ${
                              t.status
                            } · ${t.procenat_zavrsenosti ?? 0}%`}
                          >
                            {plan ? (
                              <div className={cn('absolute top-0 h-3 rounded', tone)} style={plan}>
                                <div className="h-full rounded bg-black/20" style={{ width: `${t.procenat_zavrsenosti ?? 0}%` }} />
                              </div>
                            ) : (
                              <span className="text-2xs text-ink-disabled">van prozora</span>
                            )}
                            {real && <div className="absolute top-3.5 h-2 rounded bg-ink/40" style={real} />}
                            {todayPct !== null && (
                              <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-status-danger/60" style={{ left: `${todayPct}%` }} aria-hidden />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

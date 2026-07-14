'use client';

import { useMemo } from 'react';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import type { PmProjectTree } from '@/api/plan-montaze';
import { locationColor, statusLabel } from './phase-util';

interface Bar {
  id: string;
  group: string;
  label: string;
  sub: string;
  start: Date;
  end: Date;
  color: string;
  pct: number;
  status: number;
}

const DAY = 86_400_000;

function toDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(`${s.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildBars(projects: PmProjectTree[]): Bar[] {
  const bars: Bar[] = [];
  for (const p of projects) {
    for (const w of p.workPackages) {
      for (const ph of w.phases) {
        const start = toDate(ph.startDate);
        const end = toDate(ph.endDate) ?? start;
        if (!start || !end) continue;
        bars.push({
          id: ph.id,
          group: `${p.project_code} · ${w.rnCode || w.name}`,
          label: ph.phaseName,
          sub: `${statusLabel(ph.status)} · ${ph.pct ?? 0}%${ph.montageLead ? ` · ${ph.montageLead}` : ''}`,
          start,
          end: end < start ? start : end,
          color: locationColor(ph.location),
          pct: ph.pct ?? 0,
          status: ph.status ?? 0,
        });
      }
    }
  }
  return bars;
}

/**
 * Gantt — vremenske trake faza (boje po lokaciji, today-marker). Read pogled sa
 * mesečnim mrežama. `mode='single'` = jedan projekat, `mode='total'` = svi.
 * (Drag/resize iz 1.0 = FE follow-up; ovde pun read paritet.)
 */
export function GanttView({ projects, mode }: { projects: PmProjectTree[]; mode: 'single' | 'total' }) {
  const bars = useMemo(() => buildBars(projects), [projects]);

  const range = useMemo(() => {
    if (!bars.length) return null;
    let min = bars[0].start.getTime();
    let max = bars[0].end.getTime();
    for (const b of bars) {
      min = Math.min(min, b.start.getTime());
      max = Math.max(max, b.end.getTime());
    }
    const today = Date.now();
    min = Math.min(min, today);
    max = Math.max(max, today);
    // pad 3 dana sa svake strane
    return { min: min - 3 * DAY, max: max + 3 * DAY };
  }, [bars]);

  if (!bars.length) {
    return <EmptyState title="Nema faza sa datumima" hint="Postavi plan-datume faza da bi se prikazale na Gantu." />;
  }

  const span = range!.max - range!.min;
  const pctOf = (t: number) => ((t - range!.min) / span) * 100;

  // Mesečne granice za mrežu.
  const months: { left: number; label: string }[] = [];
  const cur = new Date(range!.min);
  cur.setDate(1);
  cur.setHours(0, 0, 0, 0);
  while (cur.getTime() <= range!.max) {
    months.push({
      left: pctOf(cur.getTime()),
      label: cur.toLocaleDateString('sr-RS', { month: 'short', year: '2-digit' }),
    });
    cur.setMonth(cur.getMonth() + 1);
  }

  const todayLeft = pctOf(Date.now());
  const grouped = new Map<string, Bar[]>();
  for (const b of bars) {
    const arr = grouped.get(b.group) ?? [];
    arr.push(b);
    grouped.set(b.group, arr);
  }

  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <div className="min-w-[760px]">
        {/* Mesečna traka */}
        <div className="relative h-7 border-b border-line bg-surface-2">
          <div className="absolute inset-y-0 left-[220px] right-0">
            {months.map((m) => (
              <div
                key={m.label + m.left}
                className="absolute top-0 flex h-full items-center border-l border-line-soft pl-1 text-2xs text-ink-secondary"
                style={{ left: `${m.left}%` }}
              >
                {m.label}
              </div>
            ))}
            <div className="absolute inset-y-0 w-px bg-status-danger" style={{ left: `${todayLeft}%` }} title="Danas" />
          </div>
        </div>

        {[...grouped.entries()].map(([group, rows]) => (
          <div key={group}>
            {mode === 'total' && (
              <div className="border-b border-line-soft bg-surface-2/40 px-3 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">
                {group}
              </div>
            )}
            {rows.map((b) => (
              <div key={b.id} className="relative flex h-9 items-center border-b border-line-soft hover:bg-surface-2">
                <div className="w-[220px] shrink-0 truncate px-3 text-sm text-ink" title={b.label}>
                  {b.label}
                </div>
                <div className="relative h-full flex-1">
                  {/* danas linija */}
                  <div className="absolute inset-y-0 w-px bg-status-danger/50" style={{ left: `${todayLeft}%` }} />
                  <div
                    className="absolute top-1/2 -translate-y-1/2 rounded-control text-2xs text-white shadow-sm"
                    style={{
                      left: `${pctOf(b.start.getTime())}%`,
                      width: `${Math.max(pctOf(b.end.getTime()) - pctOf(b.start.getTime()), 0.6)}%`,
                      background: b.color,
                    }}
                    title={`${b.label}\n${formatDate(b.start.toISOString())} – ${formatDate(b.end.toISOString())}\n${b.sub}`}
                  >
                    <div
                      className={cn('h-5 rounded-control', b.status === 2 && 'ring-2 ring-inset ring-white/60')}
                    >
                      <div
                        className="h-full rounded-l-control bg-black/20"
                        style={{ width: `${b.pct}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

'use client';

import { useMemo } from 'react';
import { useAllOperations } from '@/api/plan-proizvodnje';
import { plannedSeconds } from './shared';

/** Zauzetost mašina — agregat broja operacija + preostalih minuta po mašini. */
export function ZauzetostTab() {
  const q = useAllOperations();
  const ops = q.data?.data ?? [];

  const rows = useMemo(() => {
    const map = new Map<string, { machine: string; count: number; minutes: number }>();
    for (const o of ops) {
      const m = String(o.effective_machine_code ?? '—');
      const rec = map.get(m) ?? { machine: m, count: 0, minutes: 0 };
      rec.count += 1;
      // Kanon 1.0: TPZ preskočen ako done>0, remaining=0 → 0 doprinos (plannedSeconds sekunde → minuti).
      rec.minutes += plannedSeconds(o) / 60;
      map.set(m, rec);
    }
    return [...map.values()].sort((a, b) => b.minutes - a.minutes);
  }, [ops]);

  const maxMin = rows.reduce((mx, r) => Math.max(mx, r.minutes), 1);

  return (
    <div className="space-y-3">
      <div className="text-sm text-ink-secondary">
        {q.data?.meta?.truncated ? `Prikazano ${q.data.meta.limit} (skraćeno od ${q.data.meta.total})` : `${ops.length} operacija`}
      </div>
      {q.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="px-3 py-1.5">Mašina</th>
                <th className="px-3 py-1.5">Operacija</th>
                <th className="px-3 py-1.5">Opterećenje (min)</th>
                <th className="px-3 py-1.5">Zauzetost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.machine} className="border-b border-line-soft hover:bg-surface-2">
                  <td className="px-3 py-1.5 font-medium text-ink">{r.machine}</td>
                  <td className="tnums px-3 py-1.5">{r.count}</td>
                  <td className="tnums px-3 py-1.5">{Math.round(r.minutes)}</td>
                  <td className="px-3 py-1.5">
                    <div className="h-2 w-40 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${(r.minutes / maxMin) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

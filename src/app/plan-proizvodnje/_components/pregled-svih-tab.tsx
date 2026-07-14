'use client';

import { useMemo } from 'react';
import { useAllOperations, type OpRow } from '@/api/plan-proizvodnje';

/** Sledećih 5 radnih dana (preskače vikend). */
function workingDays(n: number): Date[] {
  const out: Date[] = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (out.length < n) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function dayKey(d: Date | string): string {
  return (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);
}

/** Pregled svih — matrica mašina × 5 radnih dana (raspored po roku izrade). */
export function PregledSvihTab() {
  const q = useAllOperations();
  const ops = q.data?.data ?? [];
  const days = useMemo(() => workingDays(5), []);
  const todayKey = dayKey(new Date());

  const { machines, grid } = useMemo(() => {
    const dayKeys = new Set(days.map(dayKey));
    const grid = new Map<string, Map<string, OpRow[]>>(); // machine → bucket → ops
    const machinesSet = new Set<string>();
    for (const o of ops) {
      const m = String(o.effective_machine_code ?? '—');
      machinesSet.add(m);
      const rok = o.rok_izrade ? dayKey(o.rok_izrade) : null;
      let bucket: string;
      if (rok && dayKeys.has(rok)) bucket = rok;
      else if (rok && rok < todayKey) bucket = 'kasni';
      else bucket = 'ostalo';
      const byBucket = grid.get(m) ?? new Map<string, OpRow[]>();
      const arr = byBucket.get(bucket) ?? [];
      arr.push(o);
      byBucket.set(bucket, arr);
      grid.set(m, byBucket);
    }
    return { machines: [...machinesSet].sort(), grid };
  }, [ops, days, todayKey]);

  return (
    <div className="space-y-3">
      <div className="text-sm text-ink-secondary">{ops.length} operacija · {machines.length} mašina</div>
      {q.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="px-3 py-1.5">Mašina</th>
                <th className="px-3 py-1.5 text-status-danger">Kasni</th>
                {days.map((d) => (
                  <th key={dayKey(d)} className="px-3 py-1.5">
                    {d.toLocaleDateString('sr-RS', { weekday: 'short', day: '2-digit', month: '2-digit' })}
                  </th>
                ))}
                <th className="px-3 py-1.5">Ostalo</th>
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => {
                const b = grid.get(m);
                const cell = (key: string) => b?.get(key)?.length ?? 0;
                return (
                  <tr key={m} className="border-b border-line-soft hover:bg-surface-2">
                    <td className="px-3 py-1.5 font-medium text-ink">{m}</td>
                    <td className="tnums px-3 py-1.5 text-status-danger">{cell('kasni') || ''}</td>
                    {days.map((d) => (
                      <td key={dayKey(d)} className="tnums px-3 py-1.5">
                        {cell(dayKey(d)) || ''}
                      </td>
                    ))}
                    <td className="tnums px-3 py-1.5 text-ink-secondary">{cell('ostalo') || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

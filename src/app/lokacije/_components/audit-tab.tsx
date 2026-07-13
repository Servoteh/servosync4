'use client';

import { useMemo } from 'react';
import { useDefinitionsAudit } from '@/api/lokacije';
import { tableEmpty } from './common';

/** Istorija definicija (loc_locations_audit, manage). Kolone su dinamičke iz reda. */
export function AuditTab() {
  const q = useDefinitionsAudit(150);
  const rows = q.data?.data ?? [];

  const cols = useMemo(() => {
    if (rows.length === 0) return [];
    return Object.keys(rows[0]);
  }, [rows]);

  const fmt = (v: unknown): string => {
    if (v == null) return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };

  if (q.isLoading) return <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>;
  if (rows.length === 0) return tableEmpty(q.isError, 'Nema zapisa', 'Nema zabeleženih izmena definicija lokacija.');

  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left">
            {cols.map((c) => (
              <th key={c} className="h-9 whitespace-nowrap px-3 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line-soft hover:bg-surface-2">
              {cols.map((c) => (
                <td key={c} className="whitespace-nowrap px-3 py-1.5 text-ink">{fmt((r as Record<string, unknown>)[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

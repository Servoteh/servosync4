'use client';

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { useDashboard, useMachines, type MachineRow } from '@/api/odrzavanje';
import { ASSET_TYPE_LABEL, fnum, OpStatusBadge, StatCard, tableEmpty } from './common';

/** Pregled (dashboard): KPI + kategorije + prioritetna lista mašina + „Moje". */
export function PregledTab({ onOpenMachine }: { onOpenMachine: (code: string) => void }) {
  const dash = useDashboard();
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const machines = useMachines({ mine, q, pageSize: 200 });

  const d = dash.data?.data;
  const summary = d?.dailySummary ?? {};

  const catCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of d?.categoryCounts ?? []) m[c.asset_type] = c.n;
    return m;
  }, [d]);

  const rows = machines.data?.data ?? [];

  const cols: Column<MachineRow>[] = [
    { key: 'code', header: 'Šifra', render: (r) => <span className="tnums font-medium">{r.machineCode}</span> },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
    { key: 'loc', header: 'Lokacija', render: (r) => <span className="text-ink-secondary">{r.location ?? '—'}</span> },
    { key: 'resp', header: 'Odgovoran', render: (r) => <span className="text-ink-secondary">{r.responsibleName ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <OpStatusBadge status={r.effectiveStatus} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Otvoreni kvarovi" value={d?.openIncidents ?? '—'} tone="danger" />
        <StatCard label="Otvoreni nalozi" value={d?.openWorkOrders ?? '—'} tone="warn" />
        <StatCard label="Kritični kvarovi" value={num(summary, 'open_critical_incidents')} tone="danger" />
        <StatCard label="Kasne preventive" value={num(summary, 'overdue_preventive_tasks')} tone="warn" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['machine', 'vehicle', 'it', 'facility'] as const).map((t) => (
          <div key={t} className="rounded-panel border border-line bg-surface px-4 py-3">
            <div className="tnums text-xl font-semibold text-ink">{catCount[t] ?? 0}</div>
            <div className="text-xs text-ink-secondary">{ASSET_TYPE_LABEL[t]}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-md font-semibold text-ink">Mašine po statusu</h2>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
            Moje mašine
          </label>
          <SearchBox value={q} onChange={setQ} placeholder="Šifra, naziv, proizvođač…" />
        </div>
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.machineCode}
        loading={machines.isLoading}
        onRowActivate={(r) => onOpenMachine(r.machineCode)}
        empty={tableEmpty(machines.isError, 'Nema mašina', mine ? 'Nemate dodeljenih mašina.' : 'Nijedna mašina ne odgovara pretrazi.')}
      />
    </div>
  );
}

function num(summary: Record<string, number>, ...keys: string[]): number {
  return fnum(summary as Record<string, unknown>, ...keys) ?? 0;
}

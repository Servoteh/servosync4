'use client';

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useReversiMachines, type MachineRow } from '@/api/reversi';
import { tableEmpty } from './common';
import { MachineCardDialog } from './machine-card-dialog';

/**
 * Mašine u Reversi kontekstu (v_rev_machines nad maint_machines — 1.0 revMasineTab).
 * Lista sa pretragom + „Samo aktivne" (RB-52) i agregatima reznog alata / glava po
 * mašini (RB-53, BE ih vraća u jednom pozivu). Klik na red → kartica mašine.
 */
export function MasineTab() {
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [openMachine, setOpenMachine] = useState<MachineRow | null>(null);
  const machines = useReversiMachines();

  const rows = useMemo(() => {
    let all = machines.data?.data ?? [];
    if (onlyActive) all = all.filter((m) => !m.archived_at);
    if (!q.trim()) return all;
    const t = q.trim().toLowerCase();
    return all.filter((m) =>
      [m.machine_code, m.name, m.type, m.manufacturer, m.model, m.location]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t)),
    );
  }, [machines.data, q, onlyActive]);

  const cols: Column<MachineRow>[] = [
    {
      key: 'code',
      header: 'Šifra',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          <span className="tnums font-medium">{r.machine_code}</span>
          {r.archived_at && <StatusBadge tone="neutral" label="arhivirana" />}
        </span>
      ),
    },
    { key: 'name', header: 'Naziv', render: (r) => r.name || '—' },
    { key: 'type', header: 'Tip', render: (r) => <span className="text-ink-secondary">{r.type ?? '—'}</span> },
    { key: 'mfg', header: 'Proizvođač', render: (r) => <span className="text-ink-secondary">{r.manufacturer ?? '—'}</span> },
    { key: 'loc', header: 'Lokacija', render: (r) => <span className="text-ink-secondary">{r.location ?? '—'}</span> },
    {
      key: 'rezni',
      header: 'Rezni alat',
      align: 'right',
      numeric: true,
      render: (r) =>
        r.cuttingToolSkus > 0 ? (
          <span>
            <strong>{r.cuttingToolSkus}</strong>{' '}
            <span className="text-ink-secondary">({r.cuttingToolQty} kom)</span>
          </span>
        ) : (
          <span className="text-ink-secondary">—</span>
        ),
    },
    {
      key: 'glave',
      header: 'Glave',
      align: 'right',
      numeric: true,
      render: (r) => (r.headsCount > 0 ? <strong>{r.headsCount}</strong> : <span className="text-ink-secondary">—</span>),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox value={q} onChange={setQ} placeholder="Pretraga mašina (šifra / naziv)…" />
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          <span>Samo aktivne</span>
        </label>
        <span className="ml-auto whitespace-nowrap text-sm text-ink-secondary">
          Ukupno: <strong className="text-ink">{rows.length}</strong>
        </span>
      </div>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.machine_code}
        loading={machines.isLoading}
        onRowActivate={(r) => setOpenMachine(r)}
        empty={tableEmpty(
          machines.isError,
          'Nema mašina u katalogu',
          'Katalog se uređuje u Podešavanja → Mašine.',
        )}
      />
      <p className="text-xs text-ink-secondary">
        Klik na mašinu otvara karticu (rezni alat, glave, istorija). Podaci mašine se uređuju u Podešavanja → Mašine.
      </p>
      <MachineCardDialog machine={openMachine} onClose={() => setOpenMachine(null)} />
    </div>
  );
}

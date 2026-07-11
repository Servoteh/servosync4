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
 * V1 = pregled/pretraga; kartica mašine (rezni alat na njoj, glave, istorija)
 * stiže kad rezni alat dobije podatke (katalog je danas prazan).
 */
export function MasineTab() {
  const [q, setQ] = useState('');
  const [openMachine, setOpenMachine] = useState<MachineRow | null>(null);
  const machines = useReversiMachines();

  const rows = useMemo(() => {
    const all = (machines.data?.data ?? []).filter((m) => !m.archived_at);
    if (!q.trim()) return all;
    const t = q.trim().toLowerCase();
    return all.filter((m) =>
      [m.machine_code, m.name, m.type, m.manufacturer, m.model, m.location]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t)),
    );
  }, [machines.data, q]);

  const cols: Column<MachineRow>[] = [
    { key: 'code', header: 'Šifra', render: (r) => <span className="tnums font-medium">{r.machine_code}</span> },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
    { key: 'type', header: 'Tip', render: (r) => <span className="text-ink-secondary">{r.type ?? '—'}</span> },
    {
      key: 'mfg',
      header: 'Proizvođač / model',
      render: (r) => (
        <span className="text-ink-secondary">
          {[r.manufacturer, r.model].filter(Boolean).join(' / ') || '—'}
        </span>
      ),
    },
    { key: 'loc', header: 'Lokacija', render: (r) => <span className="text-ink-secondary">{r.location ?? '—'}</span> },
    {
      key: 'tracked',
      header: 'Praćenje',
      render: (r) =>
        r.tracked ? <StatusBadge tone="success" label="Prati se" /> : <StatusBadge tone="neutral" label="Ne prati se" />,
    },
  ];

  return (
    <div className="space-y-3">
      <SearchBox value={q} onChange={setQ} placeholder="Šifra, naziv, tip, proizvođač…" />
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.machine_code}
        loading={machines.isLoading}
        onRowActivate={(r) => setOpenMachine(r)}
        empty={tableEmpty(machines.isError, 'Nema mašina', 'Nijedna mašina ne odgovara pretrazi.')}
      />
      <MachineCardDialog machine={openMachine} onClose={() => setOpenMachine(null)} />
    </div>
  );
}

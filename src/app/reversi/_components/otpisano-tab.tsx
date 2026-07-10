'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate, formatNumber } from '@/lib/format';
import { useScrapped, type ScrappedRow } from '@/api/reversi';
import { ToolDetailDialog } from './tool-detail-dialog';

/** Otpisan/izgubljen alat (v_rev_otpisani_alat — manage-only, paritet 1.0 reversiScrappedTab). */
export function OtpisanoTab() {
  const scrapped = useScrapped(true);
  const [toolId, setToolId] = useState<string | null>(null);

  const cols: Column<ScrappedRow>[] = [
    { key: 'oznaka', header: 'Oznaka', render: (r) => <span className="font-medium">{r.oznaka}</span> },
    { key: 'naziv', header: 'Naziv', render: (r) => r.naziv },
    { key: 'sn', header: 'Ser. broj', render: (r) => <span className="text-ink-secondary">{r.serijski_broj ?? '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.status === 'lost' ? (
          <StatusBadge tone="warn" label="Izgubljen" />
        ) : (
          <StatusBadge tone="danger" label="Otpisan" />
        ),
    },
    { key: 'datum', header: 'Datum otpisa', render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.otpis_datum)}</span> },
    { key: 'razlog', header: 'Razlog', render: (r) => <span className="text-ink-secondary">{r.otpis_razlog ?? '—'}</span> },
    {
      key: 'servis',
      header: 'Servisi (trošak)',
      align: 'right',
      numeric: true,
      render: (r) =>
        r.broj_servisa ? `${r.broj_servisa}× (${formatNumber(Number(r.ukupan_servis_trosak ?? 0))})` : '—',
    },
  ];

  return (
    <>
      <DataTable
        columns={cols}
        rows={scrapped.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={scrapped.isLoading}
        onRowActivate={(r) => setToolId(r.id)}
        empty={<EmptyState title="Nema otpisanog alata" hint="Nijedan alat nije otpisan ni izgubljen." />}
      />
      <ToolDetailDialog toolId={toolId} onClose={() => setToolId(null)} />
    </>
  );
}

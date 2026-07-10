'use client';

import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate, formatNumber } from '@/lib/format';
import { useMyConsumed, useMyIssuedTools, type MyConsumedRow, type MyIssuedRow } from '@/api/reversi';
import { DocStatusBadge } from './common';

/** Self-service „Moji alati" — izdato na mene + potrošeno (paritet 1.0 mojaZaduzenja). */
export function MojiAlatiTab() {
  const issued = useMyIssuedTools();
  const consumed = useMyConsumed();

  const issuedCols: Column<MyIssuedRow>[] = [
    { key: 'oznaka', header: 'Oznaka', render: (r) => <span className="font-medium">{r.oznaka}</span> },
    { key: 'naziv', header: 'Naziv', render: (r) => r.naziv },
    { key: 'sn', header: 'Ser. broj', render: (r) => <span className="text-ink-secondary">{r.serijski_broj ?? '—'}</span> },
    { key: 'qty', header: 'Kol.', align: 'right', numeric: true, render: (r) => `${formatNumber(Number(r.quantity))} ${r.unit}` },
    { key: 'doc', header: 'Revers', render: (r) => <span className="tnums text-ink-secondary">{r.doc_number}</span> },
    { key: 'issued', header: 'Izdato', render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.issued_at)}</span> },
    { key: 'status', header: 'Status', render: (r) => <DocStatusBadge status={r.document_status} /> },
  ];

  const consumedCols: Column<MyConsumedRow>[] = [
    { key: 'oznaka', header: 'Oznaka', render: (r) => <span className="font-medium">{r.oznaka}</span> },
    { key: 'naziv', header: 'Naziv', render: (r) => r.naziv },
    { key: 'qty', header: 'Kol.', align: 'right', numeric: true, render: (r) => formatNumber(Math.abs(Number(r.quantity))) },
    { key: 'at', header: 'Potrošeno', render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.consumed_at)}</span> },
    { key: 'doc', header: 'Revers', render: (r) => <span className="tnums text-ink-secondary">{r.doc_number ?? '—'}</span> },
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Zaduženo na mene</h2>
        <DataTable
          columns={issuedCols}
          rows={issued.data?.data ?? []}
          rowKey={(r) => `${r.document_id}-${r.oznaka}-${r.serijski_broj ?? ''}`}
          loading={issued.isLoading}
          empty={<EmptyState title="Nema zaduženja" hint="Trenutno nemaš zadužen alat ni opremu." />}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Potrošeno (potrošni materijal)</h2>
        <DataTable
          columns={consumedCols}
          rows={consumed.data?.data ?? []}
          rowKey={(r) => r.ledger_id}
          loading={consumed.isLoading}
          empty={<EmptyState title="Nema potrošnje" hint="Nema evidentirane potrošnje na tvoje ime." />}
        />
      </section>
    </div>
  );
}

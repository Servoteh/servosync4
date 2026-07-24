'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate } from '@/lib/format';
import {
  useSupplierRfqs,
  type SupplierRfqListRow,
  type SupplierRfqDetail,
} from '@/api/nabavka';
import { RfqDetailDialog } from './rfq-detail-dialog';
import { AcceptQuoteDialog } from './accept-quote-dialog';

/**
 * Upiti (RFQ) — pregled poslatih upita dobavljacima (dosad se SupplierRfq nije
 * video kroz UI; poslati upiti su nestajali). Lista sa status-mapom; klik na red
 * otvara detalj (panel/dijalog), odakle se ponuda prihvata (AcceptQuoteDialog).
 * Prihvatanje ne kreira narudzbenicu automatski — nudi je kao sledeci korak.
 * Data iskljucivo kroz `@/api/nabavka` hook-ove; sve od kit komponenti i tokena.
 */

/** RFQ status -> { tone, label } nad postojecim tonovima kanonske mape (§7). */
export function rfqStatusMeta(status: string): { tone: Tone; label: string } {
  switch (status) {
    case 'DRAFT':
      return { tone: 'neutral', label: 'U pripremi' };
    case 'SENT':
      return { tone: 'info', label: 'Poslato' };
    case 'QUOTED':
      return { tone: 'success', label: 'Prihvaceno' };
    case 'CLOSED':
      return { tone: 'success', label: 'Zatvoreno' };
    default:
      return { tone: 'neutral', label: status };
  }
}

export function RfqPanel() {
  const query = useSupplierRfqs({});
  const rows = query.data?.data ?? [];

  const [detailId, setDetailId] = useState<number | null>(null);
  // Prihvatanje se otvara sa DETALJEM (u memoriji) da bi createOrderDraft imao
  // cene odmah po prihvatanju (sema ih ne cuva na upitu).
  const [acceptRfq, setAcceptRfq] = useState<SupplierRfqDetail | null>(null);

  const columns: Column<SupplierRfqListRow>[] = [
    {
      key: 'rfqNumber',
      header: 'Broj upita',
      render: (r) => <span className="tnums font-semibold text-ink">{r.rfqNumber}</span>,
    },
    {
      key: 'supplier',
      header: 'Dobavljac',
      render: (r) => (
        <span className="text-ink">
          {r.supplierName ?? <span className="tnums text-ink-secondary">#{r.supplierId}</span>}
        </span>
      ),
    },
    {
      key: 'date',
      header: 'Datum',
      render: (r) => (
        <span className="text-ink-secondary">{formatDate(r.sentAt ?? r.createdAt)}</span>
      ),
    },
    {
      key: 'items',
      header: 'Stavke',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">{r._count.items}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const m = rfqStatusMeta(r.status);
        return <StatusBadge tone={m.tone} label={m.label} />;
      },
    },
  ];

  return (
    <section className="space-y-3">
      <h2 className="text-md font-semibold text-ink">Upiti (RFQ)</h2>

      {query.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-2 text-sm text-status-danger">
          {(query.error as Error).message}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowActivate={(r) => setDetailId(r.id)}
        loading={query.isLoading}
        empty={
          <EmptyState
            title="Nema upita dobavljacima"
            hint="Upiti nastaju slanjem iz odobrenog zahteva (Posalji upit dobavljacu); ovde se pregledaju i prihvataju ponude."
          />
        }
      />

      {detailId != null && (
        <RfqDetailDialog
          id={detailId}
          onClose={() => setDetailId(null)}
          onAccept={(rfq) => {
            setDetailId(null);
            setAcceptRfq(rfq);
          }}
        />
      )}

      {acceptRfq && (
        <AcceptQuoteDialog rfq={acceptRfq} onClose={() => setAcceptRfq(null)} />
      )}
    </section>
  );
}

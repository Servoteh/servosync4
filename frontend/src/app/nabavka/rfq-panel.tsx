'use client';

import { useState } from 'react';
import { Printer } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { formatDate } from '@/lib/format';
import {
  useSupplierRfqs,
  useRfqPdf,
  openPdf,
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

  // Štampa upita (PDF). Servis je postojao od pocetka, ali samo kao prilog
  // auto-mailu — bez ovog dugmeta upit se nije mogao odstampati iz aplikacije.
  const rfqPdf = useRfqPdf();
  const [printError, setPrintError] = useState<string | null>(null);
  async function onPrint(id: number): Promise<void> {
    setPrintError(null);
    try {
      openPdf(await rfqPdf.mutateAsync({ id }));
    } catch (e) {
      setPrintError((e as Error).message);
    }
  }

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
    {
      key: 'akcije',
      header: '',
      align: 'right',
      render: (r) => (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            title="Štampa upita za ponudu (PDF)"
            loading={rfqPdf.isPending && rfqPdf.variables?.id === r.id}
            onClick={(e) => {
              e.stopPropagation();
              void onPrint(r.id);
            }}
          >
            <Printer className="h-4 w-4" aria-hidden />
            Štampa
          </Button>
        </div>
      ),
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

      {printError && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-2 text-sm text-status-danger">
          Štampa nije uspela: {printError}
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

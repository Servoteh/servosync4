'use client';

import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useSupplierRfq,
  SUPPLIER_RFQ_STATUS,
  type SupplierRfqDetail,
  type SupplierRfqItem,
} from '@/api/nabavka';
import { rfqStatusMeta } from './rfq-panel';

/**
 * Detalj upita dobavljacu (DESIGN_SYSTEM §4 obrazac Master-detalj u dijalogu):
 * zaglavlje (label-vrednost) + tabela stavki. Ako upit jos nije prihvacen
 * (DRAFT/SENT), nudi Prihvati ponudu (otvara AcceptQuoteDialog). Ako je vec
 * prihvacen (QUOTED/CLOSED), stavke prikazuju rok isporuke + oznaku prihvaceno.
 * Data kroz `useSupplierRfq`.
 */
const itemColumns: Column<SupplierRfqItem>[] = [
  {
    key: 'lineNo',
    header: 'R.br.',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink-secondary">{it.lineNo}</span>,
  },
  {
    key: 'description',
    header: 'Opis / artikal',
    render: (it) => (
      <span className="text-ink">
        {it.description ?? (it.articleId != null ? `Artikal #${it.articleId}` : '—')}
      </span>
    ),
  },
  {
    key: 'quantity',
    header: 'Kolicina',
    align: 'right',
    numeric: true,
    render: (it) => (
      <span className="tnums text-ink">
        {formatDecimal(it.quantity, 4)}
        {it.unit ? ` ${it.unit}` : ''}
      </span>
    ),
  },
  {
    key: 'lead',
    header: 'Rok (dana)',
    align: 'right',
    numeric: true,
    render: (it) => (
      <span className="tnums text-ink-secondary">{it.offeredLeadTimeDays ?? '—'}</span>
    ),
  },
  {
    key: 'accepted',
    header: 'Ponuda',
    render: (it) =>
      it.isAccepted ? (
        <StatusBadge tone="success" label="Prihvaceno" />
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
];

export function RfqDetailDialog({
  id,
  onClose,
  onAccept,
}: {
  id: number;
  onClose: () => void;
  onAccept: (rfq: SupplierRfqDetail) => void;
}) {
  const query = useSupplierRfq(id);
  const rfq = query.data?.data ?? null;
  const canAccept =
    rfq != null &&
    rfq.status !== SUPPLIER_RFQ_STATUS.QUOTED &&
    rfq.status !== SUPPLIER_RFQ_STATUS.CLOSED;

  return (
    <Dialog
      open
      onClose={onClose}
      title={rfq ? `Upit ${rfq.rfqNumber}` : 'Upit dobavljacu'}
      size="xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Zatvori
          </Button>
          {canAccept && rfq && (
            <Button onClick={() => onAccept(rfq)}>Prihvati ponudu</Button>
          )}
        </div>
      }
    >
      {query.isLoading ? (
        <div className="grid place-items-center py-12 text-sm text-ink-secondary">
          Ucitavanje…
        </div>
      ) : query.error ? (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(query.error as Error).message}
        </div>
      ) : !rfq ? (
        <EmptyState title="Upit nije pronadjen" hint="Upit je mozda obrisan." />
      ) : (
        <div className="space-y-4">
          <section className="rounded-panel border border-line bg-surface p-4">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Broj upita">
                <span className="tnums font-semibold text-ink">{rfq.rfqNumber}</span>
              </Field>
              <Field label="Status">
                {(() => {
                  const m = rfqStatusMeta(rfq.status);
                  return <StatusBadge tone={m.tone} label={m.label} />;
                })()}
              </Field>
              <Field label="Dobavljac">
                <span className="text-ink">
                  {rfq.supplier?.name ?? `#${rfq.supplierId}`}
                </span>
              </Field>
              <Field label="Datum">
                <span className="text-ink">{formatDate(rfq.createdAt)}</span>
              </Field>
              <Field label="Poslato">
                <span className="text-ink">{rfq.sentAt ? formatDate(rfq.sentAt) : '—'}</span>
              </Field>
              <Field label="Broj stavki">
                <span className="tnums text-ink">{rfq.items.length}</span>
              </Field>
            </dl>
            {rfq.note && (
              <div className="mt-3 border-t border-line-soft pt-3">
                <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  Napomena
                </dt>
                <dd className="mt-1 whitespace-pre-wrap text-sm text-ink">{rfq.note}</dd>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-md font-semibold text-ink">Stavke</h3>
            <DataTable
              columns={itemColumns}
              rows={rfq.items}
              rowKey={(it) => it.id}
              empty={<EmptyState title="Upit nema stavki" hint="" />}
            />
          </section>
        </div>
      )}
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

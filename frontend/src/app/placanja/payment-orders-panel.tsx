'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Select } from '@/components/ui-kit/select';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  usePaymentOrders,
  useSignPaymentOrder,
  usePayPaymentOrder,
  useSignPaymentOrdersBatch,
  PAYMENT_ORDER_STATUS,
  type PaymentOrderRow,
  type PaymentOrderStatus,
} from '@/api/placanja';

/**
 * Pregled kreiranih naloga za plaćanje (BigBit paritet — bez ovoga refresh gubi naloge).
 * Filter po statusu, masovni potpis (PotpisiVirmane), pojedinačni potpis/plaćanje.
 * Životni ciklus: CREATED → (potpiši) → SIGNED → (izvezi u banku = PAID). Sve kroz
 * `@/api/placanja` hooks; kit komponente + tokeni.
 */
function orderStatusMeta(status: PaymentOrderStatus): { tone: Tone; label: string } {
  switch (status) {
    case PAYMENT_ORDER_STATUS.CREATED:
      return { tone: 'warn', label: 'Kreiran' };
    case PAYMENT_ORDER_STATUS.SIGNED:
      return { tone: 'info', label: 'Potpisan' };
    case PAYMENT_ORDER_STATUS.PAID:
      return { tone: 'success', label: 'Plaćen' };
    default:
      return { tone: 'neutral', label: status };
  }
}

export function PaymentOrdersPanel() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const query = usePaymentOrders(statusFilter ? { status: statusFilter } : {});
  const rows = query.data?.data ?? [];

  const sign = useSignPaymentOrder();
  const pay = usePayPaymentOrder();
  const signBatch = useSignPaymentOrdersBatch();

  const createdIds = rows
    .filter((o) => o.status === PAYMENT_ORDER_STATUS.CREATED)
    .map((o) => o.id);

  const columns: Column<PaymentOrderRow>[] = [
    {
      key: 'orderNumber',
      header: 'Broj',
      render: (o) => <span className="tnums text-ink">{o.orderNumber}</span>,
    },
    {
      key: 'supplierId',
      header: 'Dobavljač',
      render: (o) => (
        <div className="min-w-0">
          <div className="tnums text-ink-secondary">#{o.supplierId}</div>
          <div className="tnums text-2xs text-ink-secondary">{o.supplierAccount ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Iznos',
      align: 'right',
      numeric: true,
      render: (o) => (
        <span className="tnums text-ink">
          {formatDecimal(o.amount)} {o.currency}
        </span>
      ),
    },
    {
      key: 'referenceNumberCredit',
      header: 'Poziv na broj',
      render: (o) => (
        <span className="tnums text-ink-secondary">{o.referenceNumberCredit ?? '—'}</span>
      ),
    },
    {
      key: 'dueDate',
      header: 'Dospeće',
      render: (o) => (
        <span className="text-ink-secondary">{o.dueDate ? formatDate(o.dueDate) : '—'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (o) => {
        const m = orderStatusMeta(o.status);
        return <StatusBadge tone={m.tone} label={m.label} />;
      },
    },
    {
      key: 'akcije',
      header: '',
      align: 'right',
      render: (o) => (
        <div className="flex justify-end gap-1">
          {o.status === PAYMENT_ORDER_STATUS.CREATED && !o.isLocked && (
            <Button variant="ghost" onClick={() => sign.mutate(o.id)}>
              Potpiši
            </Button>
          )}
          {o.status === PAYMENT_ORDER_STATUS.SIGNED && (
            <Button variant="ghost" onClick={() => pay.mutate(o.id)}>
              Označi plaćen
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-md font-semibold text-ink">Nalozi za plaćanje</h2>
        <div className="flex items-center gap-2">
          <div className="w-44">
            <Select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              placeholder="Svi statusi"
              options={[
                { value: PAYMENT_ORDER_STATUS.CREATED, label: 'Kreiran' },
                { value: PAYMENT_ORDER_STATUS.SIGNED, label: 'Potpisan' },
                { value: PAYMENT_ORDER_STATUS.PAID, label: 'Plaćen' },
              ]}
            />
          </div>
          <Button
            variant="secondary"
            onClick={() => signBatch.mutate(createdIds)}
            loading={signBatch.isPending}
            disabled={createdIds.length === 0}
          >
            Potpiši sve{createdIds.length > 0 ? ` (${createdIds.length})` : ''}
          </Button>
        </div>
      </div>

      {(sign.error || pay.error || signBatch.error) && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-2 text-sm text-status-danger">
          {((sign.error ?? pay.error ?? signBatch.error) as Error).message}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(o) => o.id}
        empty={
          <EmptyState
            title="Nema naloga za plaćanje"
            hint="Kreiraj naloge iz dospelih obaveza gore, pa ih ovde potpiši i izvezi u banku."
          />
        }
      />
    </section>
  );
}

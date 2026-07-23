'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { formatDate } from '@/lib/format';
import {
  usePurchaseOrders,
  usePurchaseOrderTransition,
  type PurchaseOrder,
} from '@/api/nabavka';
import { ReceiveOrderDialog } from './[id]/receive-order-dialog';

/**
 * Narudžbenice (BigBit paritet — dosad se PO nije video/primao kroz UI). Lista PO
 * sa status-akcijama: ORDERED → Potpiši → SIGNED/LOCKED → Prijem (ReceiveOrderDialog:
 * upis primljenih količina → robni ulaz + GL knjiženje). Data kroz `@/api/nabavka`.
 */
function orderStatusMeta(status: string): { tone: Tone; label: string } {
  switch (status) {
    case 'ORDERED':
      return { tone: 'info', label: 'Poručeno' };
    case 'SIGNED':
      return { tone: 'info', label: 'Potpisano' };
    case 'LOCKED':
      return { tone: 'warn', label: 'Zaključano' };
    case 'RECEIVED':
      return { tone: 'success', label: 'Primljeno' };
    case 'CLOSED':
      return { tone: 'success', label: 'Zatvoreno' };
    default:
      return { tone: 'neutral', label: status };
  }
}

export function PurchaseOrdersPanel() {
  const query = usePurchaseOrders({});
  const rows = query.data?.data ?? [];
  const transition = usePurchaseOrderTransition();
  const [receiveOrder, setReceiveOrder] = useState<PurchaseOrder | null>(null);

  const columns: Column<PurchaseOrder>[] = [
    {
      key: 'orderNumber',
      header: 'Broj',
      render: (o) => <span className="tnums text-ink">{o.orderNumber}</span>,
    },
    {
      key: 'supplierId',
      header: 'Dobavljač',
      render: (o) => <span className="tnums text-ink-secondary">#{o.supplierId}</span>,
    },
    {
      key: 'orderedAt',
      header: 'Poručeno',
      render: (o) => (
        <span className="text-ink-secondary">{o.orderedAt ? formatDate(o.orderedAt) : '—'}</span>
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
          {o.status === 'ORDERED' && (
            <Button
              variant="ghost"
              onClick={() => transition.mutate({ id: o.id, action: 'sign' })}
            >
              Potpiši
            </Button>
          )}
          {['ORDERED', 'SIGNED', 'LOCKED'].includes(o.status) && (
            <Button variant="ghost" onClick={() => setReceiveOrder(o)}>
              Prijem
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-3">
      <h2 className="text-md font-semibold text-ink">Narudžbenice</h2>

      {transition.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-2 text-sm text-status-danger">
          {(transition.error as Error).message}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(o) => o.id}
        loading={query.isLoading}
        empty={
          <EmptyState
            title="Nema narudžbenica"
            hint="Narudžbenice nastaju iz prihvaćenih upita ili direktnim kreiranjem; ovde se potpisuju i primaju."
          />
        }
      />

      {receiveOrder && (
        <ReceiveOrderDialog
          open={receiveOrder != null}
          onClose={() => setReceiveOrder(null)}
          order={receiveOrder}
        />
      )}
    </section>
  );
}

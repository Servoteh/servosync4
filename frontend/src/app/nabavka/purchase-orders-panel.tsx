'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Printer } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { formatDate } from '@/lib/format';
import {
  usePurchaseOrders,
  usePurchaseOrderTransition,
  usePurchaseOrderPdf,
  useMatchSummaryPdf,
  openPdf,
  type PurchaseOrder,
} from '@/api/nabavka';
import { ReceiveOrderDialog } from './receive-order-dialog';
import { OrderMatchPanel } from './order-match-panel';

/**
 * Narudžbenice (BigBit paritet — dosad se PO nije video/primao kroz UI). Lista PO
 * sa status-akcijama: ORDERED → Potpiši → SIGNED/LOCKED → Prijem (ReceiveOrderDialog:
 * upis primljenih količina → robni ulaz + GL knjiženje). Data kroz `@/api/nabavka`.
 *
 * 3-WAY MATCH: red se razvija (Enter / klik / dugme sa strelicom) u panel poređenja
 * naručeno ↔ primljeno ↔ fakturisano (`OrderMatchPanel`). Odstupanja su
 * OBAVEŠTENJE — ne onemogućavaju nijedno dugme u ovoj listi.
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
  const [expanded, setExpanded] = useState<number | null>(null);

  // Štampa: narudžbenica (sa cenama / bez cena za magacin) i pregled odstupanja.
  const orderPdf = usePurchaseOrderPdf();
  const summaryPdf = useMatchSummaryPdf();
  const [printError, setPrintError] = useState<string | null>(null);
  // Obim pregleda odstupanja se BIRA: bez perioda se štampalo „sve" (prvih 200
  // narudžbenica, tiho odsečeno), pa je izveštaj bio neupotrebljiv za mesečnu
  // kontrolu, a red UKUPNO je zbrajao samo deo dokumenata.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [onlyWithFindings, setOnlyWithFindings] = useState(false);

  async function onPrintOrder(id: number, variant?: 'bezCena'): Promise<void> {
    setPrintError(null);
    try {
      openPdf(await orderPdf.mutateAsync({ id, variant }));
    } catch (e) {
      setPrintError((e as Error).message);
    }
  }

  async function onPrintSummary(): Promise<void> {
    setPrintError(null);
    try {
      openPdf(
        await summaryPdf.mutateAsync({
          from: from || undefined,
          to: to || undefined,
          onlyWithFindings: onlyWithFindings || undefined,
        }),
        `pregled-odstupanja-${from || 'sve'}_${to || 'sve'}.pdf`,
      );
    } catch (e) {
      setPrintError((e as Error).message);
    }
  }

  const toggle = (id: number) => setExpanded((e) => (e === id ? null : id));

  const columns: Column<PurchaseOrder>[] = [
    {
      key: 'expand',
      header: '',
      render: (o) => (
        <button
          type="button"
          aria-label={
            expanded === o.id
              ? 'Sakrij poređenje naručeno/primljeno/fakturisano'
              : 'Prikaži poređenje naručeno/primljeno/fakturisano'
          }
          aria-expanded={expanded === o.id}
          title="Poređenje naručeno / primljeno / fakturisano"
          onClick={(e) => {
            e.stopPropagation();
            toggle(o.id);
          }}
          className="grid h-6 w-6 place-items-center rounded-control text-ink-secondary hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          {expanded === o.id ? (
            <ChevronDown className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden />
          )}
        </button>
      ),
    },
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
          <Button
            variant="ghost"
            title="Štampa narudžbenice (PDF, sa cenama)"
            loading={orderPdf.isPending && orderPdf.variables?.id === o.id}
            onClick={(e) => {
              e.stopPropagation();
              void onPrintOrder(o.id);
            }}
          >
            <Printer className="h-4 w-4" aria-hidden />
            Štampa
          </Button>
          <Button
            variant="ghost"
            title="Primerak za magacin — bez cena i iznosa"
            onClick={(e) => {
              e.stopPropagation();
              void onPrintOrder(o.id, 'bezCena');
            }}
          >
            Bez cena
          </Button>
          {o.status === 'ORDERED' && (
            <Button
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                transition.mutate({ id: o.id, action: 'sign' });
              }}
            >
              Potpiši
            </Button>
          )}
          {['ORDERED', 'SIGNED', 'LOCKED'].includes(o.status) && (
            <Button
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                setReceiveOrder(o);
              }}
            >
              Prijem
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-md font-semibold text-ink">Narudžbenice</h2>
        <Button
          variant="ghost"
          title="Štampa pregleda odstupanja naručeno / primljeno / fakturisano (PDF)"
          loading={summaryPdf.isPending}
          onClick={() => void onPrintSummary()}
        >
          <FileText className="h-4 w-4" aria-hidden />
          Pregled odstupanja (PDF)
        </Button>
      </div>
      <p className="text-xs text-ink-secondary">
        Otvori red (Enter ili klik) za poređenje naručeno / primljeno / fakturisano.
        Odstupanja su obaveštenje — ne blokiraju prijem ni plaćanje.
      </p>

      {transition.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-2 text-sm text-status-danger">
          {(transition.error as Error).message}
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
        rowKey={(o) => o.id}
        loading={query.isLoading}
        onRowActivate={(o) => toggle(o.id)}
        expandedKey={expanded}
        renderExpanded={(o) => <OrderMatchPanel orderId={o.id} />}
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

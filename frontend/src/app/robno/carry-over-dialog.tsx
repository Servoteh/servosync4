'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import {
  useCarryOverFromPurchaseOrder,
  useCarryOverFromInvoice,
} from '@/api/robno';
import { usePurchaseOrders } from '@/api/nabavka';

/**
 * Prepis dokumenta u robno (Batch B) — dva režima:
 *   • purchase-order: narudžbenica → primka (robni ulaz UL). Izbor narudžbenice iz liste
 *     poručenih (postojeći hook usePurchaseOrders); prepis vezuje purchaseOrderId.
 *   • invoice: predračun/faktura → izdatnica (robni izlaz IZ). Unos broja (id) dokumenta
 *     jer za fakture nema lookup hook-a; izdatnica prolazi kroz proveru dovoljnog stanja.
 *
 * Po uspehu vodi na kreiran robni dokument (onCreated). TASTATURA: Ctrl+S = prenesi, Esc = otkaži.
 */

export type CarryOverMode = 'purchase-order' | 'invoice';

/** Statusi narudžbenice iz kojih je prijem dozvoljen (backend guard). */
const RECEIVABLE = ['ORDERED', 'SIGNED', 'LOCKED'];

/** Picker poručenih narudžbenica (izdvojen da se upit pokrene samo u PO režimu). */
function OrderPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const orders = usePurchaseOrders({ take: 200 });
  const receivable = (orders.data?.data ?? []).filter((o) =>
    RECEIVABLE.includes(o.status),
  );
  const options = receivable.map((o) => ({
    value: String(o.id),
    label: `${o.orderNumber} (${o.status})`,
  }));
  const hint = orders.isLoading
    ? 'Učitavanje narudžbenica…'
    : receivable.length === 0
      ? 'Nema poručenih narudžbenica spremnih za prijem.'
      : 'Prikazane su poručene narudžbenice (ORDERED/SIGNED/LOCKED).';
  return (
    <FormField label="Narudžbenica" required hint={hint}>
      <Select
        placeholder="Izaberi narudžbenicu"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        options={options}
      />
    </FormField>
  );
}

export function CarryOverDialog({
  open,
  mode,
  onClose,
  onCreated,
}: {
  open: boolean;
  mode: CarryOverMode;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const isPo = mode === 'purchase-order';
  const fromPo = useCarryOverFromPurchaseOrder();
  const fromInvoice = useCarryOverFromInvoice();
  const active = isPo ? fromPo : fromInvoice;

  const [orderId, setOrderId] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [warehouseId, setWarehouseId] = useState('1');
  const [documentTypeCode, setDocumentTypeCode] = useState(isPo ? 'UFROB' : 'IFR');

  const reset = () => {
    setOrderId('');
    setInvoiceId('');
    setWarehouseId('1');
    setDocumentTypeCode(isPo ? 'UFROB' : 'IFR');
  };

  const err = (active.error as Error | null)?.message ?? null;

  const submit = () => {
    const wid = Number(warehouseId);
    const warehouse =
      Number.isInteger(wid) && wid > 0 ? wid : undefined;
    const docType = documentTypeCode.trim() || undefined;

    if (isPo) {
      const id = Number(orderId);
      if (!Number.isInteger(id) || id <= 0) return;
      fromPo.mutate(
        { orderId: id, warehouseId: warehouse, documentTypeCode: docType },
        {
          onSuccess: (res) => {
            reset();
            onCreated(res.data.id);
            onClose();
          },
        },
      );
    } else {
      const id = Number(invoiceId);
      if (!Number.isInteger(id) || id <= 0) return;
      fromInvoice.mutate(
        { invoiceId: id, warehouseId: warehouse, documentTypeCode: docType },
        {
          onSuccess: (res) => {
            reset();
            onCreated(res.data.id);
            onClose();
          },
        },
      );
    }
  };

  const canSubmit = isPo ? Number(orderId) > 0 : Number(invoiceId) > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isPo ? 'Prijem iz narudžbenice' : 'Izdatnica iz predračuna'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={active.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={active.isPending} disabled={!canSubmit}>
            {isPo ? 'Napravi prijem' : 'Napravi izdatnicu'}
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            submit();
          }
        }}
      >
        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}

        {isPo ? (
          <OrderPicker value={orderId} onChange={setOrderId} />
        ) : (
          <FormField
            label="Predračun / faktura (#)"
            required
            hint="Unesi id dokumenta (predračuna ili fakture) koji se razdužuje."
          >
            <Input
              type="number"
              value={invoiceId}
              onChange={(e) => setInvoiceId(e.target.value)}
              placeholder="faktura #"
            />
          </FormField>
        )}

        <div className="flex gap-3">
          <div className="w-28">
            <FormField label="Magacin" required>
              <Input
                type="number"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              />
            </FormField>
          </div>
          <div className="w-32">
            <FormField label="Vrsta (kod)" hint="DocumentType.code">
              <Input
                value={documentTypeCode}
                onChange={(e) => setDocumentTypeCode(e.target.value)}
              />
            </FormField>
          </div>
        </div>

        <p className="text-xs text-ink-secondary">
          {isPo
            ? 'Prepisuju se robne stavke narudžbenice u novi prijem (status U pripremi). Kalkulacija i knjiženje se rade na detalju dokumenta.'
            : 'Prepisuju se robne stavke fakture u izdatnicu (izlaz robe). Ako nema dovoljno stanja, prenos se odbija sa spiskom artikala.'}
        </p>
      </form>
    </Dialog>
  );
}

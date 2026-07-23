'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import {
  useCreateStockDocument,
  ROBNO_KIND,
  type RobnoKind,
} from '@/api/robno';

/**
 * Modal „Novi robni dokument" (BigBit paritet — dosad je robno bilo read-only kroz UI).
 * Zaglavlje: tip (UL/IZ/NIV) + vrsta dokumenta (documentTypeCode) + magacin + partner;
 * stavke: artikal + količina + fakturna cena. Status DRAFT → kalkulacija/knjiženje se
 * rade na detalju. Podržava osnovni skup polja; napredna (rabat, ZT, carina) na detalju.
 *
 * TASTATURA: Ctrl+S = sačuvaj, Esc = otkaži.
 */
interface ItemRow {
  itemId: string;
  quantity: string;
  invoicePrice: string;
}

const emptyRow = (): ItemRow => ({ itemId: '', quantity: '', invoicePrice: '' });

const KIND_OPTIONS = [
  { value: ROBNO_KIND.UL, label: 'Ulaz (prijem/nabavka)' },
  { value: ROBNO_KIND.IZ, label: 'Izlaz' },
  { value: ROBNO_KIND.NIV, label: 'Nivelacija (promena cene)' },
];

export function NewDocumentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const create = useCreateStockDocument();
  const [kind, setKind] = useState<RobnoKind>(ROBNO_KIND.UL);
  const [documentTypeCode, setDocumentTypeCode] = useState('UFROB');
  const [warehouseId, setWarehouseId] = useState('1');
  const [partnerId, setPartnerId] = useState('');
  const [documentDate, setDocumentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [items, setItems] = useState<ItemRow[]>([emptyRow()]);

  const setItem = (i: number, patch: Partial<ItemRow>) =>
    setItems((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addItem = () => setItems((rs) => [...rs, emptyRow()]);
  const removeItem = (i: number) =>
    setItems((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));

  const reset = () => {
    setKind(ROBNO_KIND.UL);
    setDocumentTypeCode('UFROB');
    setWarehouseId('1');
    setPartnerId('');
    setItems([emptyRow()]);
  };

  const err = (create.error as Error | null)?.message ?? null;
  const isInbound = kind === ROBNO_KIND.UL;

  const submit = () => {
    const wid = Number(warehouseId);
    if (!Number.isInteger(wid) || wid <= 0) return;
    const validItems = items
      .filter((r) => Number(r.itemId) > 0 && Number(r.quantity) > 0)
      .map((r) => ({
        itemId: Number(r.itemId),
        quantity: Number(r.quantity),
        invoicePrice: r.invoicePrice ? Number(r.invoicePrice) : undefined,
      }));
    if (validItems.length === 0) return;

    const pid = partnerId ? Number(partnerId) : undefined;
    create.mutate(
      {
        kind,
        documentTypeCode: documentTypeCode.trim(),
        warehouseId: wid,
        supplierId: isInbound ? pid : undefined,
        customerId: !isInbound ? pid : undefined,
        documentDate,
        items: validItems,
      },
      {
        onSuccess: (res) => {
          reset();
          onCreated(res.data.id);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Novi robni dokument"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            Kreiraj dokument
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

        <div className="flex gap-3">
          <div className="w-52">
            <FormField label="Tip dokumenta" required>
              <Select value={kind} onChange={(e) => setKind(e.target.value as RobnoKind)} options={KIND_OPTIONS} />
            </FormField>
          </div>
          <div className="w-28">
            <FormField label="Vrsta (kod)" required hint="DocumentType.code">
              <Input value={documentTypeCode} onChange={(e) => setDocumentTypeCode(e.target.value)} />
            </FormField>
          </div>
          <div className="w-24">
            <FormField label="Magacin" required>
              <Input type="number" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} />
            </FormField>
          </div>
        </div>

        <div className="flex gap-3">
          <div className="w-40">
            <FormField label={isInbound ? 'Dobavljač (#)' : 'Kupac (#)'}>
              <Input type="number" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} placeholder="komitent #" />
            </FormField>
          </div>
          <div className="w-44">
            <FormField label="Datum" required>
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            </FormField>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Stavke</span>
            <Button variant="ghost" type="button" onClick={addItem}>
              <Plus className="h-4 w-4" aria-hidden />
              Dodaj stavku
            </Button>
          </div>

          {items.map((r, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="w-28">
                <FormField label={i === 0 ? 'Artikal (#)' : ''}>
                  <Input type="number" value={r.itemId} onChange={(e) => setItem(i, { itemId: e.target.value })} placeholder="item #" />
                </FormField>
              </div>
              <div className="w-24">
                <FormField label={i === 0 ? 'Količina' : ''}>
                  <Input type="number" step="0.001" value={r.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} />
                </FormField>
              </div>
              <div className="w-32">
                <FormField label={i === 0 ? 'Fakturna cena' : ''}>
                  <Input type="number" step="0.01" value={r.invoicePrice} onChange={(e) => setItem(i, { invoicePrice: e.target.value })} />
                </FormField>
              </div>
              <Button variant="ghost" type="button" onClick={() => removeItem(i)} aria-label="Ukloni stavku">
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      </form>
    </Dialog>
  );
}

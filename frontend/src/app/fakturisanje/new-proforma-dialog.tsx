'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { useCreateProforma } from '@/api/sales';

/**
 * Modal „Novi predračun / ponuda" (BigBit paritet — useCreateProforma je bio mrtav
 * hook). Zaglavlje: tip (PON/PROF) + kupac + datum/rok + valuta; stavke: opis/artikal +
 * količina + cena + rabat + PDV. Nastaje kao draft (level 250) → „Napravi račun iz
 * predračuna" na detalju radi carry-over u IFR. TASTATURA: Ctrl+S sačuvaj, Esc otkaži.
 */
interface Row {
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
}

const emptyRow = (): Row => ({ description: '', quantity: '', unitPrice: '', discountPercent: '' });

export function NewProformaDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const create = useCreateProforma();
  const [documentType, setDocumentType] = useState<'PON' | 'PROF'>('PROF');
  const [customerId, setCustomerId] = useState('');
  const [documentDate, setDocumentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [currency, setCurrency] = useState('RSD');
  const [rows, setRows] = useState<Row[]>([emptyRow()]);

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, emptyRow()]);
  const removeRow = (i: number) => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));

  const reset = () => {
    setDocumentType('PROF');
    setCustomerId('');
    setDueDate('');
    setRows([emptyRow()]);
  };

  const err = (create.error as Error | null)?.message ?? null;

  const submit = () => {
    const cid = Number(customerId);
    if (!Number.isInteger(cid) || cid <= 0) return;
    const items = rows
      .filter((r) => r.description.trim() !== '' && Number(r.quantity) > 0)
      .map((r) => ({
        description: r.description.trim(),
        quantity: Number(r.quantity),
        unitPrice: r.unitPrice ? Number(r.unitPrice) : undefined,
        discountPercent: r.discountPercent ? Number(r.discountPercent) : undefined,
      }));
    if (items.length === 0) return;

    create.mutate(
      {
        documentType,
        customerId: cid,
        documentDate,
        dueDate: dueDate || undefined,
        currency,
        isExport: currency !== 'RSD',
        items,
      },
      {
        onSuccess: (res) => {
          reset();
          onCreated(res.id);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Novi predračun / ponuda"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            Kreiraj
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
          <div className="w-36">
            <FormField label="Tip" required>
              <Select
                value={documentType}
                onChange={(e) => setDocumentType(e.target.value as 'PON' | 'PROF')}
                options={[
                  { value: 'PROF', label: 'Predračun' },
                  { value: 'PON', label: 'Ponuda' },
                ]}
              />
            </FormField>
          </div>
          <div className="w-36">
            <FormField label="Kupac (#)" required>
              <Input type="number" value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="komitent #" />
            </FormField>
          </div>
          <div className="w-24">
            <FormField label="Valuta">
              <Select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                options={[
                  { value: 'RSD', label: 'RSD' },
                  { value: 'EUR', label: 'EUR' },
                ]}
              />
            </FormField>
          </div>
        </div>

        <div className="flex gap-3">
          <div className="w-44">
            <FormField label="Datum" required>
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            </FormField>
          </div>
          <div className="w-44">
            <FormField label="Rok plaćanja">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </FormField>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Stavke</span>
            <Button variant="ghost" type="button" onClick={addRow}>
              <Plus className="h-4 w-4" aria-hidden />
              Dodaj stavku
            </Button>
          </div>

          {rows.map((r, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <FormField label={i === 0 ? 'Opis / artikal' : ''}>
                  <Input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} placeholder="opis stavke" />
                </FormField>
              </div>
              <div className="w-20">
                <FormField label={i === 0 ? 'Kol.' : ''}>
                  <Input type="number" step="0.01" value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} />
                </FormField>
              </div>
              <div className="w-28">
                <FormField label={i === 0 ? 'Cena' : ''}>
                  <Input type="number" step="0.01" value={r.unitPrice} onChange={(e) => setRow(i, { unitPrice: e.target.value })} />
                </FormField>
              </div>
              <div className="w-20">
                <FormField label={i === 0 ? 'Rabat %' : ''}>
                  <Input type="number" step="0.01" value={r.discountPercent} onChange={(e) => setRow(i, { discountPercent: e.target.value })} />
                </FormField>
              </div>
              <Button variant="ghost" type="button" onClick={() => removeRow(i)} aria-label="Ukloni stavku">
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      </form>
    </Dialog>
  );
}

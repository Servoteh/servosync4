'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { useCreateTransfer } from '@/api/robno';
import { useWarehousesLookup } from '@/api/lookups';

/**
 * Modal „Prenos u drugi magacin" (međuskladišnica).
 *
 * ZAŠTO POSTOJI: motor prenosa je popravljen i dokazan (par dokumenata PREIZ+PREUL u
 * jednoj transakciji), ali do 27.07.2026. korisnik do njega NIJE MOGAO DA DOĐE — u
 * aplikaciji nije bilo nijedne opcije „Prenos". Magacioner je zato radio ono što ume:
 * Izlaz iz jednog magacina + Ulaz u drugi. Izlaz ide kroz šemu kontiranja kao RASHOD,
 * ulaz kao NABAVKA — glavna knjiga dobija lažan trošak i lažnu nabavku, a saldakonti
 * lažnog dobavljača. Popravka lagera bez ovog ekrana samo je selila štetu u knjigu.
 *
 * CENE SE NAMERNO NE UNOSE: vrednost prenosa je ponderisani prosek izvornog magacina
 * (isti računar koji vozi lager listu), pa Σ vrednosti zaliha firme ostaje nepromenjena.
 * Ručni unos cene je bio put do negativne vrednosti zaliha i otrovanog proseka.
 *
 * TASTATURA: Ctrl+S = sačuvaj, Esc = otkaži.
 */
interface ItemRow {
  itemId: string;
  quantity: string;
}

const emptyRow = (): ItemRow => ({ itemId: '', quantity: '' });

export function TransferDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Poziva se sa id-jem IZLAZNE strane para (prenosnica koja ide uz robu). */
  onCreated: (outboundId: number) => void;
}) {
  const create = useCreateTransfer();
  const warehouses = useWarehousesLookup();

  const [sourceWarehouseId, setSourceWarehouseId] = useState('');
  const [targetWarehouseId, setTargetWarehouseId] = useState('');
  const [documentDate, setDocumentDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [note, setNote] = useState('');
  const [items, setItems] = useState<ItemRow[]>([emptyRow()]);

  const setItem = (i: number, patch: Partial<ItemRow>) =>
    setItems((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addItem = () => setItems((rs) => [...rs, emptyRow()]);
  const removeItem = (i: number) =>
    setItems((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));

  const reset = () => {
    setSourceWarehouseId('');
    setTargetWarehouseId('');
    setNote('');
    setItems([emptyRow()]);
  };

  const err = (create.error as Error | null)?.message ?? null;

  const src = Number(sourceWarehouseId);
  const dst = Number(targetWarehouseId);
  const validItems = items.filter(
    (r) => Number(r.itemId) > 0 && Number(r.quantity) > 0,
  );
  // Isti magacin sa obe strane backend odbija (422); ovde se to kaže PRE slanja.
  const sameWarehouse = src > 0 && src === dst;
  const canSubmit =
    src > 0 && dst > 0 && !sameWarehouse && validItems.length > 0;

  const warehouseOptions = (warehouses.data?.data ?? []).map((w) => ({
    value: String(w.id),
    label: w.name,
  }));

  const submit = () => {
    if (!canSubmit) return;
    create.mutate(
      {
        sourceWarehouseId: src,
        targetWarehouseId: dst,
        documentDate,
        note: note.trim() || undefined,
        items: validItems.map((r) => ({
          itemId: Number(r.itemId),
          quantity: Number(r.quantity),
        })),
      },
      {
        onSuccess: (res) => {
          reset();
          onCreated(res.data.outbound.id);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Prenos u drugi magacin"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Otkaži
          </Button>
          <Button
            onClick={submit}
            loading={create.isPending}
            disabled={!canSubmit}
          >
            Prenesi robu
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

        {/* Čovek mora unapred da zna da nastaju DVA dokumenta — inače u listi vidi
            dva reda istog datuma i ne zna šta se desilo. */}
        <p className="text-sm text-ink-secondary">
          Prenos pravi <strong>dva povezana dokumenta</strong>: prenosnicu koja razdužuje
          izvorni magacin i ulaz koji zadužuje odredišni. Vrednost robe se prenosi po
          prosečnoj ceni izvornog magacina, pa ukupna vrednost zaliha ostaje ista.
          Ispravka ide isključivo kroz storno prenosa.
        </p>

        <div className="flex flex-wrap gap-3">
          <div className="w-60">
            <FormField label="Iz magacina" required>
              <Select
                value={sourceWarehouseId}
                onChange={(e) => setSourceWarehouseId(e.target.value)}
                placeholder="izaberi magacin"
                options={warehouseOptions}
                disabled={warehouses.isLoading}
              />
            </FormField>
          </div>
          <div className="w-60">
            <FormField
              label="U magacin"
              required
              hint={sameWarehouse ? 'Mora biti različit od izvornog.' : undefined}
            >
              <Select
                value={targetWarehouseId}
                onChange={(e) => setTargetWarehouseId(e.target.value)}
                placeholder="izaberi magacin"
                options={warehouseOptions}
                disabled={warehouses.isLoading}
              />
            </FormField>
          </div>
          <div className="w-44">
            <FormField label="Datum" required>
              <Input
                type="date"
                value={documentDate}
                onChange={(e) => setDocumentDate(e.target.value)}
              />
            </FormField>
          </div>
        </div>

        <FormField label="Napomena">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="npr. razlog prenosa, vozač"
          />
        </FormField>

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
              <div className="w-40">
                <FormField label={i === 0 ? 'Artikal (#)' : ''}>
                  <Input
                    type="number"
                    value={r.itemId}
                    onChange={(e) => setItem(i, { itemId: e.target.value })}
                    placeholder="artikal #"
                  />
                </FormField>
              </div>
              <div className="w-32">
                <FormField label={i === 0 ? 'Količina' : ''}>
                  <Input
                    type="number"
                    step="0.001"
                    value={r.quantity}
                    onChange={(e) => setItem(i, { quantity: e.target.value })}
                  />
                </FormField>
              </div>
              <Button
                variant="ghost"
                type="button"
                onClick={() => removeItem(i)}
                aria-label="Ukloni stavku"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      </form>
    </Dialog>
  );
}

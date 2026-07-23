'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { useCreateRequest } from '@/api/nabavka';

/**
 * Modal „Novi zahtev za nabavku" (BigBit paritet — dosad je useCreateRequest bio mrtav
 * hook bez forme). Zaglavlje: predmet (projectId, kičma) + opciona napomena; stavke:
 * artikal/opis + količina + „za upit" flag. Broj NNNN/god generiše server.
 *
 * TASTATURA: Ctrl+S = sačuvaj, Esc = otkaži (Dialog).
 */
interface ItemRow {
  description: string;
  quantity: string;
  unit: string;
  createRfq: boolean;
}

const emptyRow = (): ItemRow => ({ description: '', quantity: '', unit: '', createRfq: false });

export function NewRequestDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const create = useCreateRequest();
  const [projectId, setProjectId] = useState('');
  const [note, setNote] = useState('');
  const [items, setItems] = useState<ItemRow[]>([emptyRow()]);

  const reset = () => {
    setProjectId('');
    setNote('');
    setItems([emptyRow()]);
  };

  const setItem = (idx: number, patch: Partial<ItemRow>) =>
    setItems((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const addItem = () => setItems((rows) => [...rows, emptyRow()]);
  const removeItem = (idx: number) =>
    setItems((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== idx) : rows));

  const err = (create.error as Error | null)?.message ?? null;

  const submit = () => {
    const pid = Number(projectId);
    if (!Number.isInteger(pid) || pid <= 0) return;
    const validItems = items
      .filter((r) => r.description.trim() !== '' && Number(r.quantity) > 0)
      .map((r) => ({
        description: r.description.trim(),
        quantity: Number(r.quantity),
        unit: r.unit.trim() || undefined,
        createRfq: r.createRfq,
      }));
    if (validItems.length === 0) return;

    create.mutate(
      { projectId: pid, note: note.trim() || undefined, items: validItems },
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
      title="Novi zahtev za nabavku"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            Kreiraj zahtev
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

        <FormField label="Predmet (šifra)" required hint="ID predmeta — kičma zahteva.">
          <Input
            type="number"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="npr. 2026-0042"
            autoFocus
          />
        </FormField>

        <FormField label="Napomena">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Stavke</span>
            <Button variant="ghost" onClick={addItem} type="button">
              <Plus className="h-4 w-4" aria-hidden />
              Dodaj stavku
            </Button>
          </div>

          {items.map((r, idx) => (
            <div key={idx} className="flex items-end gap-2">
              <div className="flex-1">
                <FormField label={idx === 0 ? 'Artikal / opis' : ''}>
                  <Input
                    value={r.description}
                    onChange={(e) => setItem(idx, { description: e.target.value })}
                    placeholder="naziv artikla"
                  />
                </FormField>
              </div>
              <div className="w-24">
                <FormField label={idx === 0 ? 'Količina' : ''}>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={r.quantity}
                    onChange={(e) => setItem(idx, { quantity: e.target.value })}
                  />
                </FormField>
              </div>
              <div className="w-20">
                <FormField label={idx === 0 ? 'JM' : ''}>
                  <Input
                    value={r.unit}
                    onChange={(e) => setItem(idx, { unit: e.target.value })}
                    placeholder="kom"
                  />
                </FormField>
              </div>
              <label className="flex h-9 items-center gap-1 whitespace-nowrap text-xs text-ink-secondary">
                <input
                  type="checkbox"
                  checked={r.createRfq}
                  onChange={(e) => setItem(idx, { createRfq: e.target.checked })}
                />
                za upit
              </label>
              <Button
                variant="ghost"
                type="button"
                onClick={() => removeItem(idx)}
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

'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { Button } from '@/components/ui-kit/button';
import { useCreateInventoryCount } from '@/api/inventory';

/**
 * Modal Novi popis. Zaglavlje: magacin + datum + napomena. Magacin je numericki
 * unos (isti idiom kao robno/new-document-dialog -- warehouses nema lookup
 * endpoint, robni ekrani vuku magacin kao broj). Stavke se predpunjavaju
 * knjigovodstvenim stanjem na backendu; popisane kolicine se unose na detalju.
 *
 * TASTATURA: Ctrl+S = sacuvaj, Esc = otkazi (Dialog gasi na Esc/overlay).
 */
export function NewCountDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const create = useCreateInventoryCount();
  const [warehouseId, setWarehouseId] = useState('1');
  const [countDate, setCountDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');

  const reset = () => {
    setWarehouseId('1');
    setCountDate(new Date().toISOString().slice(0, 10));
    setNote('');
  };

  const err = (create.error as Error | null)?.message ?? null;

  const submit = () => {
    const wid = Number(warehouseId);
    if (!Number.isInteger(wid) || wid <= 0) return;
    if (!countDate) return;
    create.mutate(
      {
        warehouseId: wid,
        countDate,
        note: note.trim() || undefined,
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
      title="Novi popis"
      dismissable={!create.isPending}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Otkazi
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            Kreiraj popis
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
          <div className="w-28">
            <FormField label="Magacin" required hint="warehouses.id">
              <Input
                type="number"
                min="1"
                inputMode="numeric"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                autoFocus
              />
            </FormField>
          </div>
          <div className="w-48">
            <FormField label="Datum popisa" required>
              <Input
                type="date"
                value={countDate}
                onChange={(e) => setCountDate(e.target.value)}
              />
            </FormField>
          </div>
        </div>

        <FormField label="Napomena">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Opciona napomena uz popis"
          />
        </FormField>
      </form>
    </Dialog>
  );
}

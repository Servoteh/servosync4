'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import {
  useAddStatementLine,
  useUpdateStatementLine,
  LINE_DIRECTION,
  type BankStatementLine,
  type StatementLineInput,
} from '@/api/izvodi';

/**
 * Modal za RUČNI unos / izmenu stavke izvoda (BigBit paritet — kucanje pored TXT importa).
 * `line` = null → dodavanje; postavljen → izmena. Komitent se uparuje dugmetom „Upari"
 * na detalju (po žiro računu); ovde se ručno kuca naziv/žiro/iznos/smer/poziv-na-broj,
 * kao u BigBit „Unos naloga glavne knjige".
 *
 * TASTATURA: Ctrl+S = sačuvaj, Esc = otkaži (Dialog gasi na Esc/overlay).
 */
export function StatementLineEditor({
  statementId,
  line,
  open,
  onClose,
}: {
  statementId: number;
  line: BankStatementLine | null;
  open: boolean;
  onClose: () => void;
}) {
  const isEdit = line != null;
  const add = useAddStatementLine();
  const update = useUpdateStatementLine();

  const [form, setForm] = useState<StatementLineInput>({});

  // Reset forme kad se modal otvori (novi unos = prazno; izmena = postojeće).
  useEffect(() => {
    if (!open) return;
    if (line) {
      setForm({
        partnerAccount: line.partnerAccount ?? '',
        partnerName: line.partnerName ?? '',
        amount: Number(line.amount),
        direction: line.direction,
        referenceNumber: line.referenceNumber ?? '',
        documentDate: line.documentDate ? line.documentDate.slice(0, 10) : '',
      });
    } else {
      setForm({ direction: LINE_DIRECTION.CREDIT, amount: undefined });
    }
  }, [open, line]);

  const pending = add.isPending || update.isPending;
  const err = (add.error as Error | null)?.message ?? (update.error as Error | null)?.message ?? null;

  const set = <K extends keyof StatementLineInput>(k: K, v: StatementLineInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    const input: StatementLineInput = {
      partnerAccount: form.partnerAccount?.trim() || null,
      partnerName: form.partnerName?.trim() || null,
      amount: form.amount,
      direction: form.direction,
      referenceNumber: form.referenceNumber?.trim() || null,
      documentDate: form.documentDate || null,
    };
    if (isEdit && line) {
      update.mutate(
        { id: statementId, lineId: line.id, input },
        { onSuccess: onClose },
      );
    } else {
      add.mutate({ id: statementId, input }, { onSuccess: onClose });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? 'Izmena stavke izvoda' : 'Nova stavka izvoda'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Otkaži
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? 'Čuvanje…' : 'Sačuvaj'}
          </Button>
        </div>
      }
    >
      <form
        className="space-y-3"
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

        <FormField label="Smer" required>
          <Select
            value={form.direction ?? LINE_DIRECTION.CREDIT}
            onChange={(e) => set('direction', e.target.value)}
            options={[
              { value: LINE_DIRECTION.CREDIT, label: 'Priliv (uplata nama)' },
              { value: LINE_DIRECTION.DEBIT, label: 'Odliv (plaćanje sa računa)' },
            ]}
          />
        </FormField>

        <FormField label="Iznos" required>
          <Input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={form.amount ?? ''}
            onChange={(e) =>
              set('amount', e.target.value === '' ? undefined : Number(e.target.value))
            }
            autoFocus
          />
        </FormField>

        <FormField label="Naziv komitenta">
          <Input
            value={form.partnerName ?? ''}
            onChange={(e) => set('partnerName', e.target.value)}
            placeholder="npr. ACME d.o.o."
          />
        </FormField>

        <FormField
          label="Žiro račun komitenta"
          hint="Popuni radi automatskog uparivanja komitenta dugmetom Upari."
        >
          <Input
            value={form.partnerAccount ?? ''}
            onChange={(e) => set('partnerAccount', e.target.value)}
            placeholder="160-0000000000000-00"
          />
        </FormField>

        <FormField label="Poziv na broj (PNB)">
          <Input
            value={form.referenceNumber ?? ''}
            onChange={(e) => set('referenceNumber', e.target.value)}
            placeholder="broj fakture / model+poziv"
          />
        </FormField>

        <FormField label="Datum dokumenta">
          <Input
            type="date"
            value={form.documentDate ?? ''}
            onChange={(e) => set('documentDate', e.target.value)}
          />
        </FormField>
      </form>
    </Dialog>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { formatDecimal } from '@/lib/format';
import { useCreateJournalEntry, type JournalLineInput } from '@/api/glavna-knjiga';

/**
 * Modal „Novi nalog (temeljnica)" — ručni unos naloga glavne knjige (BigBit paritet:
 * računovođa kuca konto ↔ analitika, duguje/potražuje). Uživo prikazuje ΣDuguje/ΣPotražuje
 * i razliku; „Sačuvaj" je onemogućen dok nalog ne balansira. Server (postManualEntry)
 * ponovo proverava balans. TASTATURA: Ctrl+S = sačuvaj, Esc = otkaži.
 */
interface Row {
  accountCode: string;
  analyticalCode: string;
  debit: string;
  credit: string;
  description: string;
}

const emptyRow = (): Row => ({ accountCode: '', analyticalCode: '', debit: '', credit: '', description: '' });

export function ManualEntryDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const create = useCreateJournalEntry();
  const [orderType, setOrderType] = useState('TEMELJ');
  const [documentDate, setDocumentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()]);

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, emptyRow()]);
  const removeRow = (i: number) =>
    setRows((rs) => (rs.length > 2 ? rs.filter((_, idx) => idx !== i) : rs));

  const totals = useMemo(() => {
    let d = 0;
    let c = 0;
    for (const r of rows) {
      d += Number(r.debit) || 0;
      c += Number(r.credit) || 0;
    }
    return { debit: d, credit: c, diff: d - c };
  }, [rows]);

  const balanced = Math.abs(totals.diff) < 0.005 && totals.debit > 0;
  const err = (create.error as Error | null)?.message ?? null;

  const reset = () => {
    setOrderType('TEMELJ');
    setDescription('');
    setRows([emptyRow(), emptyRow()]);
  };

  const submit = () => {
    if (!balanced) return;
    const lines: JournalLineInput[] = rows
      .filter((r) => r.accountCode.trim() !== '' && (Number(r.debit) > 0 || Number(r.credit) > 0))
      .map((r) => ({
        accountCode: r.accountCode.trim(),
        analyticalCode: r.analyticalCode.trim() ? Number(r.analyticalCode) : null,
        debit: Number(r.debit) || 0,
        credit: Number(r.credit) || 0,
        description: r.description.trim() || undefined,
      }));
    if (lines.length < 2) return;

    create.mutate(
      { orderType: orderType.trim(), documentDate, description: description.trim() || undefined, lines },
      {
        onSuccess: (res) => {
          reset();
          onCreated(res.data.journalEntryId);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Novi nalog (temeljnica)"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className={`text-sm tnums ${balanced ? 'text-status-success' : 'text-status-danger'}`}>
            Duguje {formatDecimal(totals.debit)} · Potražuje {formatDecimal(totals.credit)}
            {!balanced && ` · razlika ${formatDecimal(totals.diff)}`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
              Otkaži
            </Button>
            <Button onClick={submit} loading={create.isPending} disabled={!balanced}>
              Proknjiži nalog
            </Button>
          </div>
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
          <div className="w-32">
            <FormField label="Vrsta">
              <Input value={orderType} onChange={(e) => setOrderType(e.target.value)} />
            </FormField>
          </div>
          <div className="w-44">
            <FormField label="Datum" required>
              <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
            </FormField>
          </div>
          <div className="flex-1">
            <FormField label="Opis">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </FormField>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">Stavke</span>
            <Button variant="ghost" type="button" onClick={addRow}>
              <Plus className="h-4 w-4" aria-hidden />
              Dodaj red
            </Button>
          </div>

          {rows.map((r, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="w-28">
                <FormField label={i === 0 ? 'Konto' : ''}>
                  <Input
                    value={r.accountCode}
                    onChange={(e) => setRow(i, { accountCode: e.target.value })}
                    placeholder="2040"
                  />
                </FormField>
              </div>
              <div className="w-24">
                <FormField label={i === 0 ? 'Analitika' : ''}>
                  <Input
                    value={r.analyticalCode}
                    onChange={(e) => setRow(i, { analyticalCode: e.target.value })}
                    placeholder="komitent #"
                  />
                </FormField>
              </div>
              <div className="w-28">
                <FormField label={i === 0 ? 'Duguje' : ''}>
                  <Input
                    type="number"
                    step="0.01"
                    value={r.debit}
                    onChange={(e) => setRow(i, { debit: e.target.value, credit: '' })}
                  />
                </FormField>
              </div>
              <div className="w-28">
                <FormField label={i === 0 ? 'Potražuje' : ''}>
                  <Input
                    type="number"
                    step="0.01"
                    value={r.credit}
                    onChange={(e) => setRow(i, { credit: e.target.value, debit: '' })}
                  />
                </FormField>
              </div>
              <div className="flex-1">
                <FormField label={i === 0 ? 'Opis stavke' : ''}>
                  <Input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} />
                </FormField>
              </div>
              <Button variant="ghost" type="button" onClick={() => removeRow(i)} aria-label="Ukloni red">
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      </form>
    </Dialog>
  );
}

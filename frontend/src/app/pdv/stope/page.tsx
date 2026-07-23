'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useTaxRates,
  useCreateTaxRate,
  useUpdateTaxRate,
  type TaxRate,
} from '@/api/tax-rates';

/**
 * Poreske stope (registar poreskih tarifa R_Tarife). Tabela stopa + dijalog za novu
 * stopu i izmenu postojeće. Efektivna stopa na dan (ratePct) = zbir svih komponenti
 * tarife; unos je pojednostavljen na osnovnu stopu (baseRate), ostale komponente 0.
 * Data kroz @/api/tax-rates hooks; kit komponente + tokeni.
 */
const columns: Column<TaxRate>[] = [
  { key: 'code', header: 'Šifra', render: (r) => <span className="tnums text-ink">{r.code}</span> },
  {
    key: 'ratePct',
    header: 'Stopa %',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums font-semibold text-ink">{formatDecimal(r.ratePct)}</span>,
  },
  { key: 'validFrom', header: 'Važi od', render: (r) => <span className="text-ink-secondary">{formatDate(r.validFrom)}</span> },
  {
    key: 'validTo',
    header: 'Važi do',
    render: (r) => <span className="text-ink-secondary">{r.validTo ? formatDate(r.validTo) : 'do daljeg'}</span>,
  },
  {
    key: 'description',
    header: 'Napomena',
    render: (r) => <span className="text-ink-secondary">{r.description ?? '—'}</span>,
  },
];

export default function PoreskeStopePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const rates = useTaxRates();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TaxRate | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (row: TaxRate) => {
    setEditing(row);
    setDialogOpen(true);
  };

  return (
    <AppShell>
      <PageHeader
        title="Poreske stope"
        count={rates.data ? `${rates.data.data.length} stopa` : undefined}
        actions={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" aria-hidden />
            Nova stopa
          </Button>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <DataTable
          columns={columns}
          rows={rates.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={rates.isLoading}
          onRowActivate={openEdit}
          empty={
            <EmptyState
              title="Nema definisanih poreskih stopa"
              hint="Dodaj poresku tarifu (npr. šifra sa stopom 20 ili 10) da bi obračun PDV-a radio."
            />
          }
        />
      </div>

      <TaxRateDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
      />
    </AppShell>
  );
}

/** Dijalog za unos nove i izmenu postojeće poreske stope (u istom fajlu — jedan obrazac). */
function TaxRateDialog({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  editing: TaxRate | null;
  onClose: () => void;
}) {
  const create = useCreateTaxRate();
  const update = useUpdateTaxRate();

  const [code, setCode] = useState('');
  const [rate, setRate] = useState('');
  const [description, setDescription] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');

  // Napuni polja pri otvaranju (izmena → iz reda; nova → prazno + danas kao početak).
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setCode(editing.code);
      setRate(editing.baseRate);
      setDescription(editing.description ?? '');
      setValidFrom(editing.validFrom ? editing.validFrom.slice(0, 10) : '');
      setValidTo(editing.validTo ? editing.validTo.slice(0, 10) : '');
    } else {
      setCode('');
      setRate('');
      setDescription('');
      setValidFrom(new Date().toISOString().slice(0, 10));
      setValidTo('');
    }
  }, [open, editing]);

  const rateNum = Number(rate);
  const isEdit = editing != null;
  const pending = create.isPending || update.isPending;
  const canSave =
    (isEdit || code.trim() !== '') &&
    rate.trim() !== '' &&
    Number.isFinite(rateNum) &&
    rateNum >= 0 &&
    validFrom !== '';
  const err =
    ((create.error as Error | null)?.message ??
      (update.error as Error | null)?.message) ||
    null;

  const submit = () => {
    if (!canSave) return;
    if (isEdit && editing) {
      update.mutate(
        {
          id: editing.id,
          input: {
            baseRate: rateNum,
            description: description.trim() || null,
            validFrom,
            validTo: validTo || null,
          },
        },
        { onSuccess: onClose },
      );
    } else {
      create.mutate(
        {
          code: code.trim(),
          baseRate: rateNum,
          description: description.trim() || null,
          validFrom,
          validTo: validTo || null,
        },
        { onSuccess: onClose },
      );
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? `Izmena stope ${editing?.code ?? ''}` : 'Nova poreska stopa'}
      dismissable={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={pending} disabled={!canSave}>
            Sačuvaj
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}

        <div className="flex gap-3">
          <div className="w-32">
            <FormField label="Šifra" required>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={5}
                disabled={isEdit}
                placeholder="npr. 20"
              />
            </FormField>
          </div>
          <div className="w-32">
            <FormField label="Stopa %" required>
              <Input type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} />
            </FormField>
          </div>
        </div>

        <div className="flex gap-3">
          <div className="w-44">
            <FormField label="Važi od" required>
              <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </FormField>
          </div>
          <div className="w-44">
            <FormField label="Važi do" hint="prazno = do daljeg">
              <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </FormField>
          </div>
        </div>

        <FormField label="Napomena">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
      </form>
    </Dialog>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Copy } from 'lucide-react';
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
  useExchangeRates,
  useCreateExchangeRate,
  useUpdateExchangeRate,
  useCopyExchangeRates,
  type ExchangeRate,
} from '@/api/exchange-rates';

/**
 * Kursna lista (registar deviznih kurseva ExchangeRate). Obrazac registra (isti kao
 * app/pdv/stope): tabela kurseva + filter valute, dijalog za novi kurs i izmenu
 * postojećeg, i dugme Prepiši od datuma (BigBit Formiraj iz datuma za datum).
 *
 * BigBit pravila: izvodi/nalozi koriste PRODAJNI kurs, blagajna SREDNJI; vikend/praznik
 * uzima poslednji raniji dan. Data isključivo kroz @/api/exchange-rates hook-ove; kit
 * komponente + tokeni. Stope stižu kao Decimal-as-string (formatDecimal na prikazu).
 */

/** Kurs (Decimal-as-string) → srpski format, do 4 decimale (NBS format). */
function rate(v: string): string {
  return formatDecimal(v, 4);
}

/** Kurs (Decimal-as-string) → vrednost za number input; nula/neparsivo → prazno. */
function prefillRate(v: string): string {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

const columns: Column<ExchangeRate>[] = [
  {
    key: 'rateDate',
    header: 'Datum',
    render: (r) => <span className="tnums text-ink">{formatDate(r.rateDate)}</span>,
  },
  {
    key: 'currency',
    header: 'Valuta',
    render: (r) => <span className="tnums font-semibold text-ink">{r.currency}</span>,
  },
  {
    key: 'buyRate',
    header: 'Kupovni',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{rate(r.buyRate)}</span>,
  },
  {
    key: 'middleRate',
    header: 'Srednji',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{rate(r.middleRate)}</span>,
  },
  {
    key: 'sellRate',
    header: 'Prodajni',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums font-semibold text-ink">{rate(r.sellRate)}</span>,
  },
  {
    key: 'source',
    header: 'Izvor',
    render: (r) => <span className="text-ink-secondary">{r.source ?? '—'}</span>,
  },
];

export default function KursnaListaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [currency, setCurrency] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [editing, setEditing] = useState<ExchangeRate | null>(null);

  const rates = useExchangeRates({ currency });

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

  const rows = rates.data?.data ?? [];
  const count = rates.data?.meta.count ?? 0;

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (row: ExchangeRate) => {
    setEditing(row);
    setDialogOpen(true);
  };

  return (
    <AppShell>
      <PageHeader
        title="Kursna lista"
        count={rates.data ? `${count} kurseva` : undefined}
        actions={
          <>
            <Button variant="secondary" onClick={() => setCopyOpen(true)}>
              <Copy className="h-4 w-4" aria-hidden />
              Prepiši od datuma
            </Button>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" aria-hidden />
              Novi kurs
            </Button>
          </>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Valuta
            <div className="w-32">
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                placeholder="sve"
                maxLength={3}
                className="tnums"
              />
            </div>
          </label>

          {currency !== '' && (
            <button
              onClick={() => setCurrency('')}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>

        {rates.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(rates.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={rates.isLoading}
          onRowActivate={openEdit}
          empty={
            <EmptyState
              title="Nema kurseva u prozoru"
              hint="Dodaj devizni kurs (npr. EUR sa prodajnim kursom) dugmetom Novi kurs u zaglavlju."
            />
          }
        />
      </div>

      <ExchangeRateDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
      />
      <CopyDialog open={copyOpen} onClose={() => setCopyOpen(false)} />
    </AppShell>
  );
}

/** Dijalog za unos novog i izmenu postojećeg kursa (jedan obrazac, isti fajl). */
function ExchangeRateDialog({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  editing: ExchangeRate | null;
  onClose: () => void;
}) {
  const create = useCreateExchangeRate();
  const update = useUpdateExchangeRate();

  const [rateDate, setRateDate] = useState('');
  const [currency, setCurrency] = useState('');
  const [buyRate, setBuyRate] = useState('');
  const [middleRate, setMiddleRate] = useState('');
  const [sellRate, setSellRate] = useState('');
  const [note, setNote] = useState('');

  // Napuni polja pri otvaranju (izmena → iz reda; nova → prazno + danas kao datum).
  // Nulti kurs (neuneta komponenta) prikazujemo kao prazno polje, ne kao 0.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setRateDate(editing.rateDate ? editing.rateDate.slice(0, 10) : '');
      setCurrency(editing.currency);
      setBuyRate(prefillRate(editing.buyRate));
      setMiddleRate(prefillRate(editing.middleRate));
      setSellRate(prefillRate(editing.sellRate));
      setNote(editing.note ?? '');
    } else {
      setRateDate(new Date().toISOString().slice(0, 10));
      setCurrency('');
      setBuyRate('');
      setMiddleRate('');
      setSellRate('');
      setNote('');
    }
    create.reset();
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const isEdit = editing != null;
  const pending = create.isPending || update.isPending;

  // Prazno / nula / neparsivo → undefined (izostavlja polje: backend traži kurs > 0,
  // a na izmeni izostavljeno polje ostaje nepromenjeno).
  const num = (v: string): number | undefined => {
    if (v.trim() === '') return undefined;
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const buyNum = num(buyRate);
  const middleNum = num(middleRate);
  const sellNum = num(sellRate);
  const anyRate = [buyNum, middleNum, sellNum].some((n) => n !== undefined && n > 0);

  const canSave =
    rateDate !== '' &&
    /^[A-Za-z]{3}$/.test(currency.trim()) &&
    anyRate &&
    !pending;

  const err =
    ((create.error as Error | null)?.message ??
      (update.error as Error | null)?.message) ||
    null;

  const submit = () => {
    if (!canSave) return;
    const body = {
      buyRate: buyNum,
      middleRate: middleNum,
      sellRate: sellNum,
      note: note.trim() || null,
    };
    if (isEdit && editing) {
      update.mutate(
        { id: editing.id, input: { rateDate, currency: currency.trim(), ...body } },
        { onSuccess: onClose },
      );
    } else {
      create.mutate(
        { rateDate, currency: currency.trim(), ...body },
        { onSuccess: onClose },
      );
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? `Izmena kursa ${editing?.currency ?? ''}` : 'Novi kurs'}
      dismissable={!pending}
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
          <div className="w-44">
            <FormField label="Datum" required>
              <Input type="date" value={rateDate} onChange={(e) => setRateDate(e.target.value)} className="tnums" />
            </FormField>
          </div>
          <div className="w-28">
            <FormField label="Valuta" required>
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                maxLength={3}
                placeholder="EUR"
                className="tnums"
              />
            </FormField>
          </div>
        </div>

        <div className="flex gap-3">
          <div className="w-32">
            <FormField label="Kupovni">
              <Input type="number" step="0.0001" min="0" value={buyRate} onChange={(e) => setBuyRate(e.target.value)} className="tnums" />
            </FormField>
          </div>
          <div className="w-32">
            <FormField label="Srednji">
              <Input type="number" step="0.0001" min="0" value={middleRate} onChange={(e) => setMiddleRate(e.target.value)} className="tnums" />
            </FormField>
          </div>
          <div className="w-32">
            <FormField label="Prodajni">
              <Input type="number" step="0.0001" min="0" value={sellRate} onChange={(e) => setSellRate(e.target.value)} className="tnums" />
            </FormField>
          </div>
        </div>

        <FormField label="Napomena">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </form>
    </Dialog>
  );
}

/** Dijalog Prepiši od datuma za datum (BigBit) — dva date polja, kopira sve valute. */
function CopyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const copy = useCopyExchangeRates();
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    if (!open) return;
    const today = new Date().toISOString().slice(0, 10);
    setFromDate('');
    setToDate(today);
    copy.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canSave = fromDate !== '' && toDate !== '' && !copy.isPending;
  const err = (copy.error as Error | null)?.message ?? null;
  const result = copy.data?.data ?? null;

  const submit = () => {
    if (!canSave) return;
    copy.mutate({ fromDate, toDate });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Prepiši kurseve od datuma za datum"
      dismissable={!copy.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={copy.isPending}>
            Zatvori
          </Button>
          <Button onClick={submit} loading={copy.isPending} disabled={!canSave}>
            Prepiši
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
        <p className="text-sm text-ink-secondary">
          Kopira sve valute sa izvornog dana na ciljni dan. Postojeći parovi (datum, valuta) se preskaču.
        </p>

        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}

        {result && (
          <div className="rounded-panel border border-status-success/40 bg-status-success-bg px-3 py-2 text-sm text-status-success">
            Kopirano: {result.copied}. Preskočeno: {result.skipped}.
          </div>
        )}

        <div className="flex gap-3">
          <div className="w-44">
            <FormField label="Iz datuma" required>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="tnums" />
            </FormField>
          </div>
          <div className="w-44">
            <FormField label="Za datum" required>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="tnums" />
            </FormField>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

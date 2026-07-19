'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/api/client';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Dialog } from '@/components/ui-kit/dialog';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useDueLiabilities,
  useCreatePaymentOrders,
  useExportPayments,
  downloadFxTxt,
  PAYMENT_ORDER_STATUS,
  type DueLiability,
  type PaymentOrderStatus,
  type CreatedPaymentOrder,
  type CreatePaymentOrderLineInput,
} from '@/api/placanja';

/**
 * Priprema plaćanja / virmani (Faza 4 §C). Obrazac „Lista" (DESIGN_SYSTEM §4.1)
 * sa EDITABILNIM gridom: dospele obaveze iz GK → checkbox „Plati" po redu +
 * editabilan iznos → „Kreiraj naloge" (DEDUP 409 poruka na konflikt) → „Izvezi FX"
 * (vodeći slog platioca u dijalogu → TXT download).
 *
 * Data isključivo kroz `@/api/placanja` hook-ove; sve od kit komponenti i tokena.
 * STATUS naloga (CREATED/SIGNED/PAID) preko kanonske mape (DESIGN_SYSTEM §7)
 * PLAĆANJA domen → `orderStatusMeta` nad postojećim tonovima (bez novih boja).
 */

/** Ključ dospele obaveze — nema jedinstvenog id-a, pa gradimo stabilan kompozit. */
function dueKey(d: DueLiability): string {
  return `${d.accountCode}|${d.supplierId ?? ''}|${d.documentNumber ?? ''}|${d.sourceLedgerEntryId}`;
}

/** ISO datum (yyyy-MM-dd) za <input type="date">, iz Date-a. */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * PLAĆANJA nalog status → { tone, label } nad POSTOJEĆIM tonovima (§7 PLAĆANJA):
 * kreiran=neutral, potpisan=info, plaćen=success.
 */
function orderStatusMeta(status: PaymentOrderStatus): { tone: Tone; label: string } {
  switch (status) {
    case PAYMENT_ORDER_STATUS.CREATED:
      return { tone: 'neutral', label: 'Kreiran' };
    case PAYMENT_ORDER_STATUS.SIGNED:
      return { tone: 'info', label: 'Potpisan' };
    case PAYMENT_ORDER_STATUS.PAID:
      return { tone: 'success', label: 'Plaćen' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/** Editabilno stanje jednog reda: da li se plaća i (moguće izmenjen) iznos u tekstu. */
interface RowEdit {
  checked: boolean;
  /** Iznos kao string sa srpskim zarezom (korisnički unos). */
  amountText: string;
}

/** „1.234,56" (srpski) → number; prazno/neparsivo → NaN. */
function parseAmount(text: string): number {
  const cleaned = text.replace(/\./g, '').replace(',', '.').trim();
  if (cleaned === '') return NaN;
  return Number(cleaned);
}

export default function PlacanjaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [cutoff, setCutoff] = useState<string>(() => isoDay(new Date()));
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [created, setCreated] = useState<CreatedPaymentOrder[] | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const due = useDueLiabilities(cutoff);
  const rows = useMemo(() => due.data?.data ?? [], [due.data]);
  const count = due.data?.meta.count ?? 0;

  const createOrders = useCreatePaymentOrders();
  const exportPayments = useExportPayments();

  // Uneseni iznos ili default = otvoreni saldo. Red bez unosa u `edits` = neplaćen.
  function editFor(d: DueLiability): RowEdit {
    return (
      edits[dueKey(d)] ?? {
        checked: false,
        amountText: formatDecimal(d.openAmount, 2),
      }
    );
  }

  function setEdit(d: DueLiability, patch: Partial<RowEdit>): void {
    const key = dueKey(d);
    setEdits((prev) => ({
      ...prev,
      [key]: { ...editFor(d), ...patch },
    }));
  }

  function selectAll(checked: boolean): void {
    const next: Record<string, RowEdit> = {};
    for (const d of rows) {
      const cur = editFor(d);
      next[dueKey(d)] = { ...cur, checked };
    }
    setEdits(next);
  }

  const selected = rows.filter((d) => editFor(d).checked);
  const selectedTotal = selected.reduce((sum, d) => {
    const n = parseAmount(editFor(d).amountText);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  const allChecked = rows.length > 0 && selected.length === rows.length;

  async function onCreate(): Promise<void> {
    setConflict(null);
    setCreated(null);
    const lines: CreatePaymentOrderLineInput[] = [];
    for (const d of selected) {
      if (d.supplierId == null) continue; // bez primaoca nalog nije moguć
      const amount = parseAmount(editFor(d).amountText);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      lines.push({
        supplierId: d.supplierId,
        amount,
        documentNumber: d.documentNumber ?? undefined,
        sourceLedgerEntryId: d.sourceLedgerEntryId,
        referenceBaseCredit: d.documentNumber ?? undefined,
        currency: d.currency,
        dueDate: d.dueDate ?? undefined,
      });
    }
    if (lines.length === 0) return;
    try {
      const res = await createOrders.mutateAsync({ lines });
      setCreated(res.data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(e.message);
      } else {
        setConflict(
          e instanceof Error ? e.message : 'Greška pri kreiranju naloga za plaćanje.',
        );
      }
    }
  }

  const skippedNoSupplier = selected.filter((d) => d.supplierId == null).length;

  const columns: Column<DueLiability>[] = [
    {
      key: 'pay',
      header: (
        <input
          type="checkbox"
          aria-label="Selektuj sve"
          checked={allChecked}
          onChange={(e) => selectAll(e.target.checked)}
          className="h-4 w-4 shrink-0 accent-accent"
        />
      ),
      render: (d) => (
        <input
          type="checkbox"
          aria-label="Plati ovu obavezu"
          checked={editFor(d).checked}
          disabled={d.supplierId == null}
          onChange={(e) => setEdit(d, { checked: e.target.checked })}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 shrink-0 accent-accent disabled:opacity-40"
        />
      ),
    },
    {
      key: 'supplier',
      header: 'Komitent',
      render: (d) => (
        <span className="tnums text-ink">
          {d.supplierId ?? <span className="text-ink-disabled">—</span>}
        </span>
      ),
    },
    {
      key: 'documentNumber',
      header: 'Broj dokumenta',
      render: (d) => (
        <span className="tnums text-ink-secondary">
          {d.documentNumber ?? <span className="text-ink-disabled">—</span>}
        </span>
      ),
    },
    {
      key: 'dueDate',
      header: 'Dospeće',
      render: (d) => <span className="text-ink-secondary">{formatDate(d.dueDate)}</span>,
    },
    {
      key: 'daysOverdue',
      header: 'Dana kašnjenja',
      align: 'right',
      numeric: true,
      render: (d) => (
        <span
          className={
            d.daysOverdue > 0 ? 'tnums text-status-danger' : 'tnums text-ink-secondary'
          }
        >
          {formatNumber(d.daysOverdue)}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Iznos',
      align: 'right',
      render: (d) => (
        <Input
          value={editFor(d).amountText}
          inputMode="decimal"
          aria-label="Iznos za plaćanje"
          onChange={(e) => setEdit(d, { amountText: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          className="h-8 w-32 text-right tnums"
        />
      ),
    },
  ];

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Priprema plaćanja"
        count={due.data ? `${formatNumber(count)} dospelih obaveza` : undefined}
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Dospelo do (presek)
            <div className="w-44">
              <Input
                type="date"
                value={cutoff}
                onChange={(e) => {
                  setCutoff(e.target.value);
                  setEdits({});
                  setCreated(null);
                  setConflict(null);
                }}
              />
            </div>
          </label>

          <div className="ml-auto flex items-end gap-2">
            <Button
              variant="secondary"
              onClick={() => selectAll(true)}
              disabled={rows.length === 0}
            >
              Selektuj sve
            </Button>
            <Button
              variant="secondary"
              onClick={() => selectAll(false)}
              disabled={selected.length === 0}
            >
              Deselektuj
            </Button>
            <Button
              onClick={onCreate}
              loading={createOrders.isPending}
              disabled={selected.length === 0}
            >
              Kreiraj naloge{selected.length > 0 ? ` (${selected.length})` : ''}
            </Button>
          </div>
        </div>

        {selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-panel border border-line bg-surface-2 px-4 py-2 text-sm">
            <span className="text-ink-secondary">
              Izabrano: <span className="font-semibold text-ink">{selected.length}</span>
            </span>
            <span className="text-ink-secondary">
              Ukupno za plaćanje:{' '}
              <span className="tnums font-semibold text-ink">
                {formatDecimal(selectedTotal, 2)}
              </span>
            </span>
            {skippedNoSupplier > 0 && (
              <span className="text-status-warn">
                {formatNumber(skippedNoSupplier)} bez komitenta — biće preskočeno
              </span>
            )}
          </div>
        )}

        {due.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(due.error as Error).message}
          </div>
        )}

        {conflict && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {conflict}
          </div>
        )}

        {created && created.length > 0 && (
          <div className="space-y-3 rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-3">
            <p className="text-sm font-medium text-status-success">
              Kreirano naloga: {formatNumber(created.length)}. Možete ih izvesti u
              banku (FX TXT).
            </p>
            <div className="overflow-x-auto rounded-control border border-line bg-surface">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                    <th className="h-8 px-3 font-semibold">Nalog</th>
                    <th className="h-8 px-3 font-semibold">Komitent</th>
                    <th className="h-8 px-3 font-semibold">Poziv na broj</th>
                    <th className="h-8 px-3 text-right font-semibold">Iznos</th>
                    <th className="h-8 px-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {created.map((o) => {
                    const s = orderStatusMeta(o.status);
                    return (
                      <tr key={o.id} className="border-b border-line-soft">
                        <td className="px-3 py-1.5 tnums text-ink">{o.orderNumber}</td>
                        <td className="px-3 py-1.5 tnums text-ink-secondary">
                          {o.supplierId}
                        </td>
                        <td className="px-3 py-1.5 tnums text-ink-secondary">
                          {o.referenceNumberCredit ?? '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right tnums text-ink">
                          {formatDecimal(o.amount, 2)}
                        </td>
                        <td className="px-3 py-1.5">
                          <StatusBadge tone={s.tone} label={s.label} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div>
              <Button onClick={() => setExportOpen(true)}>Izvezi FX (.txt)</Button>
            </div>
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(d) => dueKey(d)}
          loading={due.isLoading}
          empty={
            <EmptyState
              title="Nema dospelih obaveza"
              hint="Na izabrani datum preseka nema otvorenih obaveza za plaćanje. Promeni datum preseka."
            />
          }
        />
      </div>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        orderIds={created?.map((o) => o.id) ?? []}
        cutoff={cutoff}
        exporting={exportPayments.isPending}
        onExport={async (fields) => {
          const blob = await exportPayments.mutateAsync({
            orderIds: created?.map((o) => o.id) ?? [],
            debitAccount: fields.debitAccount,
            debitName: fields.debitName,
            debitPlace: fields.debitPlace || undefined,
            orderDate: fields.orderDate || undefined,
          });
          downloadFxTxt(blob, `virmani-${cutoff}.txt`);
          setExportOpen(false);
        }}
      />
    </AppShell>
  );
}

// ─────────────────────────────────────────────────────────────── export dijalog

interface ExportFields {
  debitAccount: string;
  debitName: string;
  debitPlace: string;
  orderDate: string;
}

/**
 * Vodeći slog platioca za FX izvoz (doc 21 §B) — backend traži `debitAccount` i
 * `debitName` (obavezni). TXT se skida kao fajl po uspehu (blob download).
 */
function ExportDialog({
  open,
  onClose,
  orderIds,
  cutoff,
  exporting,
  onExport,
}: {
  open: boolean;
  onClose: () => void;
  orderIds: number[];
  cutoff: string;
  exporting: boolean;
  onExport: (fields: ExportFields) => Promise<void>;
}) {
  const [fields, setFields] = useState<ExportFields>({
    debitAccount: '',
    debitName: '',
    debitPlace: '',
    orderDate: cutoff,
  });
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<ExportFields>) => setFields((f) => ({ ...f, ...patch }));

  async function submit(): Promise<void> {
    setError(null);
    if (fields.debitAccount.trim() === '' || fields.debitName.trim() === '') {
      setError('Žiro račun i naziv platioca (na teret) su obavezni za vodeći slog.');
      return;
    }
    try {
      await onExport(fields);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Greška pri izvozu naloga.');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Izvoz u banku (FX)"
      dismissable={!exporting}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={exporting}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={exporting} disabled={orderIds.length === 0}>
            Izvezi {orderIds.length} nalog{orderIds.length === 1 ? '' : 'a'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-secondary">
          Vodeći slog nosi podatke platioca (na teret). Fajl se skida u FX formatu
          (fiksni TXT) koji banka-klijent učitava.
        </p>

        <FormField label="Žiro račun platioca (na teret)" required>
          <Input
            value={fields.debitAccount}
            inputMode="numeric"
            placeholder="npr. 160-0000000000000-00"
            onChange={(e) => set({ debitAccount: e.target.value })}
          />
        </FormField>

        <FormField label="Naziv platioca" required hint="Naziv firme (do 35 znakova).">
          <Input
            value={fields.debitName}
            maxLength={35}
            onChange={(e) => set({ debitName: e.target.value })}
          />
        </FormField>

        <FormField label="Mesto platioca" hint="Opciono (do 20 znakova).">
          <Input
            value={fields.debitPlace}
            maxLength={20}
            onChange={(e) => set({ debitPlace: e.target.value })}
          />
        </FormField>

        <FormField label="Datum na virmanu">
          <Input
            type="date"
            value={fields.orderDate}
            onChange={(e) => set({ orderDate: e.target.value })}
          />
        </FormField>

        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

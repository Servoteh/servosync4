'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Plus, Printer, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useKif,
  useKuf,
  useKepu,
  useVatReturns,
  useBuildKifKuf,
  useComputePopdv,
  usePostVatReturn,
  useCreateManualVatEntry,
  useUpdateManualVatEntry,
  useDeleteManualVatEntry,
  usePpPdvPdf,
  useLedgerSpecPdf,
  openPdf,
  type VatLedgerRow,
  type VatReturn,
  type VatReturnLine,
  type KepuRow,
  type CreateManualVatEntryInput,
} from '@/api/pdv';

/**
 * PDV / POPDV (Faza 6). Obrazac „Lista" (DESIGN_SYSTEM §4.1): period izbor
 * (godina + mesec) + tri pogleda kroz Tabs — KIF (izlazni), KUF (ulazni),
 * POPDV obračun (output/input/obaveza zaglavlje + AOP linije). Data isključivo
 * kroz `@/api/pdv` hook-ove; sve od kit komponenti i tokena.
 *
 * Iznosi kroz formatDecimal (Decimal-as-string, BACKEND_RULES §6). Statusi
 * PDV obračuna: CALCULATED = info (kanonska mapa §7, isto kao Robno kalkulisan).
 */

type View = 'kif' | 'kuf' | 'popdv' | 'kepu';

const TABS: TabItem<View>[] = [
  { key: 'kif', label: 'KIF (izlazni)' },
  { key: 'kuf', label: 'KUF (ulazni)' },
  { key: 'popdv', label: 'POPDV obračun' },
  { key: 'kepu', label: 'KEPU' },
];

const CURRENT_YEAR = new Date().getFullYear();

/** Izbor godine: tekuća + 6 unazad (dovoljno za PDV knjige u pogonu). Select uzima string. */
const YEAR_OPTIONS: { value: string; label: string }[] = Array.from(
  { length: 7 },
  (_, i) => {
    const y = CURRENT_YEAR - i;
    return { value: String(y), label: String(y) };
  },
);

const MONTH_LABELS = [
  'Januar',
  'Februar',
  'Mart',
  'April',
  'Maj',
  'Jun',
  'Jul',
  'Avgust',
  'Septembar',
  'Oktobar',
  'Novembar',
  'Decembar',
];

const MONTH_OPTIONS: { value: string; label: string }[] = MONTH_LABELS.map(
  (label, i) => ({ value: String(i + 1), label }),
);

/** PDV obračun status → { tone, label } (kanonska mapa §7). */
function returnStatusMeta(status: string): { tone: Tone; label: string } {
  switch (status) {
    case 'CALCULATED':
      return { tone: 'info', label: 'Obračunat' };
    case 'POSTED':
      return { tone: 'success', label: 'Proknjižen' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/** Kolone KIF/KUF evidencije (isti oblik za oba smera). */
const ledgerColumns: Column<VatLedgerRow>[] = [
  {
    key: 'documentNumber',
    header: 'Dokument',
    render: (r) => (
      <span className="tnums font-semibold text-ink">{r.documentNumber}</span>
    ),
  },
  {
    key: 'partnerId',
    header: 'Partner',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="tnums text-ink-secondary">{r.partnerId ?? '—'}</span>
    ),
  },
  {
    key: 'documentDate',
    header: 'Datum',
    render: (r) => (
      <span className="text-ink-secondary">{formatDate(r.documentDate)}</span>
    ),
  },
  {
    key: 'vatRateCode',
    header: 'Stopa',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="tnums text-ink-secondary">
        {r.vatRateCode != null ? `${r.vatRateCode}%` : '—'}
      </span>
    ),
  },
  {
    key: 'vatBase',
    header: 'Osnovica',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{formatDecimal(r.vatBase)}</span>,
  },
  {
    key: 'vatAmount',
    header: 'PDV',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="tnums font-semibold text-ink">{formatDecimal(r.vatAmount)}</span>
    ),
  },
];

/** Kolone AOP linija POPDV obračuna. */
const lineColumns: Column<VatReturnLine>[] = [
  {
    key: 'aop',
    header: 'AOP',
    render: (l) => <span className="tnums font-semibold text-ink">{l.aop}</span>,
  },
  {
    key: 'amount',
    header: 'Iznos',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink">{formatDecimal(l.amount)}</span>,
  },
];

/** Kolone KEPU knjige (rbr, datum, dokument, opis, zaduženje, razduženje, saldo). */
const kepuColumns: Column<KepuRow>[] = [
  {
    key: 'rbr',
    header: 'Rbr',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{r.rbr ?? '—'}</span>,
  },
  {
    key: 'entryDate',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.entryDate)}</span>,
  },
  {
    key: 'documentNumber',
    header: 'Dokument',
    render: (r) => (
      <span className="tnums font-semibold text-ink">{r.documentNumber ?? '—'}</span>
    ),
  },
  {
    key: 'description',
    header: 'Opis',
    render: (r) => <span className="text-ink-secondary">{r.description ?? '—'}</span>,
  },
  {
    key: 'charge',
    header: 'Zaduženje',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{formatDecimal(r.charge)}</span>,
  },
  {
    key: 'discharge',
    header: 'Razduženje',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{formatDecimal(r.discharge)}</span>,
  },
  {
    key: 'balance',
    header: 'Saldo',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="tnums font-semibold text-ink">{formatDecimal(r.balance)}</span>
    ),
  },
];

/**
 * KIF/KUF kolone + akciona kolona: izmena/brisanje SAMO za ručne redove
 * (`sourceJournalEntryId == null`); GK-izvedeni redovi su read-only (oznaka GK).
 */
function ledgerColumnsWithActions(
  onEdit: (row: VatLedgerRow) => void,
  onDelete: (row: VatLedgerRow) => void,
): Column<VatLedgerRow>[] {
  return [
    ...ledgerColumns,
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) =>
        r.sourceJournalEntryId == null ? (
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(r);
              }}
              className="rounded-control p-1 text-ink-secondary hover:bg-surface-2 hover:text-ink"
              aria-label="Izmeni stavku"
              title="Izmeni ručnu stavku"
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(r);
              }}
              className="rounded-control p-1 text-status-danger hover:bg-status-danger/10"
              aria-label="Obriši stavku"
              title="Obriši ručnu stavku"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : (
          <span className="text-2xs uppercase tracking-wide text-ink-disabled" title="Izvedeno iz glavne knjige">
            GK
          </span>
        ),
    },
  ];
}

export default function PdvPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [view, setView] = useState<View>('kif');
  const [year, setYear] = useState(CURRENT_YEAR);
  const [month, setMonth] = useState(new Date().getMonth() + 1);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const period = useMemo(() => ({ year, month }), [year, month]);

  const kif = useKif(period);
  const kuf = useKuf(period);
  const returns = useVatReturns(year);
  const kepu = useKepu(period);

  const buildKifKuf = useBuildKifKuf();
  const computePopdv = useComputePopdv();
  const postReturn = usePostVatReturn();
  const createEntry = useCreateManualVatEntry();
  const updateEntry = useUpdateManualVatEntry();
  const deleteEntry = useDeleteManualVatEntry();
  const ppPdvPdf = usePpPdvPdf();
  const ledgerPdf = useLedgerSpecPdf();

  // Dijalog ručne KIF/KUF stavke: null = zatvoren; {row:null} = nova; {row} = izmena.
  const [entryDialog, setEntryDialog] = useState<{ row: VatLedgerRow | null } | null>(
    null,
  );

  // POPDV obračun za izabrani (godina, mesec) iz sačuvanih obračuna godine.
  const currentReturn: VatReturn | undefined = useMemo(
    () => returns.data?.data.find((r) => r.periodMonth === month),
    [returns.data, month],
  );

  const isLedgerView = view === 'kif' || view === 'kuf';
  const ledgerDirection: 'input' | 'output' = view === 'kuf' ? 'input' : 'output';

  function handleDeleteEntry(row: VatLedgerRow): void {
    const ok = window.confirm(
      `Obrisati ručnu stavku ${row.documentNumber}? Ova radnja se ne može opozvati.`,
    );
    if (ok) deleteEntry.mutate(row.id);
  }

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const kifRows = kif.data?.data ?? [];
  const kufRows = kuf.data?.data ?? [];
  const kepuRows = kepu.data?.data ?? [];

  const activeQuery =
    view === 'kif' ? kif : view === 'kuf' ? kuf : view === 'kepu' ? kepu : returns;
  const mutationErr =
    (buildKifKuf.error as Error | null) ||
    (computePopdv.error as Error | null) ||
    (postReturn.error as Error | null) ||
    (createEntry.error as Error | null) ||
    (updateEntry.error as Error | null) ||
    (deleteEntry.error as Error | null) ||
    (ppPdvPdf.error as Error | null) ||
    (ledgerPdf.error as Error | null);

  const ledgerColumnsActive = ledgerColumnsWithActions(
    (row) => setEntryDialog({ row }),
    handleDeleteEntry,
  );

  return (
    <AppShell>
      <PageHeader
        title="PDV / POPDV"
        count={
          view === 'kif'
            ? kif.data
              ? `${formatNumber(kif.data.meta.count)} stavki`
              : undefined
            : view === 'kuf'
              ? kuf.data
                ? `${formatNumber(kuf.data.meta.count)} stavki`
                : undefined
              : view === 'kepu'
                ? kepu.data
                  ? `${formatNumber(kepu.data.meta.count)} stavki`
                  : undefined
                : undefined
        }
        actions={
          view === 'popdv' ? (
            <div className="flex items-center gap-2">
              {currentReturn?.status === 'CALCULATED' && (
                <Button
                  variant="secondary"
                  onClick={() => postReturn.mutate(currentReturn.id)}
                  loading={postReturn.isPending}
                >
                  Zaključaj (POSTED)
                </Button>
              )}
              {currentReturn && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    ppPdvPdf.mutate(
                      `${year}-${String(month).padStart(2, '0')}`,
                      { onSuccess: openPdf },
                    )
                  }
                  loading={ppPdvPdf.isPending}
                >
                  <Printer className="h-4 w-4" aria-hidden />
                  PP-PDV
                </Button>
              )}
              <Button
                onClick={() => computePopdv.mutate({ year, month })}
                loading={computePopdv.isPending}
              >
                Obračunaj
              </Button>
            </div>
          ) : isLedgerView ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  ledgerPdf.mutate(
                    { book: view === 'kuf' ? 'kuf' : 'kif', year, month },
                    { onSuccess: openPdf },
                  )
                }
                loading={ledgerPdf.isPending}
              >
                <Printer className="h-4 w-4" aria-hidden />
                Štampa
              </Button>
              <Button
                variant="secondary"
                onClick={() => setEntryDialog({ row: null })}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Nova stavka
              </Button>
              <Button
                onClick={() => buildKifKuf.mutate({ year, month })}
                loading={buildKifKuf.isPending}
              >
                Napuni iz GK
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {/* Period izbor + tabovi */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Godina
            <div className="w-32">
              <Select
                value={String(year)}
                onChange={(e) => setYear(Number(e.target.value))}
                options={YEAR_OPTIONS}
              />
            </div>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Mesec
            <div className="w-44">
              <Select
                value={String(month)}
                onChange={(e) => setMonth(Number(e.target.value))}
                options={MONTH_OPTIONS}
              />
            </div>
          </label>

          <div className="ml-auto self-end">
            <Tabs
              tabs={TABS}
              value={view}
              onChange={setView}
              ariaLabel="Pogled PDV evidencije"
            />
          </div>
        </div>

        {(activeQuery.error || mutationErr) && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {((activeQuery.error as Error) || mutationErr)?.message}
          </div>
        )}

        {/* KIF / KUF */}
        {view === 'kif' && (
          <DataTable
            columns={ledgerColumnsActive}
            rows={kifRows}
            rowKey={(r) => r.id}
            loading={kif.isLoading}
            empty={
              <EmptyState
                title="Nema KIF stavki"
                hint={'Napuni evidenciju iz glavne knjige ili dodaj rucnu stavku za izabrani period.'}
              />
            }
          />
        )}

        {view === 'kuf' && (
          <DataTable
            columns={ledgerColumnsActive}
            rows={kufRows}
            rowKey={(r) => r.id}
            loading={kuf.isLoading}
            empty={
              <EmptyState
                title="Nema KUF stavki"
                hint={'Napuni evidenciju iz glavne knjige ili dodaj rucnu stavku za izabrani period.'}
              />
            }
          />
        )}

        {/* POPDV obračun */}
        {view === 'popdv' && (
          <PopdvView
            vatReturn={currentReturn}
            loading={returns.isLoading}
            year={year}
            month={month}
          />
        )}

        {/* KEPU knjiga (punjenje radi robno modul; ovde prikaz) */}
        {view === 'kepu' && (
          <DataTable
            columns={kepuColumns}
            rows={kepuRows}
            rowKey={(r) => r.id}
            loading={kepu.isLoading}
            empty={
              <EmptyState
                title="Nema KEPU stavki"
                hint={'KEPU knjiga se puni iz robnog toka; za izabrani period nema evidencije.'}
              />
            }
          />
        )}
      </div>

      {entryDialog && (
        <ManualEntryDialog
          direction={ledgerDirection}
          year={year}
          month={month}
          row={entryDialog.row}
          onClose={() => setEntryDialog(null)}
          onCreate={(input) =>
            createEntry.mutate(input, { onSuccess: () => setEntryDialog(null) })
          }
          onUpdate={(id, input) =>
            updateEntry.mutate(
              { id, input },
              { onSuccess: () => setEntryDialog(null) },
            )
          }
          saving={createEntry.isPending || updateEntry.isPending}
        />
      )}
    </AppShell>
  );
}

/** POPDV pogled: zaglavlje (output/input/obaveza) + tabela AOP linija. */
function PopdvView({
  vatReturn,
  loading,
  year,
  month,
}: {
  vatReturn: VatReturn | undefined;
  loading: boolean;
  year: number;
  month: number;
}) {
  if (!loading && !vatReturn) {
    return (
      <EmptyState
        title="Nema POPDV obračuna za period"
        hint={`Pokreni obračun za ${MONTH_LABELS[month - 1]} ${year}. (dugme „Obračunaj").`}
      />
    );
  }

  const lines = vatReturn?.lines ?? [];
  const status = vatReturn ? returnStatusMeta(vatReturn.status) : null;

  return (
    <div className="space-y-4">
      {/* Zaglavlje obračuna */}
      <div className="flex flex-wrap items-stretch gap-3">
        <SummaryTile label="Izlazni PDV" value={vatReturn?.outputVat} tone="ink" />
        <SummaryTile label="Ulazni PDV" value={vatReturn?.inputVat} tone="ink" />
        <SummaryTile
          label="Obaveza / povraćaj"
          value={vatReturn?.vatLiability}
          tone="strong"
        />
        {status && (
          <div className="flex flex-col justify-center rounded-panel border border-line bg-surface px-4 py-3">
            <span className="mb-1 text-xs text-ink-secondary">Status</span>
            <StatusBadge tone={status.tone} label={status.label} />
          </div>
        )}
      </div>

      {/* AOP linije */}
      <DataTable
        columns={lineColumns}
        rows={lines}
        rowKey={(l) => l.id}
        loading={loading}
        empty={
          <EmptyState
            title="Obračun nema AOP linija"
            hint="Pun POPDV traži seed popdv_definitions; osnovni obračun je u zaglavlju."
          />
        }
      />
    </div>
  );
}

/** Pločica zbirnog iznosa u POPDV zaglavlju (Decimal-as-string → formatDecimal). */
function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | undefined;
  tone: 'ink' | 'strong';
}) {
  return (
    <div className="flex min-w-40 flex-col rounded-panel border border-line bg-surface px-4 py-3">
      <span className="text-xs text-ink-secondary">{label}</span>
      <span
        className={
          tone === 'strong'
            ? 'tnums mt-1 text-2xl font-semibold text-ink'
            : 'tnums mt-1 text-xl font-semibold text-ink'
        }
      >
        {formatDecimal(value)}
      </span>
    </div>
  );
}

/** Danasnji datum kao yyyy-MM-dd (za default vrednost date inputa). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Dijalog za ručnu KIF/KUF stavku (D4). `row=null` = nova stavka (smer + period
 * iz izabranog taba/perioda); `row` popunjen = izmena postojeće ručne stavke
 * (smer i period se ne menjaju — samo dokument/partner/iznosi). GK-izvedene
 * stavke se ne otvaraju kroz ovaj dijalog (akcija je skrivena u tabeli).
 */
function ManualEntryDialog({
  direction,
  year,
  month,
  row,
  onClose,
  onCreate,
  onUpdate,
  saving,
}: {
  direction: 'input' | 'output';
  year: number;
  month: number;
  row: VatLedgerRow | null;
  onClose: () => void;
  onCreate: (input: CreateManualVatEntryInput) => void;
  onUpdate: (id: number, input: Partial<CreateManualVatEntryInput>) => void;
  saving: boolean;
}) {
  const isEdit = row != null;
  const [documentNumber, setDocumentNumber] = useState(row?.documentNumber ?? '');
  const [documentDate, setDocumentDate] = useState(
    row?.documentDate ? row.documentDate.slice(0, 10) : todayIso(),
  );
  const [partnerId, setPartnerId] = useState(
    row?.partnerId != null ? String(row.partnerId) : '',
  );
  const [vatRateCode, setVatRateCode] = useState(row?.vatRateCode ?? '');
  const [vatBase, setVatBase] = useState(row?.vatBase ?? '');
  const [vatAmount, setVatAmount] = useState(row?.vatAmount ?? '');

  const bookLabel = direction === 'output' ? 'KIF (izlazna)' : 'KUF (ulazna)';
  const title = isEdit ? 'Izmena ručne stavke' : 'Nova ručna stavka';

  const canSave =
    documentNumber.trim().length > 0 &&
    documentDate.length > 0 &&
    vatBase.trim().length > 0 &&
    vatAmount.trim().length > 0 &&
    !Number.isNaN(Number(vatBase)) &&
    !Number.isNaN(Number(vatAmount));

  function submit(): void {
    if (!canSave) return;
    const partner = partnerId.trim() === '' ? null : Number(partnerId);
    const rate = vatRateCode.trim() === '' ? null : vatRateCode.trim();
    if (isEdit && row) {
      onUpdate(row.id, {
        documentNumber: documentNumber.trim(),
        documentDate,
        partnerId: partner,
        vatRateCode: rate,
        vatBase: Number(vatBase),
        vatAmount: Number(vatAmount),
      });
    } else {
      onCreate({
        direction,
        documentNumber: documentNumber.trim(),
        documentDate,
        partnerId: partner,
        taxPeriodYear: year,
        taxPeriodMonth: month,
        vatBase: Number(vatBase),
        vatAmount: Number(vatAmount),
        vatRateCode: rate,
      });
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      dismissable={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={saving} disabled={!canSave}>
            Sačuvaj
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-secondary">
          Knjiga: {bookLabel} · period {String(month).padStart(2, '0')}/{year}
        </p>
        <FormField label="Broj dokumenta" required>
          <Input
            value={documentNumber}
            onChange={(e) => setDocumentNumber(e.target.value)}
            placeholder="npr. 2026-0042"
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Datum dokumenta" required>
            <Input
              type="date"
              value={documentDate}
              onChange={(e) => setDocumentDate(e.target.value)}
            />
          </FormField>
          <FormField label="Komitent (ID)" hint="opciono">
            <Input
              type="number"
              value={partnerId}
              onChange={(e) => setPartnerId(e.target.value)}
              placeholder="npr. 1234"
            />
          </FormField>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Stopa %" hint="opciono">
            <Input
              value={vatRateCode}
              onChange={(e) => setVatRateCode(e.target.value)}
              placeholder="20"
            />
          </FormField>
          <FormField label="Osnovica" required>
            <Input
              type="number"
              value={vatBase}
              onChange={(e) => setVatBase(e.target.value)}
              placeholder="0.00"
            />
          </FormField>
          <FormField label="Iznos PDV" required>
            <Input
              type="number"
              value={vatAmount}
              onChange={(e) => setVatAmount(e.target.value)}
              placeholder="0.00"
            />
          </FormField>
        </div>
      </div>
    </Dialog>
  );
}

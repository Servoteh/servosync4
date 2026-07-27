'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Pencil, Plus, Printer, Trash2 } from 'lucide-react';
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
import { ExportCsvButton } from '@/components/export-csv-button';
import { SendMailDialog } from '@/components/send-mail-dialog';
import { type CsvColumn } from '@/lib/table-csv';
import { ApiError } from '@/api/client';
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
  useSendPpPdvMail,
  openPdf,
  type VatLedgerRow,
  type VatReturn,
  type VatReturnLine,
  type KepuRow,
  type CreateManualVatEntryInput,
} from '@/api/pdv';

/** CSV kolone KIF/KUF evidencije (money → zarez za Excel sr; datum ISO). */
const pdvCsvDec = (s: string | null | undefined) => (s == null ? '' : s.replace('.', ','));
const ledgerCsvColumns: CsvColumn<VatLedgerRow>[] = [
  { header: 'Dokument', value: (r) => r.documentNumber },
  { header: 'Partner', value: (r) => r.partnerId ?? '' },
  { header: 'Datum', value: (r) => (r.documentDate ? r.documentDate.slice(0, 10) : '') },
  { header: 'Stopa %', value: (r) => r.vatRateCode ?? '' },
  { header: 'Osnovica', value: (r) => pdvCsvDec(r.vatBase) },
  { header: 'PDV', value: (r) => pdvCsvDec(r.vatAmount) },
];

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

/** Objašnjenje uz dugme „Ipak prikaži" — izlaz nosi žig i ne sme na predaju. */
const PRINT_FORCE_TITLE =
  'Izdaje PDF sa crvenom oznakom „NEISPRAVAN OBRAČUN — NIJE ZA PREDAJU". ' +
  'Takav dokument je samo za proveru i ne može se poslati mejlom.';

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
    render: (r) =>
      r.noDeduction ? (
        <span
          className="text-2xs uppercase tracking-wide text-status-warn"
          title="Ulazni račun bez prava odbitka — ne ulazi u pretporez"
        >
          van PDV
        </span>
      ) : (
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
/**
 * Izvuci spisak problema iz 409 odgovora provere ispravnosti
 * (`code: "PDV_OBRACUN_NEISPRAVAN"`, `details.problems[]`). Sirova `message` je
 * višelinijski tekst koji se u `div`-u slije u jedan pasus, pa se problemi
 * prikazuju kao lista.
 */
function problemsOf(err: unknown): string[] {
  if (!(err instanceof ApiError)) return [];
  const body = err.body as
    | { code?: string; details?: { problems?: unknown } }
    | null;
  const problems = body?.details?.problems;
  if (!Array.isArray(problems)) return [];
  return problems.filter((p): p is string => typeof p === 'string');
}

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
  const sendPpPdvMail = useSendPpPdvMail();

  // Greška mutacije nije vezana za period ni za tab, pa je preživljavala promenu
  // meseca: pad punjenja za mart ostajao je crven i pošto se pređe na april, i
  // izgledalo je kao da je i april pokvaren. Čisti se pri svakoj promeni pogleda.
  useEffect(() => {
    buildKifKuf.reset();
    computePopdv.reset();
    postReturn.reset();
    ppPdvPdf.reset();
    ledgerPdf.reset();
    // Namerno samo period/tab u zavisnostima — mutacije su stabilne reference,
    // a njihovo uvrštavanje bi vrtelo efekat u krug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, view]);

  // Dijalog ručne KIF/KUF stavke: null = zatvoren; {row:null} = nova; {row} = izmena.
  const [entryDialog, setEntryDialog] = useState<{ row: VatLedgerRow | null } | null>(
    null,
  );
  // „Pošalji PP-PDV na mail" dijalog + feedback banner.
  const [mailOpen, setMailOpen] = useState(false);
  const [mailBanner, setMailBanner] = useState<{
    tone: 'success' | 'warn' | 'danger';
    msg: string;
  } | null>(null);

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

  // Nalaz provere i ZBIR tekuće knjige (BE ih vraća uz listu). Zbir je bio jedini
  // deo kvara koji se na ekranu uopšte nije mogao videti: tabela nema podnožje,
  // pa „625 stavki a UKUPNO 0,00" postoji samo u PDF-u.
  const ledgerMeta = view === 'kuf' ? kuf.data?.meta : kif.data?.meta;
  const ledgerSanity = isLedgerView ? (ledgerMeta?.sanity ?? null) : null;
  // 409 sa strukturisanim spiskom problema — prikazuje se kao lista, ne kao
  // jedan zid teksta (poruka je višelinijska).
  const mutationProblems = problemsOf(mutationErr);
  const ledgerBlocked = ledgerSanity != null && !ledgerSanity.ok;

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
                      { period: `${year}-${String(month).padStart(2, '0')}` },
                      { onSuccess: (blob) => openPdf(blob) },
                    )
                  }
                  loading={ppPdvPdf.isPending}
                >
                  <Printer className="h-4 w-4" aria-hidden />
                  PP-PDV
                </Button>
              )}
              {/* IZLAZ IZ ZIDA: kad provera zaustavi štampu, knjigovođa mora da
                  ima način da vidi brojeve i utvrdi šta ne valja. PDF izlazi sa
                  crvenim žigom „NIJE ZA PREDAJU" i ne može otići mejlom. */}
              {currentReturn && problemsOf(ppPdvPdf.error).length > 0 && (
                <Button
                  variant="secondary"
                  title={PRINT_FORCE_TITLE}
                  onClick={() =>
                    ppPdvPdf.mutate(
                      {
                        period: `${year}-${String(month).padStart(2, '0')}`,
                        force: true,
                      },
                      { onSuccess: (blob) => openPdf(blob) },
                    )
                  }
                  loading={ppPdvPdf.isPending}
                >
                  Ipak prikaži (sa oznakom)
                </Button>
              )}
              {currentReturn && (
                <Button
                  variant="secondary"
                  title="Pošalji PP-PDV obrazac mejlom (PDF prilog)"
                  onClick={() => {
                    setMailBanner(null);
                    setMailOpen(true);
                  }}
                >
                  <Mail className="h-4 w-4" aria-hidden />
                  Pošalji na mail
                </Button>
              )}
              <Button
                onClick={() => computePopdv.mutate({ year, month })}
                loading={computePopdv.isPending}
              >
                Obračunaj
              </Button>
              {problemsOf(computePopdv.error).length > 0 && (
                <Button
                  variant="secondary"
                  title="Sačuvaj obračun uprkos nađenim problemima — NIJE za predaju"
                  onClick={() =>
                    computePopdv.mutate({ year, month, force: true })
                  }
                  loading={computePopdv.isPending}
                >
                  Ipak obračunaj (sa oznakom)
                </Button>
              )}
            </div>
          ) : isLedgerView ? (
            <div className="flex items-center gap-2">
              {/* Izvoz neispravnog perioda nosi oznaku U IMENU FAJLA — inače
                  bi tabela iz Excela izgledala kao uredan izvod evidencije. */}
              <ExportCsvButton
                columns={ledgerCsvColumns}
                rows={view === 'kuf' ? kufRows : kifRows}
                filename={
                  `${view}-${year}-${String(month).padStart(2, '0')}` +
                  (ledgerBlocked ? '-NEISPRAVAN-NIJE-ZA-PREDAJU' : '')
                }
              />
              <Button
                variant="secondary"
                onClick={() =>
                  ledgerPdf.mutate(
                    { book: view === 'kuf' ? 'kuf' : 'kif', year, month },
                    { onSuccess: (blob) => openPdf(blob) },
                  )
                }
                loading={ledgerPdf.isPending}
              >
                <Printer className="h-4 w-4" aria-hidden />
                Štampa
              </Button>
              {problemsOf(ledgerPdf.error).length > 0 && (
                <Button
                  variant="secondary"
                  title={PRINT_FORCE_TITLE}
                  onClick={() =>
                    ledgerPdf.mutate(
                      {
                        book: view === 'kuf' ? 'kuf' : 'kif',
                        year,
                        month,
                        force: true,
                      },
                      { onSuccess: (blob) => openPdf(blob) },
                    )
                  }
                  loading={ledgerPdf.isPending}
                >
                  Ipak prikaži (sa oznakom)
                </Button>
              )}
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
              {problemsOf(buildKifKuf.error).length > 0 && (
                <Button
                  variant="secondary"
                  title="Upisuje i period koji je pao na proveri — ISKLJUČIVO za proveru"
                  onClick={() => buildKifKuf.mutate({ year, month, force: true })}
                  loading={buildKifKuf.isPending}
                >
                  Ipak napuni (sa oznakom)
                </Button>
              )}
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

        {/* NALAZ PROVERE ISPRAVNOSTI — vezan za PODATAK, ne za format izlaza.
            Ranije je zaštita stajala samo na PDF-u i mejlu, pa je period koji se
            NE SME odštampati mogao bez ijedne oznake da izađe u CSV i ode dalje. */}
        {isLedgerView && ledgerSanity && !ledgerSanity.ok && (
          <div className="space-y-2 rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            <p className="font-semibold">
              PDV evidencija za {ledgerSanity.period} nije ispravna — ovi brojevi
              NISU za predaju.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              {ledgerSanity.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {isLedgerView && ledgerSanity && ledgerSanity.warnings.length > 0 && (
          <div className="space-y-2 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm text-status-warn">
            <p className="font-semibold">Napomene uz period {ledgerSanity.period}</p>
            <ul className="list-disc space-y-1 pl-5">
              {ledgerSanity.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {(activeQuery.error || mutationErr) && (
          <div className="space-y-2 rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {/* Problemi iz 409 (`details.problems`) idu kao LISTA — sirova poruka
                je višelinijski tekst koji se u `div`-u slije u jedan pasus. */}
            {mutationProblems.length > 0 ? (
              <>
                <p className="font-semibold">
                  Zaustavljeno — PDV evidencija za period nije ispravna:
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  {mutationProblems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <p>
                  Kad ti izlaz treba samo za proveru, uključi „Ipak prikaži" —
                  dokument izlazi sa oznakom „NEISPRAVAN OBRAČUN — NIJE ZA PREDAJU".
                </p>
              </>
            ) : (
              <p className="whitespace-pre-line">
                {((activeQuery.error as Error) || mutationErr)?.message}
              </p>
            )}
          </div>
        )}

        {mailBanner && (
          <div
            className={`rounded-panel border px-4 py-3 text-sm ${
              mailBanner.tone === 'success'
                ? 'border-status-success/40 bg-status-success-bg text-status-success'
                : mailBanner.tone === 'warn'
                  ? 'border-status-warn/40 bg-status-warn-bg text-status-warn'
                  : 'border-status-danger/40 bg-status-danger-bg text-status-danger'
            }`}
          >
            {mailBanner.msg}
          </div>
        )}

        {/* KIF / KUF */}
        {view === 'kif' && (
          <>
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
            <LedgerTotals meta={kif.data?.meta} book="KIF" />
          </>
        )}

        {view === 'kuf' && (
          <>
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
            <LedgerTotals meta={kuf.data?.meta} book="KUF" />
          </>
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

      {mailOpen && currentReturn && (
        <SendMailDialog
          title={`Pošalji PP-PDV — ${MONTH_LABELS[month - 1]} ${year}.`}
          intro="Obrazac PP-PDV se šalje kao PDF prilog (npr. knjigovođi)."
          toRequired
          withNote={false}
          sending={sendPpPdvMail.isPending}
          error={(sendPpPdvMail.error as Error | null)?.message ?? null}
          onClose={() => setMailOpen(false)}
          onSend={({ to }) =>
            sendPpPdvMail.mutate(
              { period: `${year}-${String(month).padStart(2, '0')}`, to },
              {
                onSuccess: (res) => {
                  setMailOpen(false);
                  setMailBanner(
                    res.data.sent
                      ? { tone: 'success', msg: `PP-PDV obrazac poslat na ${res.data.to}.` }
                      : {
                          tone: 'warn',
                          msg: `PDF je generisan, ali slanje nije izvršeno (sistem za slanje nije konfigurisan).`,
                        },
                  );
                },
              },
            )
          }
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
/**
 * Podnožje KIF/KUF tabele: Σ osnovica i Σ PDV — ISTI broj koji ide u „UKUPNO"
 * red PDF-a, iz istog izvora (`meta` sa servera).
 *
 * Zašto postoji: kvar zbog kojeg je ceo modul popravljan („625 stavki a UKUPNO
 * 0,00") na ekranu se NIJE MOGAO videti — tabela je imala samo redove, a zbir
 * je postojao jedino u odštampanom PDF-u.
 */
function LedgerTotals({
  meta,
  book,
}: {
  meta?: { count: number; totalBase: string; totalVat: string };
  book: 'KIF' | 'KUF';
}) {
  if (!meta || meta.count === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-6 rounded-panel border border-line bg-surface-2 px-4 py-3 text-sm">
      <span className="text-ink-secondary">
        {book} — ukupno {formatNumber(meta.count)} stavki
      </span>
      <span className="text-ink-secondary">
        Σ osnovica{' '}
        <span className="tnums font-semibold text-ink">
          {formatDecimal(meta.totalBase)}
        </span>
      </span>
      <span className="text-ink-secondary">
        Σ PDV{' '}
        <span className="tnums font-semibold text-ink">
          {formatDecimal(meta.totalVat)}
        </span>
      </span>
    </div>
  );
}

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
 * Bruto↔neto most (klijentski pomoćnik — ogledalo backend/vat-bridge.util.ts).
 * Zaokruženje na 2 decimale; PDV = bruto − neto (zbir uvek zatvara). Vrednosti
 * su samo predlog koji korisnik „prepiše" u polja; BE ionako validira unos.
 */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function bridgeGrossToNet(gross: number, rate: number): { net: number; vat: number } {
  const g = round2(gross);
  const net = round2(g / (1 + rate / 100));
  return { net, vat: round2(g - net) };
}
function bridgeNetToGross(net: number, rate: number): { gross: number; vat: number } {
  const n = round2(net);
  const vat = round2((n * rate) / 100);
  return { gross: round2(n + vat), vat };
}

/** Prikaz broja sa 2 decimale i decimalnim zarezom (sr) za rezultat kalkulatora. */
function fmt2(n: number): string {
  return n.toFixed(2).replace('.', ',');
}

/**
 * Kalkulator bruto↔neto iznad polja ručne stavke (B4). Korisnik unese iznos +
 * stopu, izabere smer (bruto→neto ili neto→bruto), vidi neto/PDV/bruto i dugmetom
 * „Prepiši u polja" popuni Osnovicu, Iznos PDV i Stopu u formi. Ne zove API.
 */
function VatBridgeCalculator({
  onApply,
}: {
  onApply: (v: { base: number; vat: number; rate: string }) => void;
}) {
  const [mode, setMode] = useState<'grossToNet' | 'netToGross'>('grossToNet');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('20');

  const amountNum = Number(amount);
  const rateNum = Number(rate);
  const valid =
    amount.trim() !== '' &&
    !Number.isNaN(amountNum) &&
    amountNum >= 0 &&
    !Number.isNaN(rateNum) &&
    rateNum >= 0;

  const result = valid
    ? mode === 'grossToNet'
      ? (() => {
          const { net, vat } = bridgeGrossToNet(amountNum, rateNum);
          return { base: net, vat, gross: round2(amountNum) };
        })()
      : (() => {
          const { gross, vat } = bridgeNetToGross(amountNum, rateNum);
          return { base: round2(amountNum), vat, gross };
        })()
    : null;

  return (
    <div className="rounded-panel border border-line bg-surface-2/50 p-3">
      <p className="mb-2 text-xs font-semibold text-ink-secondary">
        Kalkulator bruto ↔ neto
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
          Smer
          <div className="w-40">
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'grossToNet' | 'netToGross')}
              options={[
                { value: 'grossToNet', label: 'Bruto → neto + PDV' },
                { value: 'netToGross', label: 'Neto → bruto + PDV' },
              ]}
            />
          </div>
        </label>
        <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
          {mode === 'grossToNet' ? 'Bruto iznos' : 'Neto iznos'}
          <div className="w-32">
            <Input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
        </label>
        <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
          Stopa %
          <div className="w-20">
            <Input
              type="number"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="20"
            />
          </div>
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="tnums text-xs text-ink-secondary">
          {result ? (
            <>
              Neto <span className="font-semibold text-ink">{fmt2(result.base)}</span>
              {'  ·  '}PDV <span className="font-semibold text-ink">{fmt2(result.vat)}</span>
              {'  ·  '}Bruto <span className="font-semibold text-ink">{fmt2(result.gross)}</span>
            </>
          ) : (
            <span className="text-ink-disabled">Unesi iznos i stopu.</span>
          )}
        </div>
        <Button
          variant="secondary"
          disabled={!result}
          onClick={() =>
            result &&
            onApply({ base: result.base, vat: result.vat, rate: rate.trim() })
          }
        >
          Prepiši u polja
        </Button>
      </div>
    </div>
  );
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
  // „Van PDV" stavka nosi marker vatRateCode="VP" na BE; u formi je ne prikazujemo
  // kao stopu nego kao stanje checkbox-a (početna stopa prazna kad je van PDV).
  const [noDeduction, setNoDeduction] = useState(row?.noDeduction ?? false);
  const [vatRateCode, setVatRateCode] = useState(
    row?.noDeduction ? '' : (row?.vatRateCode ?? ''),
  );
  const [vatBase, setVatBase] = useState(row?.vatBase ?? '');
  const [vatAmount, setVatAmount] = useState(row?.vatAmount ?? '');

  // „Bez prava odbitka" postoji samo za ulazni račun (KUF).
  const isKuf = direction === 'input';
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
    // „Van PDV" (samo KUF): BE postavlja marker vatRateCode="VP", pa stopu ne šaljemo.
    const vanPdv = isKuf && noDeduction;
    const rate = vanPdv || vatRateCode.trim() === '' ? null : vatRateCode.trim();
    if (isEdit && row) {
      onUpdate(row.id, {
        documentNumber: documentNumber.trim(),
        documentDate,
        partnerId: partner,
        vatRateCode: rate,
        vatBase: Number(vatBase),
        vatAmount: Number(vatAmount),
        ...(isKuf ? { noDeduction: vanPdv } : {}),
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
        ...(vanPdv ? { noDeduction: true } : {}),
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
        <VatBridgeCalculator
          onApply={({ base, vat, rate }) => {
            setVatBase(String(base));
            setVatAmount(String(vat));
            if (!(isKuf && noDeduction)) setVatRateCode(rate);
          }}
        />
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
          <FormField label="Stopa %" hint={isKuf && noDeduction ? 'van PDV' : 'opciono'}>
            <Input
              value={isKuf && noDeduction ? '' : vatRateCode}
              onChange={(e) => setVatRateCode(e.target.value)}
              placeholder="20"
              disabled={isKuf && noDeduction}
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

        {isKuf && (
          <label className="flex cursor-pointer items-start gap-2 rounded-control p-1 text-sm text-ink hover:bg-surface-2/60">
            <input
              type="checkbox"
              checked={noDeduction}
              onChange={(e) => setNoDeduction(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span>
              Ulazni račun bez prava odbitka (van PDV)
              <span className="block text-xs text-ink-secondary">
                Stavka ostaje u KUF knjizi, ali PDV ne ulazi u pretporez (POPDV).
              </span>
            </span>
          </label>
        )}
      </div>
    </Dialog>
  );
}

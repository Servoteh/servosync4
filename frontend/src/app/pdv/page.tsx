'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useKif,
  useKuf,
  useVatReturns,
  useBuildKifKuf,
  useComputePopdv,
  type VatLedgerRow,
  type VatReturn,
  type VatReturnLine,
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

type View = 'kif' | 'kuf' | 'popdv';

const TABS: TabItem<View>[] = [
  { key: 'kif', label: 'KIF (izlazni)' },
  { key: 'kuf', label: 'KUF (ulazni)' },
  { key: 'popdv', label: 'POPDV obračun' },
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

  const buildKifKuf = useBuildKifKuf();
  const computePopdv = useComputePopdv();

  // POPDV obračun za izabrani (godina, mesec) iz sačuvanih obračuna godine.
  const currentReturn: VatReturn | undefined = useMemo(
    () => returns.data?.data.find((r) => r.periodMonth === month),
    [returns.data, month],
  );

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const kifRows = kif.data?.data ?? [];
  const kufRows = kuf.data?.data ?? [];

  const activeQuery = view === 'kif' ? kif : view === 'kuf' ? kuf : returns;
  const buildErr = buildKifKuf.error as Error | null;
  const computeErr = computePopdv.error as Error | null;

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
              : undefined
        }
        actions={
          view === 'popdv' ? (
            <Button
              onClick={() => computePopdv.mutate({ year, month })}
              loading={computePopdv.isPending}
            >
              Obračunaj
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() => buildKifKuf.mutate({ year, month })}
              loading={buildKifKuf.isPending}
            >
              Napuni iz GK
            </Button>
          )
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

        {(activeQuery.error || buildErr || computeErr) && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {
              (
                (activeQuery.error as Error) ||
                buildErr ||
                computeErr
              )?.message
            }
          </div>
        )}

        {/* KIF / KUF */}
        {view === 'kif' && (
          <DataTable
            columns={ledgerColumns}
            rows={kifRows}
            rowKey={(r) => r.id}
            loading={kif.isLoading}
            empty={
              <EmptyState
                title="Nema KIF stavki"
                hint={'Napuni evidenciju iz glavne knjige za izabrani period (dugme „Napuni iz GK“).'}
              />
            }
          />
        )}

        {view === 'kuf' && (
          <DataTable
            columns={ledgerColumns}
            rows={kufRows}
            rowKey={(r) => r.id}
            loading={kuf.isLoading}
            empty={
              <EmptyState
                title="Nema KUF stavki"
                hint={'Napuni evidenciju iz glavne knjige za izabrani period (dugme „Napuni iz GK“).'}
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
      </div>
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

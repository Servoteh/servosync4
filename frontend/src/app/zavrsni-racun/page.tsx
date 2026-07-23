'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { formatDecimal } from '@/lib/format';
import {
  useGrossTrialBalance,
  useStatements,
  useStatementControls,
  useComputeBalanceSheet,
  useComputeIncomeStatement,
  useFinalizeStatement,
  useAprXmlDownload,
  downloadXml,
  STATEMENT_TYPE,
  STATEMENT_STATUS,
  type GrossTrialBalanceRow,
  type StatementLine,
  type FinancialStatement,
  type ControlResult,
} from '@/api/zavrsni';

/**
 * Završni račun / bilansi (Faza 7). Obrazac „Lista" (DESIGN_SYSTEM §4.1):
 * izbor godine + Tabs (Bruto bilans / Bilans stanja / Bilans uspeha) nad gustom
 * tabelom. Izvedeni obračuni nad glavnom knjigom — data isključivo kroz
 * `@/api/zavrsni` hook-ove; sve od kit komponenti i tokena.
 *
 * STATUS OBRAČUNA (§7 nema poseban red — koristi se generička mapa): DRAFT=neutral
 * („Nacrt"), FINALIZED=success („Predat"). Iznosi formatDecimal + tabular-nums.
 */

/** Broj godina unazad ponuđenih u izboru (uklj. tekuću). */
const YEARS_BACK = 8;

type TabKey = 'bruto' | 'stanje' | 'uspeh';

const TABS: TabItem<TabKey>[] = [
  { key: 'bruto', label: 'Bruto bilans' },
  { key: 'stanje', label: 'Bilans stanja' },
  { key: 'uspeh', label: 'Bilans uspeha' },
];

/** Status obračuna → { tone, label } (generička mapa §7). */
function statusMeta(status: string): { tone: Tone; label: string } {
  switch (status) {
    case STATEMENT_STATUS.DRAFT:
      return { tone: 'neutral', label: 'Nacrt' };
    case STATEMENT_STATUS.FINALIZED:
      return { tone: 'success', label: 'Predat' };
    default:
      return { tone: 'neutral', label: status };
  }
}

// ─────────────────────────────────────────────────────────────── kolone

const grossColumns: Column<GrossTrialBalanceRow>[] = [
  {
    key: 'accountCode',
    header: 'Konto',
    render: (r) => <span className="tnums font-semibold text-ink">{r.accountCode}</span>,
  },
  {
    key: 'accountName',
    header: 'Naziv',
    render: (r) => <span className="text-ink-secondary">{r.accountName ?? '—'}</span>,
  },
  {
    key: 'totalDebit',
    header: 'Σ Duguje',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{formatDecimal(r.totalDebit)}</span>,
  },
  {
    key: 'totalCredit',
    header: 'Σ Potražuje',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{formatDecimal(r.totalCredit)}</span>,
  },
  {
    key: 'balance',
    header: 'Saldo',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums font-semibold text-ink">{formatDecimal(r.balance)}</span>,
  },
];

const lineColumns: Column<StatementLine>[] = [
  {
    key: 'aop',
    header: 'AOP',
    render: (l) => <span className="tnums font-semibold text-ink">{l.aop}</span>,
  },
  {
    key: 'label',
    header: 'Opis',
    render: (l) => <span className="text-ink-secondary">{l.label ?? '—'}</span>,
  },
  {
    key: 'amount',
    header: 'Tekuća g.',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums font-semibold text-ink">{formatDecimal(l.amount)}</span>,
  },
  {
    key: 'amount2',
    header: 'Prethodna g.',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink-secondary">{formatDecimal(l.amount2)}</span>,
  },
  {
    key: 'amount3',
    header: 'Pretprethodna g.',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink-secondary">{formatDecimal(l.amount3)}</span>,
  },
];

// ─────────────────────────────────────────────────────────────── kontrolna pravila

/** Sekcija kontrolnih pravila (zeleno/crveno) ispod bilansa. */
function ControlsSection({ controls }: { controls: ControlResult[] }) {
  if (controls.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        Kontrolna pravila
      </div>
      <div className="space-y-1.5">
        {controls.map((c) => (
          <div
            key={c.name}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-panel border px-4 py-2 text-sm ${
              c.passed
                ? 'border-status-success/40 bg-status-success-bg'
                : 'border-status-danger/40 bg-status-danger-bg'
            }`}
          >
            <span className="flex items-center gap-2">
              <StatusBadge
                tone={c.passed ? 'success' : 'danger'}
                label={c.passed ? 'Prolazi' : 'Ne prolazi'}
              />
              <span className="text-ink">{c.name}</span>
            </span>
            <span className="tnums text-ink-secondary">
              {formatDecimal(c.left)} = {formatDecimal(c.right)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── sumarni red

/** Sumarni red ispod tabele (label + do tri iznosa desno poravnata). */
function SummaryRow({
  label,
  values,
}: {
  label: string;
  values: string[];
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-panel border border-line bg-surface-2 px-4 py-2 text-sm">
      <span className="font-semibold uppercase tracking-[0.08em] text-2xs text-ink-secondary">
        {label}
      </span>
      <div className="flex gap-6">
        {values.map((v, i) => (
          <span key={i} className="tnums font-semibold text-ink">
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ZavrsniRacunPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [tab, setTab] = useState<TabKey>('bruto');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const yearOptions = useMemo(
    () =>
      Array.from({ length: YEARS_BACK }, (_, i) => {
        const y = currentYear - i;
        return { value: String(y), label: String(y) };
      }),
    [currentYear],
  );

  const gross = useGrossTrialBalance(year);
  const statements = useStatements({ year });
  const computeBS = useComputeBalanceSheet();
  const computeBU = useComputeIncomeStatement();
  const finalize = useFinalizeStatement();
  const aprXml = useAprXmlDownload();

  // Sačuvani obračuni za tekuću godinu, po tipu.
  const byType = useMemo(() => {
    const map = new Map<string, FinancialStatement>();
    for (const s of statements.data ?? []) {
      if (s.periodYear === year) map.set(s.statementType, s);
    }
    return map;
  }, [statements.data, year]);

  const balanceSheet = byType.get(STATEMENT_TYPE.BALANCE_SHEET) ?? null;
  const incomeStatement = byType.get(STATEMENT_TYPE.INCOME_STATEMENT) ?? null;
  const activeStatement = tab === 'stanje' ? balanceSheet : incomeStatement;

  // Kontrolna pravila za aktivni obračun (samo BS/BU tabovi; ugašeno bez id-a).
  const controls = useStatementControls(tab !== 'bruto' ? activeStatement?.id : undefined);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const computing = tab === 'stanje' ? computeBS : computeBU;
  const controlResults = controls.data ?? [];
  const isFinalized = activeStatement?.status === STATEMENT_STATUS.FINALIZED;

  function onCompute() {
    if (tab === 'stanje') computeBS.mutate(year);
    else if (tab === 'uspeh') computeBU.mutate(year);
  }

  function onFinalize() {
    if (!activeStatement) return;
    const anyFail = controlResults.some((c) => !c.passed);
    const msg = anyFail
      ? 'Kontrolna pravila NE prolaze (npr. aktiva razlicito od pasive). Finalizovati uprkos tome (force)?'
      : 'Finalizovati bilans? Posle finalizacije se ne moze ponovo generisati.';
    if (!window.confirm(msg)) return;
    finalize.mutate({ id: activeStatement.id, force: anyFail });
  }

  return (
    <AppShell>
      <PageHeader
        title="Završni račun / bilansi"
        count={`Godina ${year}`}
        actions={
          tab !== 'bruto' ? (
            <div className="flex items-center gap-2">
              {activeStatement && (
                <Button
                  variant="secondary"
                  loading={aprXml.isPending}
                  onClick={() =>
                    aprXml.mutate(activeStatement.id, {
                      onSuccess: (blob) =>
                        downloadXml(
                          blob,
                          `APR_${activeStatement.statementType}_${year}.xml`,
                        ),
                    })
                  }
                >
                  APR XML
                </Button>
              )}
              {activeStatement && !isFinalized && (
                <Button
                  variant="secondary"
                  loading={finalize.isPending}
                  onClick={onFinalize}
                >
                  Finalizuj
                </Button>
              )}
              <Button onClick={onCompute} loading={computing.isPending} disabled={isFinalized}>
                Izračunaj
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Godina
            <div className="w-32">
              <Select
                value={String(year)}
                onChange={(e) => setYear(Number(e.target.value))}
                options={yearOptions}
              />
            </div>
          </label>

          <Tabs tabs={TABS} value={tab} onChange={setTab} ariaLabel="Vrsta bilansa" />
        </div>

        {/* ─────────────────────────────────── Bruto bilans */}
        {tab === 'bruto' && (
          <BrutoBilans query={gross} />
        )}

        {/* ─────────────────────────────────── Bilans stanja / uspeha */}
        {tab !== 'bruto' && (
          <StatementView
            statement={activeStatement}
            controls={controlResults}
            loading={statements.isLoading}
            error={
              (finalize.error as Error | null) ??
              (computing.error as Error | null) ??
              (statements.error as Error | null)
            }
            emptyHint={
              tab === 'stanje'
                ? 'Bilans stanja za ovu godinu još nije generisan. Klikni „Izračunaj".'
                : 'Bilans uspeha za ovu godinu još nije generisan. Klikni „Izračunaj".'
            }
          />
        )}
      </div>
    </AppShell>
  );
}

// ─────────────────────────────────────────────────────────────── Bruto bilans blok

function BrutoBilans({
  query,
}: {
  query: ReturnType<typeof useGrossTrialBalance>;
}) {
  const rows = query.data?.rows ?? [];
  const totals = query.data?.totals;

  return (
    <div className="space-y-3">
      {query.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(query.error as Error).message}
        </div>
      )}

      <DataTable
        columns={grossColumns}
        rows={rows}
        rowKey={(r) => r.accountCode}
        loading={query.isLoading}
        empty={
          <EmptyState
            title="Nema prometa u glavnoj knjizi"
            hint="Za izabranu godinu nema knjiženih naloga — bruto bilans je prazan."
          />
        }
      />

      {totals && rows.length > 0 && (
        <SummaryRow
          label="Ukupno"
          values={[
            formatDecimal(totals.totalDebit),
            formatDecimal(totals.totalCredit),
            formatDecimal(totals.balance),
          ]}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── Bilans blok (BS/BU)

function StatementView({
  statement,
  controls,
  loading,
  error,
  emptyHint,
}: {
  statement: FinancialStatement | null;
  controls: ControlResult[];
  loading: boolean;
  error: Error | null;
  emptyHint: string;
}) {
  const lines = statement?.lines ?? [];
  const total = useMemo(() => {
    return lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  }, [lines]);

  const s = statement ? statusMeta(statement.status) : null;

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {error.message}
        </div>
      )}

      {statement && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-secondary">
          {s && <StatusBadge tone={s.tone} label={s.label} />}
          {!statement.seeded && (
            <StatusBadge tone="warn" label="Bez AOP formula — sirovi bilans po kontu" />
          )}
          {statement.note && <span className="text-xs">{statement.note}</span>}
        </div>
      )}

      {statement && lines.length > 0 && <ControlsSection controls={controls} />}

      <DataTable
        columns={lineColumns}
        rows={lines}
        rowKey={(l) => l.aop}
        loading={loading}
        empty={<EmptyState title="Bilans nije generisan" hint={emptyHint} />}
      />

      {statement && lines.length > 0 && (
        <SummaryRow label="Ukupno" values={[formatDecimal(total)]} />
      )}
    </div>
  );
}

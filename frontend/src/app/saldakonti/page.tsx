'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Tabs } from '@/components/ui-kit/tabs';
import { Button } from '@/components/ui-kit/button';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useOpenItems,
  useAging,
  useReconcile,
  useUnreconcile,
  useIosPdf,
  openPdf,
  type OpenItem,
  type AgingByPartnerRow,
} from '@/api/saldakonti';
import { CompensationPanel } from './compensation-panel';

/**
 * Saldakonti (Faza 4 §A). Obrazac „Lista" (DESIGN_SYSTEM §4.1): filter bar + gusta
 * tabela, sumiranje salda u header. Dva pogleda kroz Tabs (§10): „Otvorene stavke"
 * (selekcija → Upari) i „Aging" (komitent × bucket). Data isključivo kroz
 * `@/api/saldakonti` hook-ove; sve od kit komponenti i tokena.
 *
 * DOSPELOST → StatusBadge (§7 kanonska mapa, POSTOJEĆI tonovi): na vreme/nedospelo =
 * success, kašnjenje po bucketu 0-30 = warn, 31-90 = warn, 90+ = danger. Novi ton se
 * NE uvodi — mapiranje `dueTone` koristi postojeće tonove semantikom toka.
 */

type View = 'open' | 'aging' | 'compensation';

const TABS = [
  { key: 'open' as const, label: 'Otvorene stavke' },
  { key: 'aging' as const, label: 'Aging' },
  { key: 'compensation' as const, label: 'Kompenzacije' },
];

/** Zbir Decimal-as-string salda (za prikaz; knjiženje presuđuje backend). */
function sumBalances(values: string[]): number {
  return values.reduce((acc, v) => {
    const n = Number(v);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
}

/** daysOverdue → { tone, label } nad POSTOJEĆIM tonovima (§7). null = nedospelo. */
function dueMeta(daysOverdue: number | null): { tone: Tone; label: string } {
  if (daysOverdue == null) return { tone: 'neutral', label: 'Bez dospeća' };
  if (daysOverdue <= 0) return { tone: 'success', label: 'Na vreme' };
  if (daysOverdue <= 30) return { tone: 'warn', label: `Kasni ${daysOverdue} d` };
  if (daysOverdue <= 90) return { tone: 'warn', label: `Kasni ${daysOverdue} d` };
  return { tone: 'danger', label: `Kasni ${daysOverdue} d` };
}

export default function SaldakontiPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const can = useCan();
  const canReconcile = can(PERMISSIONS.SALDAKONTI_RECONCILE);

  const [view, setView] = useState<View>('open');
  const [accountCode, setAccountCode] = useState('');
  const [partnerId, setPartnerId] = useState('');
  // Primenjeni filteri (dugme „Primeni" / Enter) — odvojeni od unosa da svaki
  // pritisak tastera ne okida upit nad velikim ledger pogledom.
  const [applied, setApplied] = useState<{ accountCode: string; partnerId: string }>({
    accountCode: '',
    partnerId: '',
  });
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const partnerNum = applied.partnerId.trim() === '' ? '' : Number(applied.partnerId.trim());
  // Primenjena šifra komitenta (validan pozitivan broj) — gate za IOS obrazac.
  const appliedPartnerId =
    typeof partnerNum === 'number' && Number.isFinite(partnerNum) && partnerNum > 0
      ? partnerNum
      : null;
  const openItems = useOpenItems({
    accountCode: applied.accountCode.trim() || undefined,
    partnerId: typeof partnerNum === 'number' && Number.isFinite(partnerNum) ? partnerNum : '',
  });
  const aging = useAging(applied.accountCode.trim() || undefined);

  const rows = useMemo(() => openItems.data?.data ?? [], [openItems.data]);
  const agingRows = aging.data?.data ?? [];

  // Otvorene stavke nemaju stabilan id (izveden pogled) — ključ je kompozit.
  const rowKey = (r: OpenItem) =>
    `${r.accountCode}|${r.analyticalCode ?? ''}|${r.documentNumber ?? ''}`;

  const totalBalance = useMemo(() => sumBalances(rows.map((r) => r.balance)), [rows]);
  const selectedBalance = useMemo(
    () => sumBalances(rows.filter((_, i) => selected.has(i)).map((r) => r.balance)),
    [rows, selected],
  );

  // Uparivanje radi nad pojedinačnim ledger stavkama — izveden pogled sada izlaže
  // `ledgerEntryIds` po redu (C3/C4 koren). Skupimo id-eve svih selektovanih redova.
  const selectedEntryIds = useMemo(
    () =>
      rows.filter((_, i) => selected.has(i)).flatMap((r) => r.ledgerEntryIds ?? []),
    [rows, selected],
  );
  // Balans selekcije: Σ(saldo) ≈ 0 → auto uparivanje (bez ostatka); inače je
  // potrebno ručno zatvaranje sa ostatkom (kursna razlika/otpis).
  const balancedSelection = Math.abs(selectedBalance) < 0.01;

  const reconcile = useReconcile();
  const unreconcile = useUnreconcile();
  const iosPdf = useIosPdf();
  // Posle uspešnog uparivanja pamtimo grupu radi neposredne akcije Razveži
  // (open-items pogled prikazuje samo otvorene stavke pa uparena grupa nestane
  // iz liste — undo je smislen tačno ovde, odmah po uparivanju).
  const [lastGroup, setLastGroup] = useState<{ groupId: number; count: number } | null>(null);

  function runReconcile(mode: 'auto' | 'manual') {
    if (selectedEntryIds.length < 2) return;
    reconcile.mutate(
      { entryIds: selectedEntryIds, mode },
      {
        onSuccess: (res) => {
          setSelected(new Set());
          setLastGroup({ groupId: res.data.groupId, count: res.data.entryIds.length });
        },
      },
    );
  }

  function runUnreconcile() {
    if (!lastGroup) return;
    unreconcile.mutate(lastGroup.groupId, { onSuccess: () => setLastGroup(null) });
  }

  function toggleRow(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((_, i) => i))));
  }

  function applyFilters() {
    setApplied({ accountCode, partnerId });
    setSelected(new Set());
  }

  function clearFilters() {
    setAccountCode('');
    setPartnerId('');
    setApplied({ accountCode: '', partnerId: '' });
    setSelected(new Set());
  }

  // Broj selektovanih redova (za prikaz i gate dugmeta Upari); id-evi stavki
  // koje idu na reconcile su u `selectedEntryIds` (izveden pogled sada izlaže
  // ledgerEntryIds po redu).
  const selectedCount = selected.size;

  const openColumns: Column<OpenItem>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Selektuj sve"
          className="h-4 w-4 accent-accent"
          checked={rows.length > 0 && selected.size === rows.length}
          onChange={toggleAll}
          disabled={!canReconcile || rows.length === 0}
          onClick={(e) => e.stopPropagation()}
        />
      ),
      render: (r) => {
        const idx = rows.indexOf(r);
        return (
          <input
            type="checkbox"
            aria-label="Selektuj stavku"
            className="h-4 w-4 accent-accent"
            checked={selected.has(idx)}
            onChange={() => toggleRow(idx)}
            disabled={!canReconcile}
            onClick={(e) => e.stopPropagation()}
          />
        );
      },
    },
    {
      key: 'accountCode',
      header: 'Konto',
      render: (r) => <span className="tnums font-semibold text-ink">{r.accountCode}</span>,
    },
    {
      key: 'partner',
      header: 'Komitent',
      render: (r) => (
        <span className="tnums text-ink">{r.analyticalCode ?? '—'}</span>
      ),
    },
    {
      key: 'documentNumber',
      header: 'Broj dokumenta',
      render: (r) => <span className="tnums text-ink-secondary">{r.documentNumber ?? '—'}</span>,
    },
    {
      key: 'balance',
      header: 'Saldo',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink">{formatDecimal(r.balance)}</span>,
    },
    {
      key: 'dueDate',
      header: 'Dospeće',
      render: (r) => <span className="text-ink-secondary">{formatDate(r.dueDate)}</span>,
    },
    {
      key: 'daysOverdue',
      header: 'Kašnjenje',
      render: (r) => {
        const m = dueMeta(r.daysOverdue);
        return <StatusBadge tone={m.tone} label={m.label} />;
      },
    },
  ];

  const agingColumns: Column<AgingByPartnerRow>[] = [
    {
      key: 'partner',
      header: 'Komitent',
      render: (r) => <span className="tnums font-semibold text-ink">{r.analyticalCode ?? '—'}</span>,
    },
    {
      key: 'bucket0_30',
      header: '0–30',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink">{formatDecimal(r.bucket0_30)}</span>,
    },
    {
      key: 'bucket31_60',
      header: '31–60',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-status-warn">{formatDecimal(r.bucket31_60)}</span>,
    },
    {
      key: 'bucket61_90',
      header: '61–90',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-status-warn">{formatDecimal(r.bucket61_90)}</span>,
    },
    {
      key: 'bucket90plus',
      header: '90+',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-status-danger">{formatDecimal(r.bucket90plus)}</span>,
    },
    {
      key: 'total',
      header: 'Σ',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums font-semibold text-ink">{formatDecimal(r.total)}</span>,
    },
  ];

  // Aging footer: Σ po bucketu preko svih komitenata.
  const agingTotals = useMemo(() => {
    return {
      b0: sumBalances(agingRows.map((r) => r.bucket0_30)),
      b31: sumBalances(agingRows.map((r) => r.bucket31_60)),
      b61: sumBalances(agingRows.map((r) => r.bucket61_90)),
      b90: sumBalances(agingRows.map((r) => r.bucket90plus)),
      total: sumBalances(agingRows.map((r) => r.total)),
    };
  }, [agingRows]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const activeError = view === 'open' ? openItems.error : aging.error;
  const countLabel =
    view === 'open'
      ? openItems.data
        ? `${formatNumber(openItems.data.meta.count)} stavki`
        : undefined
      : aging.data
        ? `${formatNumber(aging.data.meta.count)} komitenata`
        : undefined;

  return (
    <AppShell>
      <PageHeader title="Saldakonti" count={countLabel} />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs tabs={TABS} value={view} onChange={setView} ariaLabel="Saldakonti pogledi" />

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Konto
            <input
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
              placeholder="Svi"
              inputMode="numeric"
              className="tnums h-9 w-40 rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            />
          </label>

          {view === 'open' && (
            <label className="flex flex-col gap-1 text-xs text-ink-secondary">
              Komitent (šifra)
              <input
                value={partnerId}
                onChange={(e) => setPartnerId(e.target.value)}
                placeholder="Svi"
                inputMode="numeric"
                className="tnums h-9 w-40 rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
              />
            </label>
          )}

          <Button type="submit" variant="secondary">
            Primeni
          </Button>

          {(applied.accountCode !== '' || applied.partnerId !== '') && (
            <Button type="button" variant="ghost" onClick={clearFilters}>
              Očisti
            </Button>
          )}
        </form>

        {activeError && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(activeError as Error).message}
          </div>
        )}

        {view === 'compensation' ? (
          <CompensationPanel />
        ) : view === 'open' ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                <span className="text-ink-secondary">
                  Ukupan saldo:{' '}
                  <span className="tnums font-semibold text-ink">
                    {formatDecimal(totalBalance)}
                  </span>
                </span>
                {selectedCount > 0 && (
                  <span className="text-ink-secondary">
                    Selektovano ({selectedCount}):{' '}
                    <span className="tnums font-semibold text-ink">
                      {formatDecimal(selectedBalance)}
                    </span>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {appliedPartnerId != null && (
                  <Button
                    type="button"
                    variant="secondary"
                    loading={iosPdf.isPending}
                    title="Štampa IOS/NIOS obrasca usaglašavanja salda za izabranog komitenta"
                    onClick={() =>
                      iosPdf.mutate(
                        { partnerId: appliedPartnerId },
                        { onSuccess: openPdf },
                      )
                    }
                  >
                    IOS obrazac
                  </Button>
                )}
                {canReconcile && (
                  <>
                    {selectedCount >= 2 && !balancedSelection && (
                      <Button
                        type="button"
                        variant="secondary"
                        loading={reconcile.isPending}
                        title="Zatvori selektovane stavke sa ostatkom (kursna razlika/otpis)"
                        onClick={() => runReconcile('manual')}
                      >
                        Zatvori sa ostatkom
                      </Button>
                    )}
                    <Button
                      type="button"
                      disabled={selectedCount < 2}
                      loading={reconcile.isPending}
                      title={
                        selectedCount < 2
                          ? 'Za uparivanje selektuj bar dve stavke'
                          : balancedSelection
                            ? 'Upari selektovane stavke'
                            : 'Selekcija ne balansira — koristi Zatvori sa ostatkom'
                      }
                      onClick={() => runReconcile('auto')}
                    >
                      Upari ({selectedCount})
                    </Button>
                  </>
                )}
              </div>
            </div>

            {lastGroup && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-3 text-sm text-status-success">
                <span>
                  Upareno {lastGroup.count} stavki (grupa #{lastGroup.groupId}).
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  loading={unreconcile.isPending}
                  onClick={runUnreconcile}
                >
                  Razveži
                </Button>
              </div>
            )}

            {reconcile.error && (
              <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
                {(reconcile.error as Error).message}
              </div>
            )}

            {unreconcile.error && (
              <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
                {(unreconcile.error as Error).message}
              </div>
            )}

            {iosPdf.error && (
              <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
                {(iosPdf.error as Error).message}
              </div>
            )}

            <DataTable
              columns={openColumns}
              rows={rows}
              rowKey={rowKey}
              loading={openItems.isLoading}
              empty={
                <EmptyState
                  title="Nema otvorenih stavki"
                  hint="Promeni filter po kontu ili komitentu. Zatvorene stavke se ne prikazuju."
                />
              }
            />
          </>
        ) : (
          <>
            <div className="text-sm text-ink-secondary">
              Ukupno dospelo:{' '}
              <span className="tnums font-semibold text-ink">
                {formatDecimal(agingTotals.total)}
              </span>
            </div>

            <DataTable
              columns={agingColumns}
              rows={agingRows}
              rowKey={(r) => r.analyticalCode ?? 'null'}
              loading={aging.isLoading}
              empty={
                <EmptyState
                  title="Nema podataka za aging"
                  hint="Promeni filter po kontu. Aging se računa iz otvorenih stavki po dospelosti."
                />
              }
            />

            {agingRows.length > 0 && (
              <div className="overflow-x-auto rounded-panel border border-line bg-surface-2">
                <table className="w-full text-sm">
                  <tbody>
                    <tr className="h-[var(--table-row-height)]">
                      <td className="px-4 font-semibold text-ink">Σ ukupno</td>
                      <td className="tnums px-4 text-right text-ink">
                        {formatDecimal(agingTotals.b0)}
                      </td>
                      <td className="tnums px-4 text-right text-status-warn">
                        {formatDecimal(agingTotals.b31)}
                      </td>
                      <td className="tnums px-4 text-right text-status-warn">
                        {formatDecimal(agingTotals.b61)}
                      </td>
                      <td className="tnums px-4 text-right text-status-danger">
                        {formatDecimal(agingTotals.b90)}
                      </td>
                      <td className="tnums px-4 text-right font-semibold text-ink">
                        {formatDecimal(agingTotals.total)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

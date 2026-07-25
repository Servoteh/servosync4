'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { cn } from '@/lib/cn';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Select } from '@/components/ui-kit/select';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDate, formatDateTime, formatDecimal, formatNumber } from '@/lib/format';
import {
  useCollectionDashboard,
  useReconcileSmallBalances,
  useDunningCandidates,
  useDunningSend,
  useDunningSendBatch,
  type CollectionDashboard,
  type TopDebtor,
  type DunningCandidate,
} from '@/api/saldakonti';

/**
 * Naplata — dashboard naplate (Talas 3 §A7). Obrazac „Lista" sa bogatim
 * zaglavljem (DESIGN_SYSTEM §4.1): KPI kartice (potraživanja/obaveze/DSO/dospelo),
 * aging strip po bucketu i tabela top dužnika sa heatmap ćelijama (tonalitet po
 * bucketu, intenzitet po udelu). Klik na dužnika → kartica komitenta. Data
 * isključivo kroz `@/api/saldakonti` hook-ove; sve od kit komponenti i tokena.
 *
 * MaxSaldo: dugme (SALDAKONTI_RECONCILE) → dijalog sa pragom (default 1,00) →
 * zatvori sve otvorene grupe sa |saldo| ≤ prag; rezultat prikazuje broj grupa.
 */

// ── heatmap: tonalitet po bucketu (0-30 blago → 90+ oštro), intenzitet 0..3 ──
type BucketKey = 'b0' | 'b31' | 'b61' | 'b90';

// Statički literali klasa (JIT-safe): [level0 = bez fila, level1, level2, level3].
const HEAT: Record<BucketKey, [string, string, string, string]> = {
  b0: ['text-ink', 'bg-status-success/10 text-ink', 'bg-status-success/20 text-ink', 'bg-status-success/30 text-ink'],
  b31: ['text-status-warn', 'bg-status-warn/15 text-ink', 'bg-status-warn/25 text-ink', 'bg-status-warn/40 text-ink'],
  b61: ['text-status-warn', 'bg-status-warn/25 text-ink', 'bg-status-warn/35 text-ink', 'bg-status-warn/50 text-ink'],
  b90: ['text-status-danger', 'bg-status-danger/10 text-ink', 'bg-status-danger/25 text-ink', 'bg-status-danger/45 text-ink'],
};

function num(v: string | number): number {
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Nivo intenziteta 0..3 iz udela vrednosti u kolonskom maksimumu. */
function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 {
  if (value <= 0 || max <= 0) return 0;
  const share = value / max;
  if (share < 0.34) return 1;
  if (share < 0.67) return 2;
  return 3;
}

function HeatCell({ value, bucket, max }: { value: string; bucket: BucketKey; max: number }) {
  const level = heatLevel(Math.max(0, num(value)), max);
  return (
    <span className={cn('inline-block rounded-control px-2 py-0.5 tnums', HEAT[bucket][level])}>
      {formatDecimal(value)}
    </span>
  );
}

/** KPI kartica — naslov (uppercase) + veliki broj + opcioni ton/podnaslov. */
function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'ink' | 'warn' | 'danger' | 'success';
}) {
  const valueTone =
    tone === 'danger'
      ? 'text-status-danger'
      : tone === 'warn'
        ? 'text-status-warn'
        : tone === 'success'
          ? 'text-status-success'
          : 'text-ink';
  return (
    <div className="min-w-0 rounded-panel border border-line bg-surface px-4 py-3">
      <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {label}
      </div>
      <div className={cn('tnums mt-1 truncate text-lg font-semibold', valueTone)}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-2xs text-ink-secondary">{hint}</div>}
    </div>
  );
}

// ── Opomene: nivo 1|2|3 → ton badža (info → warn → danger) ──────────────────
function nivoTone(level: number): Tone {
  return level >= 3 ? 'danger' : level === 2 ? 'warn' : 'info';
}

const LEVEL_OPTIONS = [
  { value: '1', label: 'Nivo 1 — opomena (15–30 dana)' },
  { value: '2', label: 'Nivo 2 — opomena (31–60 dana)' },
  { value: '3', label: 'Nivo 3 — pred utuženje (61+ dana)' },
];

export default function NaplataPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const can = useCan();
  const canReconcile = can(PERMISSIONS.SALDAKONTI_RECONCILE);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const dashboard = useCollectionDashboard();
  const data: CollectionDashboard | undefined = dashboard.data?.data;
  const debtors = useMemo(() => data?.topDebtors ?? [], [data]);

  // MaxSaldo dijalog
  const [maxOpen, setMaxOpen] = useState(false);
  const [threshold, setThreshold] = useState('1.00');
  const reconcileSmall = useReconcileSmallBalances();
  const smallResult = reconcileSmall.data?.data;

  const thresholdNum = num(threshold);
  const thresholdValid = threshold.trim() !== '' && thresholdNum > 0;

  function runMaxSaldo() {
    if (!thresholdValid) return;
    // Decimal na backendu očekuje tačku — normalizujemo eventualni zarez.
    reconcileSmall.mutate({ threshold: threshold.trim().replace(',', '.') });
  }

  function closeMaxDialog() {
    setMaxOpen(false);
    reconcileSmall.reset();
  }

  // ── Opomene (dunning) — kandidati + pojedinačno/masovno slanje ──────────────
  const dunning = useDunningCandidates();
  const candidates = useMemo<DunningCandidate[]>(() => dunning.data?.data ?? [], [dunning.data]);
  const eligibleCount = useMemo(
    () => candidates.filter((c) => !c.alreadySentToday).length,
    [candidates],
  );

  const dunSend = useDunningSend();
  const dunBatch = useDunningSendBatch();
  const sendResult = dunSend.data?.data;
  const batchResult = dunBatch.data?.data;

  const [sendTarget, setSendTarget] = useState<DunningCandidate | null>(null);
  const [sendLevel, setSendLevel] = useState('1');
  const [sendEmail, setSendEmail] = useState('');
  const [batchOpen, setBatchOpen] = useState(false);

  function openSend(c: DunningCandidate) {
    dunSend.reset();
    setSendTarget(c);
    setSendLevel(String(c.level));
    setSendEmail(c.email ?? '');
  }
  function closeSend() {
    setSendTarget(null);
    dunSend.reset();
  }
  function runSend() {
    if (!sendTarget) return;
    const to = sendEmail.trim();
    dunSend.mutate({
      partnerId: sendTarget.partnerId,
      level: Number(sendLevel),
      to: to || undefined,
    });
  }
  function closeBatch() {
    setBatchOpen(false);
    dunBatch.reset();
  }
  function runBatch() {
    dunBatch.mutate({});
  }

  // Kolonski maksimumi za heatmap (self-normalizacija svake bucket kolone).
  const heatMax = useMemo(() => {
    const m = { b0: 0, b31: 0, b61: 0, b90: 0 };
    for (const d of debtors) {
      m.b0 = Math.max(m.b0, num(d.bucket0_30));
      m.b31 = Math.max(m.b31, num(d.bucket31_60));
      m.b61 = Math.max(m.b61, num(d.bucket61_90));
      m.b90 = Math.max(m.b90, num(d.bucket90plus));
    }
    return m;
  }, [debtors]);

  const columns: Column<TopDebtor>[] = [
    {
      key: 'partner',
      header: 'Komitent',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">
            {r.partnerName ?? (r.partnerId != null ? `Komitent ${r.partnerId}` : '—')}
          </div>
          {r.partnerId != null && (
            <div className="tnums text-2xs text-ink-secondary">#{r.partnerId}</div>
          )}
        </div>
      ),
    },
    {
      key: 'b0',
      header: '0–30',
      align: 'right',
      numeric: true,
      render: (r) => <HeatCell value={r.bucket0_30} bucket="b0" max={heatMax.b0} />,
    },
    {
      key: 'b31',
      header: '31–60',
      align: 'right',
      numeric: true,
      render: (r) => <HeatCell value={r.bucket31_60} bucket="b31" max={heatMax.b31} />,
    },
    {
      key: 'b61',
      header: '61–90',
      align: 'right',
      numeric: true,
      render: (r) => <HeatCell value={r.bucket61_90} bucket="b61" max={heatMax.b61} />,
    },
    {
      key: 'b90',
      header: '90+',
      align: 'right',
      numeric: true,
      render: (r) => <HeatCell value={r.bucket90plus} bucket="b90" max={heatMax.b90} />,
    },
    {
      key: 'total',
      header: 'Σ saldo',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums font-semibold text-ink">{formatDecimal(r.total)}</span>,
    },
  ];

  const dunningColumns: Column<DunningCandidate>[] = [
    {
      key: 'partner',
      header: 'Komitent',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">
            {r.partnerName ?? `Komitent ${r.partnerId}`}
          </div>
          <div className="tnums text-2xs text-ink-secondary">#{r.partnerId}</div>
        </div>
      ),
    },
    {
      key: 'overdue',
      header: 'Dospelo',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className="tnums font-semibold text-ink">{formatDecimal(r.overdueAmount)}</span>
      ),
    },
    {
      key: 'days',
      header: 'Dana',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink">{formatNumber(r.daysOverdue)}</span>,
    },
    {
      key: 'level',
      header: 'Nivo',
      render: (r) => <StatusBadge tone={nivoTone(r.level)} label={`Nivo ${r.level}`} />,
    },
    {
      key: 'last',
      header: 'Poslednja opomena',
      render: (r) =>
        r.lastSentAt ? (
          <div className="min-w-0">
            <div className="text-ink">{formatDateTime(r.lastSentAt)}</div>
            <div className="text-2xs text-ink-secondary">
              {r.lastSentLevel != null ? `nivo ${r.lastSentLevel}` : ''}
              {r.alreadySentToday ? ' · danas' : ''}
            </div>
          </div>
        ) : (
          <span className="text-ink-secondary">—</span>
        ),
    },
  ];

  if (canReconcile) {
    dunningColumns.push({
      key: 'action',
      header: '',
      align: 'right',
      render: (r) => (
        <Button
          variant="secondary"
          onClick={(e) => {
            e.stopPropagation();
            openSend(r);
          }}
        >
          {r.alreadySentToday ? 'Ponovo' : 'Pošalji'}
        </Button>
      ),
    });
  }

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
        title="Naplata"
        count={data ? `presek ${formatDate(data.asOf)}` : undefined}
        actions={
          canReconcile ? (
            <Button variant="secondary" onClick={() => setMaxOpen(true)}>
              Zatvori sitne saldove
            </Button>
          ) : undefined
        }
      />

      <div className="flex-1 space-y-5 overflow-auto p-6">
        {dashboard.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(dashboard.error as Error).message}
          </div>
        )}

        {/* KPI kartice */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <StatTile
            label="Potraživanja"
            value={formatDecimal(data?.totalReceivable ?? '0')}
            hint={data ? `${formatNumber(data.receivableOpenCount)} otvorenih` : undefined}
          />
          <StatTile label="Obaveze" value={formatDecimal(data?.totalPayable ?? '0')} />
          <StatTile
            label="Neto potraživanja"
            value={formatDecimal(data?.netReceivable ?? '0')}
          />
          <StatTile
            label="DSO (dani)"
            value={data ? formatDecimal(data.dso, 1) : '—'}
            hint="ponderisano iznosom"
          />
          <StatTile
            label="Dospelo potraživanja"
            value={formatDecimal(data?.overdueReceivable ?? '0')}
            tone={data && num(data.overdueReceivable) > 0 ? 'danger' : 'ink'}
          />
        </div>

        {/* Aging strip po bucketu (ukupno) */}
        <div>
          <div className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Starost otvorenih stavki (aging)
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="0–30 dana" value={formatDecimal(data?.aging.bucket0_30 ?? '0')} tone="success" />
            <StatTile label="31–60 dana" value={formatDecimal(data?.aging.bucket31_60 ?? '0')} tone="warn" />
            <StatTile label="61–90 dana" value={formatDecimal(data?.aging.bucket61_90 ?? '0')} tone="warn" />
            <StatTile label="90+ dana" value={formatDecimal(data?.aging.bucket90plus ?? '0')} tone="danger" />
          </div>
        </div>

        {/* Top dužnici */}
        <div className="space-y-2">
          <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Top dužnici
          </div>
          <DataTable
            columns={columns}
            rows={debtors}
            rowKey={(r) => r.partnerId ?? 'null'}
            onRowActivate={(r) => {
              if (r.partnerId != null) router.push(`/saldakonti/kartica?partnerId=${r.partnerId}`);
            }}
            loading={dashboard.isLoading}
            empty={
              <EmptyState
                title="Nema dužnika"
                hint="Nema otvorenih potraživanja u pregledu. Dashboard se računa iz otvorenih stavki."
              />
            }
          />
        </div>

        {/* Opomene (dunning) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              Opomene
            </div>
            {canReconcile && eligibleCount > 0 && (
              <Button variant="secondary" onClick={() => setBatchOpen(true)}>
                Pošalji sve ({formatNumber(eligibleCount)})
              </Button>
            )}
          </div>
          {dunning.error && (
            <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
              {(dunning.error as Error).message}
            </div>
          )}
          <DataTable
            columns={dunningColumns}
            rows={candidates}
            rowKey={(r) => r.partnerId}
            onRowActivate={canReconcile ? (r) => openSend(r) : undefined}
            loading={dunning.isLoading}
            empty={
              <EmptyState
                title="Nema kandidata za opomenu"
                hint="Nema komitenata sa dospelim potraživanjima preko 15 dana docnje."
              />
            }
          />
        </div>
      </div>

      <Dialog
        open={maxOpen}
        onClose={closeMaxDialog}
        title="Zatvori sitne saldove (MaxSaldo)"
        size="md"
        dismissable={!reconcileSmall.isPending}
        footer={
          smallResult ? (
            <Button variant="secondary" onClick={closeMaxDialog}>
              Zatvori
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeMaxDialog} disabled={reconcileSmall.isPending}>
                Otkaži
              </Button>
              <Button onClick={runMaxSaldo} loading={reconcileSmall.isPending} disabled={!thresholdValid}>
                Zatvori grupe
              </Button>
            </>
          )
        }
      >
        {smallResult ? (
          <div className="space-y-3 text-sm">
            <div className="rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-3 text-status-success">
              Zatvoreno grupa:{' '}
              <span className="tnums font-semibold">{formatNumber(smallResult.closedGroups)}</span>{' '}
              (prag {formatDecimal(smallResult.threshold)} RSD).
            </div>
            <div className="text-ink-secondary">
              Ukupan zatvoren saldo:{' '}
              <span className="tnums font-semibold text-ink">
                {formatDecimal(smallResult.totalAmount)}
              </span>{' '}
              RSD.
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">
              Zatvara sve otvorene grupe sa saldom do zadatog praga (u apsolutnoj vrednosti).
              Razlika se NE knjiži kao otpis — postavlja se samo oznaka zatvaranja.
            </p>
            <label className="flex flex-col gap-1 text-xs text-ink-secondary">
              Prag (RSD)
              <input
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    runMaxSaldo();
                  }
                }}
                inputMode="decimal"
                autoFocus
                className="tnums h-9 w-40 rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
              />
            </label>
            {!thresholdValid && (
              <p className="text-2xs text-status-danger">Prag mora biti pozitivan broj.</p>
            )}
            {reconcileSmall.error && (
              <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
                {(reconcileSmall.error as Error).message}
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* Opomena — pojedinačno slanje (nivo + primalac + potvrda) */}
      <Dialog
        open={sendTarget != null}
        onClose={closeSend}
        title="Pošalji opomenu"
        size="md"
        dismissable={!dunSend.isPending}
        footer={
          sendResult ? (
            <Button variant="secondary" onClick={closeSend}>
              Zatvori
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeSend} disabled={dunSend.isPending}>
                Otkaži
              </Button>
              <Button
                onClick={runSend}
                loading={dunSend.isPending}
                disabled={sendEmail.trim() === ''}
              >
                Pošalji opomenu
              </Button>
            </>
          )
        }
      >
        {sendTarget &&
          (sendResult ? (
            <div className="space-y-3 text-sm">
              <div
                className={cn(
                  'rounded-panel border px-4 py-3',
                  sendResult.sentOk
                    ? 'border-status-success/40 bg-status-success-bg text-status-success'
                    : 'border-status-warn/40 bg-status-warn-bg text-status-warn',
                )}
              >
                {sendResult.sentOk
                  ? `Opomena nivoa ${sendResult.level} poslata na ${sendResult.to}.`
                  : `Opomena nivoa ${sendResult.level} evidentirana (mejl nije poslat — slanje nije konfigurisano).`}
              </div>
              <div className="text-ink-secondary">
                Dospelo:{' '}
                <span className="tnums font-semibold text-ink">
                  {formatDecimal(sendResult.overdueAmount)}
                </span>{' '}
                RSD · kašnjenje {formatNumber(sendResult.daysOverdue)} dana.
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-panel border border-line bg-surface-2 px-4 py-3 text-sm">
                <div className="font-medium text-ink">
                  {sendTarget.partnerName ?? `Komitent ${sendTarget.partnerId}`}
                </div>
                <div className="mt-1 text-ink-secondary">
                  Dospelo{' '}
                  <span className="tnums font-semibold text-ink">
                    {formatDecimal(sendTarget.overdueAmount)}
                  </span>{' '}
                  RSD · najstarije kašnjenje {formatNumber(sendTarget.daysOverdue)} dana.
                </div>
                {sendTarget.alreadySentToday && (
                  <div className="mt-1 text-2xs text-status-warn">
                    Opomena ovog nivoa je već poslata danas — ponovno slanje daće grešku.
                  </div>
                )}
              </div>
              <label className="flex flex-col gap-1 text-xs text-ink-secondary">
                Nivo opomene
                <Select
                  options={LEVEL_OPTIONS}
                  value={sendLevel}
                  onChange={(e) => setSendLevel(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-ink-secondary">
                Primalac (mejl)
                <input
                  value={sendEmail}
                  onChange={(e) => setSendEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      runSend();
                    }
                  }}
                  type="email"
                  inputMode="email"
                  placeholder="mejl komitenta"
                  className="h-9 w-full rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                />
              </label>
              {sendEmail.trim() === '' && (
                <p className="text-2xs text-status-danger">
                  Unesite mejl primaoca (komitent nema e-adresu u šifarniku).
                </p>
              )}
              {dunSend.error && (
                <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
                  {(dunSend.error as Error).message}
                </div>
              )}
            </div>
          ))}
      </Dialog>

      {/* Opomene — masovno slanje (potvrda sa brojem) */}
      <Dialog
        open={batchOpen}
        onClose={closeBatch}
        title="Pošalji sve opomene"
        size="md"
        dismissable={!dunBatch.isPending}
        footer={
          batchResult ? (
            <Button variant="secondary" onClick={closeBatch}>
              Zatvori
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeBatch} disabled={dunBatch.isPending}>
                Otkaži
              </Button>
              <Button onClick={runBatch} loading={dunBatch.isPending} disabled={eligibleCount === 0}>
                Pošalji ({formatNumber(eligibleCount)})
              </Button>
            </>
          )
        }
      >
        {batchResult ? (
          <div className="space-y-3 text-sm">
            <div className="rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-3 text-status-success">
              Poslato:{' '}
              <span className="tnums font-semibold">{formatNumber(batchResult.sent)}</span>
            </div>
            <div className="text-ink-secondary">
              Preskočeno:{' '}
              <span className="tnums font-semibold text-ink">
                {formatNumber(batchResult.skipped)}
              </span>{' '}
              · Neuspešno:{' '}
              <span className="tnums font-semibold text-ink">
                {formatNumber(batchResult.failed)}
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">
              Šalje opomenu svim kandidatima koji danas još nisu dobili opomenu tog nivoa
              (najviše 50 po pozivu). Nivo se određuje po najstarijem kašnjenju.
            </p>
            <p className="text-sm text-ink">
              Kandidata za slanje:{' '}
              <span className="tnums font-semibold">{formatNumber(eligibleCount)}</span>.
            </p>
            {dunBatch.error && (
              <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
                {(dunBatch.error as Error).message}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </AppShell>
  );
}

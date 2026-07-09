'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  useSessionsDaily,
  useSessionsSummary,
  useSessionsHourly,
  useSessionsPoorlyRecorded,
  type DailyRow,
  type SummaryRow,
  type HourlyRow,
  type PoorlyRow,
} from '@/api/session-analytics';
import { useOperations, type Operation } from '@/api/structures';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';

type View = 'daily' | 'summary' | 'hourly' | 'poorly';

const VIEWS: { key: View; label: string }[] = [
  { key: 'daily', label: 'Dnevnik' },
  { key: 'summary', label: 'Zbir vs normirano' },
  { key: 'hourly', label: 'Po satu' },
  { key: 'poorly', label: 'Loše evidentirani' },
];

const REASON_META: Record<string, { tone: Tone; label: string }> = {
  bez_stopa: { tone: 'warn', label: 'Bez STOP-a' },
  negativno: { tone: 'danger', label: 'Negativno vreme' },
  auto_zatvoreno: { tone: 'info', label: 'Auto-zatvoreno' },
  preko_dana: { tone: 'warn', label: 'Preko dana' },
};

/** Minuti → „2 h 5 min" / „45 min". */
function fmtMin(min: number): string {
  const m = Math.round(min);
  if (m <= 0) return '—';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export default function SessionAnalyticsPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<View>('daily');
  const [rc, setRc] = useState<Operation | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const params = {
    from: from || undefined,
    to: to ? `${to}T23:59:59` : undefined,
    workCenterCode: rc?.workCenterCode,
    page,
  };
  const daily = useSessionsDaily({ ...params, page: undefined });
  const summary = useSessionsSummary(params);
  const hourly = useSessionsHourly({ ...params, page: undefined });
  const poorly = useSessionsPoorlyRecorded(params);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  const resetPage = () => setPage(1);

  const dailyCols: Column<DailyRow>[] = [
    { key: 'day', header: 'Dan', render: (r) => <span className="tnums font-semibold text-ink">{formatDate(r.day)}</span> },
    { key: 'sessionCount', header: 'Operacija', align: 'right', numeric: true, render: (r) => <span className="tnums">{formatNumber(r.sessionCount)}</span> },
    { key: 'workerCount', header: 'Radnika', align: 'right', numeric: true, render: (r) => <span className="tnums">{formatNumber(r.workerCount)}</span> },
    { key: 'pieces', header: 'Komada', align: 'right', numeric: true, render: (r) => <span className="tnums">{formatNumber(r.pieces)}</span> },
    { key: 'elapsed', header: 'Utrošeno (mereno)', align: 'right', render: (r) => <span className="tnums text-ink-secondary">{fmtMin(r.elapsedMinutes)}</span> },
    { key: 'open', header: 'Otvoreno', align: 'right', numeric: true, render: (r) => (r.openCount > 0 ? <StatusBadge tone="info" label={String(r.openCount)} /> : <span className="text-ink-disabled">0</span>) },
  ];

  const summaryCols: Column<SummaryRow>[] = [
    { key: 'ident', header: 'RN / Ident', render: (r) => <span className="tnums font-semibold text-ink">{r.identNumber}</span> },
    { key: 'op', header: 'Op.', align: 'right', numeric: true, render: (r) => <span className="tnums text-ink-secondary">{r.operationNumber}</span> },
    { key: 'rc', header: 'Radni centar', render: (r) => r.workCenterName ?? r.workCenterCode },
    { key: 'made', header: 'Kom', align: 'right', numeric: true, render: (r) => <span className="tnums">{formatNumber(r.made)}</span> },
    { key: 'actual', header: 'Utrošeno', align: 'right', render: (r) => <span className="tnums">{fmtMin(r.actualMinutes)}</span> },
    { key: 'norm', header: 'Normirano', align: 'right', render: (r) => (r.hasNorm ? <span className="tnums text-ink-secondary">{fmtMin(r.normMinutes)}</span> : <span className="text-ink-disabled">—</span>) },
    {
      key: 'diff',
      header: 'Razlika',
      align: 'right',
      render: (r) => {
        if (!r.hasNorm || (r.actualMinutes === 0 && r.normMinutes === 0)) return <span className="text-ink-disabled">—</span>;
        const over = r.diffMinutes > 0;
        return (
          <span className={over ? 'tnums font-semibold text-status-danger' : 'tnums font-semibold text-status-success'}>
            {over ? '+' : ''}{fmtMin(Math.abs(r.diffMinutes))}
          </span>
        );
      },
    },
  ];

  const hourlyCols: Column<HourlyRow>[] = [
    { key: 'hour', header: 'Sat', render: (r) => <span className="tnums font-semibold text-ink">{r.hourLocal}</span> },
    { key: 'sessionCount', header: 'Operacija', align: 'right', numeric: true, render: (r) => <span className="tnums">{formatNumber(r.sessionCount)}</span> },
    { key: 'workerCount', header: 'Radnika', align: 'right', numeric: true, render: (r) => <span className="tnums">{formatNumber(r.workerCount)}</span> },
    { key: 'pieces', header: 'Komada', align: 'right', numeric: true, render: (r) => <span className="tnums">{formatNumber(r.pieces)}</span> },
    { key: 'minutes', header: 'Mereno', align: 'right', render: (r) => <span className="tnums text-ink-secondary">{fmtMin(r.minutes)}</span> },
  ];

  const poorlyCols: Column<PoorlyRow>[] = [
    { key: 'ident', header: 'RN / Ident', render: (r) => <span className="tnums font-semibold text-ink">{r.identNumber}</span> },
    { key: 'op', header: 'Op.', align: 'right', numeric: true, render: (r) => <span className="tnums text-ink-secondary">{r.operationNumber}</span> },
    { key: 'rc', header: 'Radni centar', render: (r) => r.workCenterName ?? r.workCenterCode },
    { key: 'worker', header: 'Radnik', render: (r) => <span className="text-ink-secondary">{r.worker?.fullName ?? '—'}</span> },
    { key: 'start', header: 'Početak', render: (r) => <span className="text-ink-secondary">{formatDateTime(r.startedAt)}</span> },
    { key: 'stop', header: 'Kraj', render: (r) => (r.stoppedAt ? <span className="text-ink-secondary">{formatDateTime(r.stoppedAt)}</span> : <span className="text-ink-disabled">—</span>) },
    {
      key: 'reason',
      header: 'Problem',
      render: (r) => {
        const m = REASON_META[r.reason] ?? { tone: 'warn' as Tone, label: r.reason };
        return <StatusBadge tone={m.tone} label={m.label} />;
      },
    },
  ];

  const active = view === 'summary' ? summary : view === 'poorly' ? poorly : view === 'hourly' ? hourly : daily;
  const paginated = view === 'summary' || view === 'poorly';
  const meta = paginated ? (active.data as { meta?: { pagination?: { total: number; page: number; totalPages: number } } })?.meta?.pagination : undefined;
  const total = paginated
    ? meta?.total
    : ((active.data as { data?: unknown[] })?.data?.length ?? undefined);

  return (
    <AppShell>
      <PageHeader
        title="Analitika vremena"
        count={total != null ? `${formatNumber(total)} ${paginated ? 'redova' : view === 'hourly' ? 'sati' : 'dana'}` : undefined}
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {/* prekidač pregleda */}
        <div className="inline-flex flex-wrap gap-1 rounded-control border border-line bg-surface-2 p-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => {
                setView(v.key);
                resetPage();
              }}
              className={
                view === v.key
                  ? 'rounded-control bg-surface px-3 py-1.5 text-sm font-semibold text-ink shadow-sm'
                  : 'rounded-control px-3 py-1.5 text-sm text-ink-secondary hover:text-ink'
              }
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1 text-xs text-ink-secondary">
            Radni centar
            <div className="w-56">
              <ComboBox<Operation>
                value={rc}
                onChange={(o) => {
                  setRc(o);
                  resetPage();
                }}
                useSearch={(query) => useOperations({ q: query || undefined })}
                getKey={(o) => o.workCenterCode}
                getLabel={(o) => `${o.workCenterName} (${o.workCenterCode})`}
                placeholder="Svi radni centri…"
              />
            </div>
          </div>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Od
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                resetPage();
              }}
              className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Do
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                resetPage();
              }}
              className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            />
          </label>
          {(rc || from || to) && (
            <button
              onClick={() => {
                setRc(null);
                setFrom('');
                setTo('');
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>

        {active.error && (
          <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(active.error as Error).message}
          </div>
        )}

        {view === 'poorly' && (
          <p className="text-xs text-ink-disabled">
            Prikazuje samo mereno-evidentiran rad (START/STOP sesije) bez ispravnog para —
            legacy „otvoreni" postupci su normala i vide se u Evidenciji.
          </p>
        )}

        {view === 'daily' && (
          <DataTable columns={dailyCols} rows={daily.data?.data ?? []} rowKey={(r) => r.day} loading={daily.isLoading} empty={<EmptyState title="Nema aktivnosti u periodu" hint="Promeni period ili radni centar." />} />
        )}
        {view === 'summary' && (
          <DataTable columns={summaryCols} rows={summary.data?.data ?? []} rowKey={(r) => `${r.projectId}-${r.identNumber}-${r.variant}-${r.operationNumber}-${r.workCenterCode}`} loading={summary.isLoading} empty={<EmptyState title="Nema podataka" hint="Utrošeno vreme se puni START/STOP prijavama u pogonu." />} />
        )}
        {view === 'hourly' && (
          <DataTable columns={hourlyCols} rows={hourly.data?.data ?? []} rowKey={(r) => r.hourLocal} loading={hourly.isLoading} empty={<EmptyState title="Nema aktivnosti u periodu" hint="Promeni period ili radni centar." />} />
        )}
        {view === 'poorly' && (
          <DataTable columns={poorlyCols} rows={poorly.data?.data ?? []} rowKey={(r) => r.id} loading={poorly.isLoading} empty={<EmptyState title="Nema loše evidentiranih sesija" hint="Sve START/STOP sesije imaju ispravan par." />} />
        )}

        {paginated && meta && meta.totalPages > 1 && (
          <Pager
            page={meta.page}
            totalPages={meta.totalPages}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
          />
        )}
      </div>
    </AppShell>
  );
}

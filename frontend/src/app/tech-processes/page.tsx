'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  useCriticalTechProcesses,
  useRnProgress,
  useTechProcesses,
  useWorkerPerformance,
  type CriticalSeverity,
  type CriticalTechProcess,
  type RnProgress,
  type TechProcess,
  type WorkerPerformance,
} from '@/api/tech-processes';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { formatDate, formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
// „Kartica kucanja" + njeni deljeni helperi su ekstrahovani u zasebnu komponentu
// (`_components/tech-process-card-detail`) koju koristi i „Završeni nalozi". Ponašanje
// „Realizacije" je NEPROMENJENO — samo je premešteno (v. tech-process-card-detail.tsx).
import {
  TechProcessCardDetail,
  SectionHeading,
  centerLabel,
  workerLabel,
  formatMinutes,
} from './_components/tech-process-card-detail';

// ------------------------------------------------------------------ lokalni helperi

/** Mini progres bar (ProgressCell stil) — dinamička širina je jedini dozvoljeni inline style. */
function ProgressBar({ percent }: { percent: number | null }) {
  const pct = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  const bar =
    percent == null
      ? 'bg-status-neutral'
      : pct >= 100
        ? 'bg-status-success'
        : pct >= 50
          ? 'bg-status-info'
          : 'bg-status-warn';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-line-soft">
        <div className={cn('h-full rounded-full', bar)} style={{ width: `${pct}%` }} />
      </div>
      <span className="tnums text-xs text-ink-secondary">
        {percent == null ? '—' : `${pct}%`}
      </span>
    </div>
  );
}

const errorBox =
  'rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger';

// ------------------------------------------------------------------ tabovi (segmented control)

type TabKey = 'list' | 'critical' | 'worker' | 'rn';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'list', label: 'Kucanja' },
  { key: 'critical', label: 'Kritični' },
  { key: 'worker', label: 'Učinak radnika' },
  { key: 'rn', label: 'Gotovost RN' },
];

function Tabs({ value, onChange }: { value: TabKey; onChange: (k: TabKey) => void }) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const idx = TABS.findIndex((t) => t.key === value);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(TABS[(idx + 1) % TABS.length].key);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onChange(TABS[(idx - 1 + TABS.length) % TABS.length].key);
    }
  }
  return (
    <div
      role="tablist"
      aria-label="Prikaz realizacije"
      onKeyDown={onKeyDown}
      className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1"
    >
      {TABS.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={cn(
              'rounded-control px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-accent text-accent-fg'
                : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ================================================================== TAB: KUCANJA (lista + kartica)

const listColumns: Column<TechProcess>[] = [
  {
    key: 'identNumber',
    header: 'Ident',
    render: (r) => <span className="tnums font-semibold text-ink">{r.identNumber}</span>,
  },
  { key: 'identMark', header: 'Oznaka', render: (r) => r.identMark || '—' },
  {
    // Crtež sa RN-a (work_orders.drawing_number) — novo polje `drawingNumber`
    // (defanzivno: stariji backend ga ne vraća → „—").
    key: 'drawingNumber',
    header: 'Crtež',
    render: (r) => <span className="tnums text-ink-secondary">{r.drawingNumber || '—'}</span>,
  },
  {
    key: 'workCenter',
    header: 'RC',
    render: (r) => <span className="text-ink-secondary">{r.workCenterCode}</span>,
  },
  {
    key: 'pieceCount',
    header: 'Kom',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.pieceCount),
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) =>
      r.isProcessFinished ? (
        <StatusBadge tone="success" label="Završen" />
      ) : (
        <StatusBadge tone="info" label="U izradi" />
      ),
  },
  {
    // Miljanov feedback t.6a: `worker` = radnik koji je otkucao red (header je
    // ranije POGREŠNO glasio „Tehnolog") — tehnolog autor TP-a je zasebna kolona.
    key: 'worker',
    header: 'Radnik',
    render: (r) => <span className="text-ink-secondary">{r.worker?.fullName ?? '—'}</span>,
  },
  {
    // Tehnolog autor TP-a (sa RN-a) — novo polje `technologist` (defanzivno:
    // stariji backend ga ne vraća → „—").
    key: 'technologist',
    header: 'Tehnolog',
    render: (r) => (
      <span className="text-ink-secondary">{r.technologist?.fullName ?? '—'}</span>
    ),
  },
  {
    key: 'enteredAt',
    header: 'Unet',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.enteredAt)}</span>,
  },
];

function PostupciPanel() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const list = useTechProcesses({ page, q: q.trim() || undefined });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeading
          title="Kucanja"
          count={meta ? `${formatNumber(meta.total)} zapisa` : undefined}
        />
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="RN / crtež / naziv / nacrt / sklop…"
        />
      </div>

      {list.error && <div className={errorBox}>{(list.error as Error).message}</div>}

      <DataTable
        columns={listColumns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
        expandedKey={expanded}
        renderExpanded={(r) => (
          <TechProcessCardDetail
            projectId={r.projectId}
            identNumber={r.identNumber}
            variant={r.variant}
            techProcessId={r.id}
            workOrderId={r.workOrderId}
          />
        )}
        empty={
          <EmptyState
            title="Nema kucanja"
            hint="Promeni pretragu ili proveri da je sync popunio podatke."
          />
        }
      />

      {meta && meta.totalPages > 1 && (
        <Pager
          page={meta.page}
          totalPages={meta.totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
        />
      )}
    </div>
  );
}

// ================================================================== TAB: KRITIČNI

function severityMeta(sev: CriticalSeverity): { tone: Tone; label: string } {
  if (sev === 3) return { tone: 'danger', label: 'Rok probijen' };
  if (sev === 2) return { tone: 'warn', label: 'Hitno' };
  return { tone: 'warn', label: 'Uskoro' };
}

function criticalReason(days: number): string {
  if (days < 0) return `Rok probijen pre ${formatNumber(Math.abs(days))} d`;
  if (days === 0) return 'Rok ističe danas';
  return `Još ${formatNumber(days)} d do roka`;
}

const criticalColumns: Column<CriticalTechProcess>[] = [
  {
    key: 'identNumber',
    header: 'Ident',
    render: (r) => <span className="tnums font-semibold text-ink">{r.identNumber}</span>,
  },
  {
    key: 'operationNumber',
    header: 'Op.',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{r.operationNumber}</span>,
  },
  {
    key: 'workCenter',
    header: 'RC',
    render: (r) => <span className="text-ink">{centerLabel(r.operation, r.workCenterCode)}</span>,
  },
  {
    key: 'pieceCount',
    header: 'Kom',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.pieceCount),
  },
  {
    key: 'deadline',
    header: 'Rok',
    render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.productionDeadline)}</span>,
  },
  {
    key: 'severity',
    header: 'Nivo',
    render: (r) => {
      const m = severityMeta(r.severity);
      return <StatusBadge tone={m.tone} label={m.label} />;
    },
  },
  {
    key: 'reason',
    header: 'Razlog',
    render: (r) => <span className="text-ink-secondary">{criticalReason(r.daysRemaining)}</span>,
  },
  {
    key: 'worker',
    header: 'Radnik',
    render: (r) => <span className="text-ink-secondary">{workerLabel(r.worker, r.workerId)}</span>,
  },
];

function KriticniPanel() {
  const [page, setPage] = useState(1);
  const critical = useCriticalTechProcesses({ page });

  const rows = critical.data?.data ?? [];
  const meta = critical.data?.meta;
  const counts = meta?.severityCounts;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeading
          title="Kritični postupci"
          count={meta ? `${formatNumber(meta.pagination.total)} zapisa` : undefined}
        />
        {counts && (
          <div className="flex items-center gap-2">
            <StatusBadge tone="danger" label={`Rok probijen · ${formatNumber(counts.red)}`} />
            <StatusBadge tone="warn" label={`≤ 2 dana · ${formatNumber(counts.orange)}`} />
            <StatusBadge tone="warn" label={`≤ 7 dana · ${formatNumber(counts.yellow)}`} />
          </div>
        )}
      </div>

      {critical.error && <div className={errorBox}>{(critical.error as Error).message}</div>}

      <DataTable
        columns={criticalColumns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={critical.isLoading}
        empty={
          <EmptyState
            title="Nema kritičnih postupaka"
            hint="Nijedan nezavršen postupak nije u roku od 7 dana do isteka."
          />
        }
      />

      {meta && meta.pagination.totalPages > 1 && (
        <Pager
          page={meta.pagination.page}
          totalPages={meta.pagination.totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(meta.pagination.totalPages, p + 1))}
        />
      )}
    </div>
  );
}

// ================================================================== TAB: UČINAK RADNIKA

const workerColumns: Column<WorkerPerformance>[] = [
  {
    key: 'worker',
    header: 'Radnik',
    render: (r) => <span className="font-semibold text-ink">{workerLabel(r.worker, r.workerId)}</span>,
  },
  {
    key: 'processCount',
    header: 'Postupci',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.processCount),
  },
  {
    key: 'finishedCount',
    header: 'Završeno',
    align: 'right',
    numeric: true,
    render: (r) => <span className="text-ink-secondary">{formatNumber(r.finishedCount)}</span>,
  },
  {
    key: 'totalPieces',
    header: 'Komada',
    align: 'right',
    numeric: true,
    render: (r) => <span className="font-semibold text-ink">{formatNumber(r.totalPieces)}</span>,
  },
  {
    key: 'good',
    header: 'Dobar',
    align: 'right',
    numeric: true,
    render: (r) => <span className="text-status-success">{formatNumber(r.piecesByQuality.good)}</span>,
  },
  {
    key: 'rework',
    header: 'Dorada',
    align: 'right',
    numeric: true,
    render: (r) => <span className="text-status-warn">{formatNumber(r.piecesByQuality.rework)}</span>,
  },
  {
    key: 'scrap',
    header: 'Škart',
    align: 'right',
    numeric: true,
    render: (r) => <span className="text-status-danger">{formatNumber(r.piecesByQuality.scrap)}</span>,
  },
  {
    key: 'time',
    header: 'Vreme',
    align: 'right',
    render: (r) => <span className="tnums text-ink-secondary">{formatMinutes(r.totalElapsedMinutes)}</span>,
  },
];

function UcinakPanel() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const perf = useWorkerPerformance({ from: from || undefined, to: to || undefined });

  const rows = perf.data?.data ?? [];
  const meta = perf.data?.meta;

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Učinak po radniku"
        count={meta ? `${formatNumber(meta.workerCount)} radnika` : undefined}
      />

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Evidentirano od
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          do
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
          />
        </label>
        {(from || to) && (
          <button
            onClick={() => {
              setFrom('');
              setTo('');
            }}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}
      </div>

      {perf.error && <div className={errorBox}>{(perf.error as Error).message}</div>}

      <DataTable
        columns={workerColumns}
        rows={rows}
        rowKey={(r) => r.workerId}
        loading={perf.isLoading}
        empty={
          <EmptyState
            title="Nema učinka za period"
            hint="Promeni raspon datuma ili proveri da su postupci evidentirani."
          />
        }
      />
    </div>
  );
}

// ================================================================== TAB: GOTOVOST RN

const rnColumns: Column<RnProgress>[] = [
  {
    key: 'identNumber',
    header: 'RN / Ident',
    render: (r) => <span className="tnums font-semibold text-ink">{r.identNumber}</span>,
  },
  { key: 'partName', header: 'Naziv pozicije', render: (r) => r.partName || '—' },
  {
    key: 'drawingNumber',
    header: 'Crtež',
    render: (r) => <span className="tnums text-ink-secondary">{r.drawingNumber || '—'}</span>,
  },
  {
    key: 'planned',
    header: 'Planirano',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.plannedPieces),
  },
  {
    key: 'made',
    header: 'Napravljeno',
    align: 'right',
    numeric: true,
    render: (r) => <span className="font-semibold text-ink">{formatNumber(r.madeGoodPieces)}</span>,
  },
  {
    key: 'progress',
    header: 'Gotovost',
    render: (r) => <ProgressBar percent={r.completionPercent} />,
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) =>
      r.isCompleted ? (
        <StatusBadge tone="success" label="Gotovo" />
      ) : (
        <StatusBadge tone="info" label={r.handoverStatus?.name ?? 'U izradi'} />
      ),
  },
  {
    key: 'deadline',
    header: 'Rok',
    render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.productionDeadline)}</span>,
  },
];

function GotovostPanel() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const progress = useRnProgress({ page, q: q.trim() || undefined });

  const rows = progress.data?.data ?? [];
  const meta = progress.data?.meta.pagination;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeading
          title="Pregled gotovosti RN"
          count={meta ? `${formatNumber(meta.total)} naloga` : undefined}
        />
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="RN / crtež / naziv / nacrt / sklop…"
        />
      </div>

      {progress.error && <div className={errorBox}>{(progress.error as Error).message}</div>}

      <DataTable
        columns={rnColumns}
        rows={rows}
        rowKey={(r) => r.workOrderId}
        loading={progress.isLoading}
        empty={
          <EmptyState
            title="Nema radnih naloga"
            hint="Promeni pretragu ili proveri da je sync popunio naloge."
          />
        }
      />

      {meta && meta.totalPages > 1 && (
        <Pager
          page={meta.page}
          totalPages={meta.totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
        />
      )}
    </div>
  );
}

// ================================================================== STRANICA

export default function TechProcessesPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('list');

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

  return (
    <AppShell>
      <PageHeader title="Realizacija" />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs value={tab} onChange={setTab} />

        {tab === 'list' && <PostupciPanel />}
        {tab === 'critical' && <KriticniPanel />}
        {tab === 'worker' && <UcinakPanel />}
        {tab === 'rn' && <GotovostPanel />}
      </div>
    </AppShell>
  );
}

'use client';

import { Fragment, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  PART_QUALITY,
  useCriticalTechProcesses,
  useReopenTechProcess,
  useRnProgress,
  useTechProcessCard,
  useTechProcesses,
  useWorkerPerformance,
  type CardKey,
  type CardOperation,
  type CriticalSeverity,
  type CriticalTechProcess,
  type OperationRef,
  type RnProgress,
  type TechProcess,
  type TechProcessCardRow,
  type WorkerPerformance,
  type WorkerRef,
} from '@/api/tech-processes';
import { ApiError } from '@/api/client';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Dialog } from '@/components/ui-kit/dialog';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';

// ------------------------------------------------------------------ zajednički helperi

function workerLabel(w: WorkerRef | null, id: number): string {
  return w?.fullName || w?.username || `#${id}`;
}

function centerLabel(op: OperationRef | null, code: string): string {
  return op?.workCenterName || code || '—';
}

const QUALITY_LABEL: Record<number, string> = {
  [PART_QUALITY.GOOD]: 'Dobar',
  [PART_QUALITY.REWORK]: 'Dorada',
  [PART_QUALITY.SCRAP]: 'Škart',
};
function qualityLabel(id: number, name?: string | null): string {
  return name || QUALITY_LABEL[id] || `#${id}`;
}

/** Minuti → „12 h 30 min" / „45 min"; 0/prazno → „—". */
function formatMinutes(min: number | null): string {
  if (!min) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h === 0 ? `${m} min` : `${h} h ${m} min`;
}

function SectionHeading({ title, count }: { title: string; count?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <h2 className="text-md font-semibold text-ink">{title}</h2>
      {count != null && <span className="text-sm text-ink-secondary">{count}</span>}
    </div>
  );
}

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

const cardRowColumns: Column<TechProcessCardRow>[] = [
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
    key: 'quality',
    header: 'Kvalitet',
    render: (r) => qualityLabel(r.qualityTypeId, r.qualityType?.name),
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
    key: 'worker',
    header: 'Radnik',
    render: (r) => <span className="text-ink-secondary">{workerLabel(r.worker, r.workerId)}</span>,
  },
  {
    key: 'enteredAt',
    header: 'Unet',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.enteredAt)}</span>,
  },
  {
    key: 'finishedAt',
    header: 'Završen',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.finishedAt)}</span>,
  },
];

function SumTile({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  const color =
    tone === 'success'
      ? 'text-status-success'
      : tone === 'warn'
        ? 'text-status-warn'
        : tone === 'danger'
          ? 'text-status-danger'
          : 'text-ink';
  return (
    <div className="rounded-control border border-line bg-surface px-3 py-2">
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className={cn('tnums text-md font-semibold', color)}>{value}</dd>
    </div>
  );
}

/**
 * Ključ grupe kucanja — backend sortira redove kartice po
 * (operationNumber, workCenterCode, id), pa su grupe garantovano kontiguozne.
 */
function cardGroupKey(operationNumber: number, workCenterCode: string): string {
  return `${operationNumber}|${workCenterCode}`;
}

/** Cilj radnje „Otvori operaciju" (jedan red operacije + kontekst za potvrdu). */
interface ReopenTarget {
  id: number;
  operationNumber: number;
  workCenter: string;
}

/** Grupni header red kartice — agregat operacije IZ API-ja (operations[]), UI ništa ne sabira. */
function CardGroupHeaderRow({
  group,
  row,
  colCount,
  onReopen,
}: {
  group: CardOperation | undefined;
  row: TechProcessCardRow;
  colCount: number;
  /** Klik na „Otvori operaciju" (samo za završene operacije, iza tehnologija.write). */
  onReopen: (target: ReopenTarget) => void;
}) {
  const center = centerLabel(group?.operation ?? row.operation, row.workCenterCode);
  return (
    <tr className="border-b border-line bg-surface-2">
      <td colSpan={colCount} className="px-4 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="font-semibold text-ink">
            OP <span className="tnums">{row.operationNumber}</span> · {center}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            {group && (
              <span className="tnums text-xs text-ink-secondary">
                Σ {formatNumber(group.pieces.total)} kom (
                <span className="text-status-success">{formatNumber(group.pieces.good)} dobar</span>
                {' · '}
                <span className="text-status-warn">{formatNumber(group.pieces.rework)} dorada</span>
                {' · '}
                <span className="text-status-danger">{formatNumber(group.pieces.scrap)} škart</span>
                ) · {formatNumber(group.entryCount)} kucanja
              </span>
            )}
            {/* Ponovo otvori završenu operaciju za doradu — iza tehnologija.write. */}
            {group?.isFinished && (
              <Can permission={PERMISSIONS.TEHNOLOGIJA_WRITE}>
                <button
                  onClick={() =>
                    onReopen({ id: row.id, operationNumber: row.operationNumber, workCenter: center })
                  }
                  className="rounded-control border border-line px-2.5 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface"
                >
                  Otvori operaciju
                </button>
              </Can>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

/** „Kartica kucanja" — redovi + sume po kvalitetu + ukupno vreme (poziv /card). */
function TechProcessCardDetail({ tp }: { tp: TechProcess }) {
  const key: CardKey = {
    projectId: tp.projectId,
    identNumber: tp.identNumber,
    variant: tp.variant,
  };
  const q = useTechProcessCard(key);
  const reopen = useReopenTechProcess();
  const [reopenTarget, setReopenTarget] = useState<ReopenTarget | null>(null);

  function closeReopen() {
    reopen.reset();
    setReopenTarget(null);
  }

  async function confirmReopen() {
    if (!reopenTarget) return;
    try {
      await reopen.mutateAsync(reopenTarget.id);
      setReopenTarget(null);
    } catch {
      /* greška se prikazuje ispod */
    }
  }

  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju kartice.</span>;

  const card = q.data.data;
  const s = card.summary;
  const opByKey = new Map(
    card.operations.map((o) => [cardGroupKey(o.operationNumber, o.workCenterCode), o]),
  );
  const colCount = cardRowColumns.length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <SectionHeading
          title="Kartica kucanja"
          count={`${formatNumber(card.operationCount)} operacija · ${formatNumber(card.finishedCount)} završeno · ${formatNumber(s.entryCount)} kucanja`}
        />
        {/* HITNO sa primopredaje (Paket A t.10) — kanonska mapa DESIGN_SYSTEM §7. */}
        {card.isUrgent && <StatusBadge tone="danger" label="HITNO" />}
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <SumTile label="Ukupno kom" value={formatNumber(s.totalPieces)} />
        <SumTile label="Dobar" value={formatNumber(s.piecesByQuality.good)} tone="success" />
        <SumTile label="Dorada" value={formatNumber(s.piecesByQuality.rework)} tone="warn" />
        <SumTile label="Škart" value={formatNumber(s.piecesByQuality.scrap)} tone="danger" />
        <SumTile label="Ukupno vreme" value={formatMinutes(s.totalElapsedMinutes)} />
        <SumTile label="Varijanta" value={String(card.variant)} />
      </dl>

      {/* Kucanja grupisana po operaciji — DataTable nema grouping, pa raw tabela u DataTable
          stilu sa injektovanim grupnim header redovima (obrazac kao operacije RN u work-orders). */}
      <div className="overflow-x-auto rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left">
              {cardRowColumns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    'h-9 px-4 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary',
                    c.align === 'right' && 'text-right',
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {card.rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="p-0">
                  <EmptyState title="Kartica nema operacija" />
                </td>
              </tr>
            ) : (
              card.rows.map((r, i) => {
                const groupKey = cardGroupKey(r.operationNumber, r.workCenterCode);
                const prev = i > 0 ? card.rows[i - 1] : null;
                const isGroupStart =
                  !prev || cardGroupKey(prev.operationNumber, prev.workCenterCode) !== groupKey;
                return (
                  <Fragment key={r.id}>
                    {isGroupStart && (
                      <CardGroupHeaderRow
                        group={opByKey.get(groupKey)}
                        row={r}
                        colCount={colCount}
                        onReopen={setReopenTarget}
                      />
                    )}
                    <tr className="h-[var(--table-row-height)] border-b border-line-soft">
                      {cardRowColumns.map((c) => (
                        <td
                          key={c.key}
                          className={cn(
                            'px-4 text-ink',
                            c.align === 'right' && 'text-right',
                            c.numeric && 'tnums',
                          )}
                        >
                          {c.render(r)}
                        </td>
                      ))}
                    </tr>
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Dialog
        open={reopenTarget != null}
        onClose={closeReopen}
        title="Otvoriti operaciju?"
        footer={
          <>
            <button
              onClick={closeReopen}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Otkaži
            </button>
            <button
              disabled={reopen.isPending}
              onClick={confirmReopen}
              className="rounded-control bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg disabled:opacity-50"
            >
              {reopen.isPending ? 'Otvaranje…' : 'Otvori operaciju'}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-ink">
            {reopenTarget && (
              <>
                Operacija{' '}
                <span className="tnums font-semibold">OP {reopenTarget.operationNumber}</span> ·{' '}
                {reopenTarget.workCenter} će ponovo biti otvorena za doradu — prijava rada na
                kiosku će ponovo biti moguća.
              </>
            )}
          </p>
          {reopen.error && (
            <p className="text-sm text-status-danger" role="alert">
              {reopen.error instanceof ApiError
                ? reopen.error.message
                : (reopen.error as Error)?.message}
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}

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
          placeholder="Ident broj…"
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
        renderExpanded={(r) => <TechProcessCardDetail tp={r} />}
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
          placeholder="Ident, naziv, crtež…"
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

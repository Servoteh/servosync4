'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Select } from '@/components/ui-kit/select';
import { formatDate, formatNumber } from '@/lib/format';
import {
  useStockDocuments,
  ROBNO_STATUS,
  ROBNO_KIND,
  type RobnoStatus,
  type RobnoKind,
  type StockDocument,
} from '@/api/robno';

/**
 * Robno / magacin: radna lista robnih dokumenata (Faza 3). Obrazac „Lista"
 * (DESIGN_SYSTEM §4.1): filter bar (tip + status) + gusta tabela, server-side
 * paginacija (`page`/`pageSize`). Data isključivo kroz `@/api/robno` hook-ove;
 * sve od kit komponenti i tokena.
 *
 * STATUSI: kanonska mapa (DESIGN_SYSTEM §7) ROBNO domen — DRAFT=neutral,
 * CALCULATED=info, POSTED=success, LOCKED=neutral.
 */

const PAGE_SIZE = 50;

/** ROBNO status → { tone, label } (kanonska mapa §7). */
function statusMeta(status: RobnoStatus): { tone: Tone; label: string } {
  switch (status) {
    case ROBNO_STATUS.DRAFT:
      return { tone: 'neutral', label: 'U pripremi' };
    case ROBNO_STATUS.CALCULATED:
      return { tone: 'info', label: 'Kalkulisan' };
    case ROBNO_STATUS.POSTED:
      return { tone: 'success', label: 'Proknjižen' };
    case ROBNO_STATUS.LOCKED:
      return { tone: 'neutral', label: 'Zaključan' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/** ROBNO kind → srpska labela (diskriminator dokumenta). */
const KIND_LABEL: Record<RobnoKind, string> = {
  [ROBNO_KIND.UL]: 'Ulaz',
  [ROBNO_KIND.IZ]: 'Izlaz',
  [ROBNO_KIND.NIV]: 'Nivelacija',
  [ROBNO_KIND.PRENOS]: 'Prenos',
  [ROBNO_KIND.VISAK]: 'Višak',
  [ROBNO_KIND.MANJAK]: 'Manjak',
};

const KIND_OPTIONS: { value: RobnoKind; label: string }[] = [
  { value: ROBNO_KIND.UL, label: 'Ulaz' },
  { value: ROBNO_KIND.IZ, label: 'Izlaz' },
  { value: ROBNO_KIND.NIV, label: 'Nivelacija' },
  { value: ROBNO_KIND.PRENOS, label: 'Prenos' },
  { value: ROBNO_KIND.VISAK, label: 'Višak' },
  { value: ROBNO_KIND.MANJAK, label: 'Manjak' },
];

const STATUS_OPTIONS: { value: RobnoStatus; label: string }[] = [
  { value: ROBNO_STATUS.DRAFT, label: 'U pripremi' },
  { value: ROBNO_STATUS.CALCULATED, label: 'Kalkulisan' },
  { value: ROBNO_STATUS.POSTED, label: 'Proknjižen' },
  { value: ROBNO_STATUS.LOCKED, label: 'Zaključan' },
];

const columns: Column<StockDocument>[] = [
  {
    key: 'documentNumber',
    header: 'Broj',
    render: (d) => <span className="tnums font-semibold text-ink">{d.documentNumber}</span>,
  },
  {
    key: 'kind',
    header: 'Tip',
    render: (d) => <span className="text-ink">{KIND_LABEL[d.kind] ?? d.kind}</span>,
  },
  {
    key: 'warehouseId',
    header: 'Magacin',
    align: 'right',
    numeric: true,
    render: (d) => <span className="tnums text-ink-secondary">{d.warehouseId}</span>,
  },
  {
    key: 'documentDate',
    header: 'Datum',
    render: (d) => <span className="text-ink-secondary">{formatDate(d.documentDate)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (d) => {
      const s = statusMeta(d.status);
      return <StatusBadge tone={s.tone} label={s.label} />;
    },
  },
  {
    key: 'isCalculated',
    header: 'Kalkulisan',
    render: (d) =>
      d.isCalculated ? (
        <StatusBadge tone="success" label="Da" />
      ) : (
        <span className="text-ink-disabled">Ne</span>
      ),
  },
];

export default function RobnoPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [kind, setKind] = useState<RobnoKind | ''>('');
  const [status, setStatus] = useState<RobnoStatus | ''>('');
  const [page, setPage] = useState(1);
  const resetPage = () => setPage(1);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const list = useStockDocuments({ page, pageSize: PAGE_SIZE, kind, status });
  const rows = list.data?.data ?? [];
  const total = list.data?.meta.pagination.total ?? 0;
  const totalPages = list.data?.meta.pagination.totalPages ?? 1;

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const hasFilter = kind !== '' || status !== '';

  return (
    <AppShell>
      <PageHeader
        title="Robno / magacin"
        count={list.data ? `${formatNumber(total)} dokumenata` : undefined}
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Tip
            <div className="w-48">
              <Select
                placeholder="Svi"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as RobnoKind | '');
                  resetPage();
                }}
                options={KIND_OPTIONS}
              />
            </div>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <div className="w-48">
              <Select
                placeholder="Svi"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as RobnoStatus | '');
                  resetPage();
                }}
                options={STATUS_OPTIONS}
              />
            </div>
          </label>

          {hasFilter && (
            <button
              onClick={() => {
                setKind('');
                setStatus('');
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>

        {list.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(d) => d.id}
          onRowActivate={(d) => router.push(`/robno/${d.id}`)}
          loading={list.isLoading}
          empty={
            <EmptyState
              title="Nema robnih dokumenata"
              hint="Promeni filter ili kreiraj prvi robni dokument (ulaz, izlaz, nivelacija…)."
            />
          }
        />

        {totalPages > 1 && (
          <Pager
            page={page}
            totalPages={totalPages}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
          />
        )}
      </div>
    </AppShell>
  );
}

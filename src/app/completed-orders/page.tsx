'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useWorkOrders, type WorkOrder } from '@/api/work-orders';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate, formatNumber } from '@/lib/format';

/**
 * „Završeni radni nalozi" (QBigTehn pregled završenih) — RN-ovi kod kojih su sve
 * značajne operacije gotove (`work_orders.status = true`). Read-only.
 */
export default function CompletedOrdersPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const list = useWorkOrders({
    page,
    q: q.trim() || undefined,
    completed: 'true',
    from: from || undefined,
    to: to ? `${to}T23:59:59` : undefined,
  });

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  const resetPage = () => setPage(1);
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  const columns: Column<WorkOrder>[] = [
    {
      key: 'identNumber',
      header: 'RN / Ident',
      render: (r) => <span className="tnums font-semibold text-ink">{r.identNumber}</span>,
    },
    {
      key: 'partName',
      header: 'Pozicija',
      render: (r) => <span className="text-ink-secondary">{r.partName}</span>,
    },
    {
      key: 'drawingNumber',
      header: 'Crtež',
      render: (r) => <span className="tnums text-ink-secondary">{r.drawingNumber}</span>,
    },
    {
      key: 'pieceCount',
      header: 'Kom',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums">{formatNumber(r.pieceCount)}</span>,
    },
    {
      key: 'deadline',
      header: 'Rok isporuke',
      render: (r) =>
        r.productionDeadline ? (
          <span className="text-ink-secondary">{formatDate(r.productionDeadline)}</span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: () => <StatusBadge tone="success" label="Završen" />,
    },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Završeni radni nalozi"
        count={meta ? `${formatNumber(meta.total)} naloga` : undefined}
        actions={
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="RN / ident / pozicija…"
          />
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Otvoren od
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
            Otvoren do
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
          {(q || from || to) && (
            <button
              onClick={() => {
                setQ('');
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

        {list.error && (
          <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          empty={
            <EmptyState
              title="Nema završenih naloga"
              hint="RN se označava završenim kada su sve značajne operacije zatvorene."
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
    </AppShell>
  );
}

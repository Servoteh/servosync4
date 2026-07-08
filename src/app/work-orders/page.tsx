'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useWorkOrder, useWorkOrders, type WorkOrder } from '@/api/work-orders';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { formatDate, formatNumber } from '@/lib/format';

const columns: Column<WorkOrder>[] = [
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
      r.isLocked ? (
        <StatusBadge tone="warn" label="Zaključan" />
      ) : (
        <StatusBadge tone="info" label="Otvoren" />
      ),
  },
  {
    key: 'deadline',
    header: 'Rok',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.productionDeadline)}</span>,
  },
  {
    key: 'worker',
    header: 'Otvorio',
    render: (r) => <span className="text-ink-secondary">{r.worker?.fullName ?? '—'}</span>,
  },
];

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function WorkOrderDetail({ id }: { id: number }) {
  const q = useWorkOrder(id);
  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;
  const rn = q.data.data;
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field label="Materijal" value={rn.material || '—'} />
        <Field label="Dimenzija" value={rn.materialDimension || '—'} />
        <Field label="Revizija" value={rn.revision} />
        <Field label="Kvalitet" value={rn.qualityType?.name ?? '—'} />
        <Field label="Predmet (spolja)" value={rn.externalProjectName ?? String(rn.projectId)} />
        <Field label="Primopredaja" value={rn.handoverStatus?.name ?? '—'} />
        <Field label="Otvoren" value={formatDate(rn.enteredAt)} />
        <Field label="Rok" value={formatDate(rn.productionDeadline)} />
      </dl>

      <div>
        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Operacije ({rn.operations.length})
        </p>
        {rn.operations.length === 0 ? (
          <span className="text-sm text-ink-disabled">Nema operacija.</span>
        ) : (
          <div className="overflow-x-auto rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                  <th className="px-3 py-2 font-semibold">Op.</th>
                  <th className="px-3 py-2 font-semibold">RC</th>
                  <th className="px-3 py-2 font-semibold">Opis</th>
                  <th className="px-3 py-2 text-right font-semibold">Priprema</th>
                  <th className="px-3 py-2 text-right font-semibold">Ciklus</th>
                </tr>
              </thead>
              <tbody>
                {rn.operations.map((op) => (
                  <tr key={op.id} className="border-b border-line-soft last:border-0">
                    <td className="tnums px-3 py-1.5 text-ink-secondary">{op.operationNumber}</td>
                    <td className="px-3 py-1.5 text-ink">
                      {op.operation?.workCenterName ?? op.workCenterCode}
                    </td>
                    <td className="px-3 py-1.5 text-ink">{op.workDescription}</td>
                    <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                      {op.setupTime ?? '—'}
                    </td>
                    <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                      {op.cycleTime ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkOrdersPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const list = useWorkOrders({ page, q: q.trim() || undefined });

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

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  return (
    <AppShell>
      <PageHeader
        title="Radni nalozi"
        count={meta ? `${formatNumber(meta.total)} zapisa` : undefined}
        actions={
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="Ident, naziv, crtež…"
          />
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
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
          onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
          expandedKey={expanded}
          renderExpanded={(r) => <WorkOrderDetail id={r.id} />}
          empty={
            <EmptyState
              title="Nema radnih naloga"
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
    </AppShell>
  );
}

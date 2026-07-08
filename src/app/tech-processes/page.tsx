'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  useTechProcess,
  useTechProcesses,
  type TechProcess,
} from '@/api/tech-processes';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { formatDate, formatNumber } from '@/lib/format';

const columns: Column<TechProcess>[] = [
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
    key: 'worker',
    header: 'Tehnolog',
    render: (r) => <span className="text-ink-secondary">{r.worker?.fullName ?? '—'}</span>,
  },
  {
    key: 'enteredAt',
    header: 'Unet',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.enteredAt)}</span>,
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

function TechProcessDetail({ id }: { id: number }) {
  const q = useTechProcess(id);
  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;
  const tp = q.data.data;
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field label="Operacija" value={`${tp.operationNumber} · ${tp.workCenterCode}`} />
        <Field label="Varijanta" value={String(tp.variant)} />
        <Field label="Predmet" value={String(tp.projectId)} />
        <Field label="Završen" value={tp.finishedAt ? formatDate(tp.finishedAt) : '—'} />
      </dl>
      {tp.note && <p className="text-ink-secondary">{tp.note}</p>}
      <div>
        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Dokumentacija
        </p>
        {tp.documents.length === 0 ? (
          <span className="text-sm text-ink-disabled">Nema dokumenata.</span>
        ) : (
          <ul className="space-y-0.5">
            {tp.documents.map((d) => (
              <li key={d.id} className="text-ink-secondary">
                {d.fileName}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function TechProcessesPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const list = useTechProcesses({ page, q: q.trim() || undefined });

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
        title="Tehnološki postupci"
        count={meta ? `${formatNumber(meta.total)} zapisa` : undefined}
        actions={
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="Ident broj…"
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
          renderExpanded={(r) => <TechProcessDetail id={r.id} />}
          empty={
            <EmptyState
              title="Nema tehnoloških postupaka"
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

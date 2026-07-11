'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useRunSync, useSyncLogs, type SyncLog } from '@/api/sync';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDateTime, formatDuration, formatNumber } from '@/lib/format';

const columns: Column<SyncLog>[] = [
  { key: 'startedAt', header: 'Početak', render: (r) => formatDateTime(r.startedAt) },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  {
    key: 'scope',
    header: 'Opseg',
    render: (r) => <span className="text-ink-secondary">{r.entityScope ?? '—'}</span>,
  },
  {
    key: 'upserted',
    header: 'Upisano',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.rowsUpserted),
  },
  {
    key: 'duration',
    header: 'Trajanje',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="text-ink-secondary">{formatDuration(r.startedAt, r.finishedAt)}</span>
    ),
  },
  {
    key: 'trigger',
    header: 'Okidač',
    render: (r) => <span className="text-ink-secondary">{r.trigger}</span>,
  },
];

function EntityBreakdown({ log }: { log: SyncLog }) {
  if (!log.metadata) return <span className="text-sm text-ink-disabled">Nema detalja.</span>;
  const entries = Object.entries(log.metadata).sort(
    (a, b) => (b[1].rowsUpserted ?? 0) - (a[1].rowsUpserted ?? 0),
  );
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 md:grid-cols-4">
      {entries.map(([entity, m]) => (
        <div key={entity} className="flex justify-between gap-2 text-xs">
          <span className={m.error ? 'text-status-danger' : 'text-ink-secondary'}>{entity}</span>
          <span className="tnums text-ink">
            {m.error ? 'greška' : formatNumber(m.rowsUpserted ?? 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function SyncsPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const logs = useSyncLogs();
  const runSync = useRunSync();
  const [expanded, setExpanded] = useState<number | null>(null);

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

  const rows = logs.data ?? [];

  return (
    <AppShell>
      <PageHeader
        title="Sinhronizacije"
        count={rows.length ? `${formatNumber(rows.length)} zapisa` : undefined}
        actions={
          <Can permission={PERMISSIONS.SYNC_RUN}>
            <Button onClick={() => runSync.mutate()} loading={runSync.isPending}>
              {!runSync.isPending && <RefreshCw className="h-4 w-4" aria-hidden />}
              {runSync.isPending ? 'Sinhronizacija u toku…' : 'Pokreni sync'}
            </Button>
          </Can>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {runSync.isPending && (
          <div className="rounded-panel border border-status-info/30 bg-status-info-bg px-4 py-3 text-sm text-status-info">
            Sinhronizacija je pokrenuta — puni ~500.000 redova iz QBigTehn. Može potrajati
            nekoliko minuta.
          </div>
        )}
        {(runSync.error || logs.error) && (
          <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(runSync.error as Error)?.message ??
              (logs.error as Error)?.message ??
              'Došlo je do greške.'}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={logs.isLoading}
          onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
          expandedKey={expanded}
          renderExpanded={(r) => <EntityBreakdown log={r} />}
          empty={
            <EmptyState
              title="Još nema sinhronizacija"
              hint="Klikni „Pokreni sync“ da povučeš podatke iz QBigTehn."
            />
          }
        />
      </div>
    </AppShell>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import {
  useCncPrograms,
  useSetCncProgramDone,
  type CncProgram,
  type CncProgramCompletedBy,
} from '@/api/cnc-programs';
import { ApiError } from '@/api/client';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatNumber } from '@/lib/format';

function completedByName(by: CncProgramCompletedBy | null): string {
  return by?.fullName ?? by?.username ?? '—';
}

/**
 * Inline „CAM završen" čekboks (Paket B t.7, obrazac iz `PriorityCell` u
 * operations-queue): sa `tehnologija.write` čekboks snima optimistic (rollback
 * na grešku, poruka ispod); bez prava prikazuje samo status (StatusBadge).
 * Kad je završen prikazuje ko/kada.
 */
function CamCell({ row, canWrite }: { row: CncProgram; canWrite: boolean }) {
  const setDone = useSetCncProgramDone();
  const done = row.cam.isDone;

  const apiError =
    setDone.error instanceof ApiError
      ? setDone.error.message
      : (setDone.error as Error | null)?.message;

  const meta =
    done && row.cam.completedBy ? (
      <span className="tnums text-2xs text-ink-secondary">
        {completedByName(row.cam.completedBy)} · {formatDate(row.cam.completedAt)}
      </span>
    ) : null;

  if (!canWrite) {
    return (
      <span className="inline-flex flex-col gap-0.5">
        <StatusBadge tone={done ? 'success' : 'neutral'} label={done ? 'Završeno' : 'Nije završeno'} />
        {meta}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col gap-0.5">
      <label className="inline-flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={done}
          disabled={setDone.isPending}
          onChange={(e) => {
            setDone.reset();
            setDone.mutate({ workOrderId: row.id, isDone: e.target.checked });
          }}
          aria-label={`CAM završen za RN ${row.identNumber}`}
          className="h-4 w-4 rounded border-line"
        />
        Završeno
      </label>
      {meta}
      {apiError && (
        <span className="max-w-40 text-right text-2xs text-status-danger" role="alert">
          {apiError}
        </span>
      )}
    </span>
  );
}

/**
 * „CAM programiranje" (Paket B t.7) — lista radnih naloga sa CNC/CAM
 * operacijama; CNC programer čekira „CAM završen" (tehnologija.write), ostali
 * vide samo status. Lista obrazac (uzor: operations-queue).
 */
export default function CncProgramsPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);
  const [page, setPage] = useState(1);

  const list = useCncPrograms({
    page,
    q: q.trim() || undefined,
    onlyPending,
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

  // Čekiranje „CAM završen" samo uz tehnologija.write (CNC programer je ima).
  const canWrite = can(PERMISSIONS.TEHNOLOGIJA_WRITE);

  const columns: Column<CncProgram>[] = [
    {
      key: 'identNumber',
      header: 'RN / Ident',
      render: (r) => <span className="tnums font-semibold text-ink">{r.identNumber}</span>,
    },
    {
      key: 'partName',
      header: 'Pozicija',
      render: (r) => <span className="text-ink-secondary">{r.partName || '—'}</span>,
    },
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
      render: (r) => <span className="tnums">{formatNumber(r.pieceCount)}</span>,
    },
    {
      key: 'deadline',
      header: 'Rok',
      render: (r) =>
        r.productionDeadline ? (
          <span className="text-ink-secondary">{formatDate(r.productionDeadline)}</span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
    {
      key: 'cam',
      header: 'CAM',
      render: (r) => <CamCell row={r} canWrite={canWrite} />,
    },
  ];

  return (
    <AppShell>
      <PageHeader
        title="CAM programiranje"
        count={meta ? `${formatNumber(meta.total)} pozicija` : undefined}
        actions={
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="RN / ident / pozicija / crtež…"
          />
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={onlyPending}
              onChange={(e) => {
                setOnlyPending(e.target.checked);
                resetPage();
              }}
              className="h-4 w-4 rounded border-line"
            />
            Samo neurađene
          </label>
          {(q || onlyPending) && (
            <button
              onClick={() => {
                setQ('');
                setOnlyPending(false);
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
              title="Nema pozicija za CAM"
              hint="Ovde su radni nalozi sa CNC/CAM operacijama. Promeni filtere ili pretragu."
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

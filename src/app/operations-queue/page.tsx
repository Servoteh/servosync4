'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useOperationQueue, type OperationQueueEntry } from '@/api/operation-queue';
import { useSetOperationPriority } from '@/api/work-orders';
import { useOperations, type Operation } from '@/api/structures';
import { ApiError } from '@/api/client';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatNumber } from '@/lib/format';

/** Prioritet 255 = nije prioritizovano (dno liste). Manji broj = hitnije. */
const NO_PRIORITY = 255;

function isOverdue(deadline: string | null): boolean {
  if (!deadline) return false;
  return new Date(deadline).getTime() < Date.now();
}

/**
 * Inline izmena CAM prioriteta (D7, legacy `PregledOperacijaPoPrioritetima`
 * unos u gridu): klik na vrednost → number input (0–255); Enter/blur snima
 * (optimistic kroz `useSetOperationPriority`), Esc otkazuje. Bez
 * `tehnologija.write` prikazuje samo vrednost. Zaključan RN → 422 (poruka
 * ispod vrednosti, optimistic izmena se vraća).
 */
function PriorityCell({ row, canWrite }: { row: OperationQueueEntry; canWrite: boolean }) {
  const setPriority = useSetOperationPriority();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [rangeError, setRangeError] = useState(false);
  const cancelRef = useRef(false);

  const display =
    row.priority >= NO_PRIORITY ? (
      <span className="text-ink-disabled">—</span>
    ) : (
      <StatusBadge tone={row.priority < 100 ? 'danger' : 'warn'} label={String(row.priority)} />
    );

  if (!canWrite) return display;

  const apiError =
    setPriority.error instanceof ApiError
      ? setPriority.error.message
      : (setPriority.error as Error | null)?.message;

  function commit() {
    const n = Number(value.trim());
    if (value.trim() === '' || !Number.isInteger(n) || n < 0 || n > 255) {
      setRangeError(true);
      return false;
    }
    setEditing(false);
    if (n !== row.priority) setPriority.mutate({ operationId: row.id, priority: n });
    return true;
  }

  if (editing) {
    return (
      <span className="inline-flex flex-col items-end gap-0.5">
        <input
          autoFocus
          type="number"
          min={0}
          max={255}
          step={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setRangeError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              cancelRef.current = true;
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (cancelRef.current) cancelRef.current = false;
            else if (!commit()) setEditing(false);
          }}
          aria-label="Prioritet (0–255)"
          aria-invalid={rangeError}
          className="tnums w-16 rounded-control border border-line bg-surface px-1.5 py-0.5 text-right text-sm text-ink"
        />
        {rangeError && <span className="text-2xs text-status-danger">Ceo broj 0–255</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        onClick={() => {
          setPriority.reset();
          setRangeError(false);
          setValue(row.priority >= NO_PRIORITY ? '' : String(row.priority));
          setEditing(true);
        }}
        title="Izmeni prioritet (0–255)"
        aria-label={`Izmeni prioritet operacije ${row.operationNumber}`}
        className="rounded-control px-1 py-0.5 hover:bg-surface-2"
      >
        {display}
      </button>
      {apiError && (
        <span className="max-w-40 text-right text-2xs text-status-danger" role="alert">
          {apiError}
        </span>
      )}
    </span>
  );
}

export default function OperationsQueuePage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [rc, setRc] = useState<Operation | null>(null);
  const [onlyPrioritized, setOnlyPrioritized] = useState(false);
  const [page, setPage] = useState(1);

  const list = useOperationQueue({
    page,
    q: q.trim() || undefined,
    workCenterCode: rc?.workCenterCode,
    onlyPrioritized,
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

  // Inline izmena prioriteta samo uz tehnologija.write (CNC programer je ima).
  const canSetPriority = can(PERMISSIONS.TEHNOLOGIJA_WRITE);

  const columns: Column<OperationQueueEntry>[] = [
    {
      key: 'priority',
      header: 'Prioritet',
      align: 'right',
      numeric: true,
      render: (r) => <PriorityCell row={r} canWrite={canSetPriority} />,
    },
    {
      key: 'identNumber',
      header: 'RN / Ident',
      render: (r) => (
        <span className="tnums font-semibold text-ink">{r.workOrder?.identNumber ?? '—'}</span>
      ),
    },
    {
      key: 'partName',
      header: 'Pozicija',
      render: (r) => <span className="text-ink-secondary">{r.workOrder?.partName ?? '—'}</span>,
    },
    {
      key: 'operationNumber',
      header: 'Op.',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">{r.operationNumber}</span>,
    },
    {
      key: 'rc',
      header: 'Radni centar',
      render: (r) => r.operation?.workCenterName ?? r.workCenterCode,
    },
    {
      key: 'workDescription',
      header: 'Operacija',
      render: (r) => <span className="text-ink-secondary">{r.workDescription}</span>,
    },
    {
      key: 'pieceCount',
      header: 'Kom',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className="tnums">{r.workOrder ? formatNumber(r.workOrder.pieceCount) : '—'}</span>
      ),
    },
    {
      key: 'deadline',
      header: 'Rok isporuke',
      render: (r) => {
        const d = r.workOrder?.productionDeadline ?? null;
        if (!d) return <span className="text-ink-disabled">—</span>;
        return (
          <span className={isOverdue(d) ? 'font-semibold text-status-danger' : 'text-ink-secondary'}>
            {formatDate(d)}
          </span>
        );
      },
    },
  ];

  return (
    <AppShell>
      <PageHeader
        title="Operacije po prioritetu"
        count={meta ? `${formatNumber(meta.total)} operacija` : undefined}
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
          <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={onlyPrioritized}
              onChange={(e) => {
                setOnlyPrioritized(e.target.checked);
                resetPage();
              }}
              className="h-4 w-4 rounded border-line"
            />
            Samo prioritizovane
          </label>
          {(q || rc || onlyPrioritized) && (
            <button
              onClick={() => {
                setQ('');
                setRc(null);
                setOnlyPrioritized(false);
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
              title="Nema operacija u redu"
              hint="Sve operacije nezavršenih naloga se prikazuju sortirane po prioritetu. Promeni filtere."
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

'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  useCncPrograms,
  useMoveCncQueue,
  useSetCncProgramDone,
  type CncProgram,
  type CncProgramCompletedBy,
  type MoveCncQueueInput,
} from '@/api/cnc-programs';
import { useWorkOrder, type WorkOrderOperation } from '@/api/work-orders';
import { openDrawingPdf } from '@/api/pdm';
import { ApiError } from '@/api/client';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { OperationsTable } from '@/app/work-orders/_components/operations-table';
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
 * Kolona akcija redosleda (samo uz `tehnologija.cam_prioritet`): drag handle
 * (prevlačenje reda) + dugmad ↑/↓ za pomeranje jednog mesta. `afterWorkOrderId`
 * se računa iz TRENUTNO renderovane liste: ↑ = red dva iznad (null ako je meta
 * prvi), ↓ = sledeći red. Prvi/poslednji → dugme onemogućeno.
 */
function ReorderCell({
  rows,
  index,
  onMove,
  busy,
}: {
  rows: CncProgram[];
  index: number;
  onMove: (input: MoveCncQueueInput) => void;
  busy: boolean;
}) {
  const row = rows[index];
  const isFirst = index === 0;
  const isLast = index === rows.length - 1;

  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="cursor-grab text-ink-disabled active:cursor-grabbing"
        aria-hidden
        title="Prevuci za promenu redosleda"
      >
        <GripVertical className="h-4 w-4" />
      </span>
      <button
        type="button"
        disabled={busy || isFirst}
        onClick={(e) => {
          e.stopPropagation();
          // ↑ = ubaci iznad prethodnog vidljivog reda → afterWorkOrderId = red
          // dva iznad (null ako ga nema).
          const twoAbove = rows[index - 2];
          onMove({ workOrderId: row.id, afterWorkOrderId: twoAbove ? twoAbove.id : null });
        }}
        aria-label="Pomeri gore"
        title="Pomeri gore"
        className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2 disabled:opacity-40"
      >
        <ChevronUp className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        disabled={busy || isLast}
        onClick={(e) => {
          e.stopPropagation();
          // ↓ = ubaci ispod sledećeg reda → afterWorkOrderId = sledeći red.
          const nextRow = rows[index + 1];
          onMove({ workOrderId: row.id, afterWorkOrderId: nextRow ? nextRow.id : null });
        }}
        aria-label="Pomeri dole"
        title="Pomeri dole"
        className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2 disabled:opacity-40"
      >
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
    </span>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

/**
 * Detalj CAM pozicije (raširen red): učitava se tek na expand (komponenta se
 * montira na otvaranje). Zaglavlje polja + „PDF crteža" + read-only TP tabela.
 */
function CncProgramDetail({ workOrderId }: { workOrderId: number }) {
  const q = useWorkOrder(workOrderId);
  const [drawingPdfBusy, setDrawingPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  async function onOpenDrawingPdf(drawingId: number) {
    setDrawingPdfBusy(true);
    setPdfError(null);
    try {
      await openDrawingPdf(drawingId);
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : 'PDF crteža nema uskladišten sadržaj.');
    } finally {
      setDrawingPdfBusy(false);
    }
  }

  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;

  const rn = q.data.data;
  const hasDrawing = !!rn.drawingId && rn.drawingId > 0;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Pozicija" value={rn.partName || '—'} />
          <Field
            label="Crtež"
            value={
              <span className="tnums">
                {rn.drawingNumber || '—'}
                {rn.revision ? ` (rev. ${rn.revision})` : ''}
              </span>
            }
          />
          <Field label="Materijal" value={rn.material || '—'} />
          <Field label="Dimenzija" value={rn.materialDimension || '—'} />
          <Field label="Kom" value={<span className="tnums">{formatNumber(rn.pieceCount)}</span>} />
          <Field label="Rok" value={formatDate(rn.productionDeadline)} />
        </dl>
        {hasDrawing && (
          <button
            type="button"
            disabled={drawingPdfBusy}
            onClick={() => onOpenDrawingPdf(rn.drawingId as number)}
            className="shrink-0 rounded-control border border-line px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {drawingPdfBusy ? 'Otvaranje…' : 'PDF crteža'}
          </button>
        )}
      </div>

      {pdfError && (
        <p className="text-status-danger" role="alert">
          {pdfError}
        </p>
      )}

      <div>
        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Operacije ({rn.operations.length})
        </p>
        {rn.operations.length === 0 ? (
          <span className="text-sm text-ink-disabled">Nema operacija.</span>
        ) : (
          <OperationsTable
            operations={rn.operations as WorkOrderOperation[]}
            pieceCount={rn.pieceCount}
          />
        )}
      </div>
    </div>
  );
}

/**
 * „CAM programiranje" (Paket B t.7) — lista radnih naloga sa CNC/CAM
 * operacijama; CNC programer čekira „CAM završen" (tehnologija.write), ostali
 * vide samo status. Tehnolozi sa `tehnologija.cam_prioritet` ručno ređaju
 * redosled (prevlačenje + ↑/↓). Klik na red otvara detalj (PDF + TP). Lista
 * obrazac (uzor: operations-queue).
 */
export default function CncProgramsPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);

  const list = useCncPrograms({
    page,
    q: q.trim() || undefined,
    onlyPending,
  });
  const move = useMoveCncQueue();

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
  // Ručno ređanje redosleda samo uz per-user grant tehnologija.cam_prioritet.
  const canPrioritize = can(PERMISSIONS.CAM_PRIORITET);
  const moveBusy = move.isPending;

  const moveError =
    move.error instanceof ApiError ? move.error.message : (move.error as Error | null)?.message;

  // DnD: prevučeni red se ubacuje IZNAD reda na koji je spušten →
  // afterWorkOrderId = red neposredno IZNAD mete (null ako je meta prvi).
  function onRowDrop(dragKey: string, overKey: string) {
    if (dragKey === overKey) return; // drop na sebe = no-op
    const dragId = Number(dragKey);
    const overIndex = rows.findIndex((r) => String(r.id) === overKey);
    if (overIndex < 0) return;
    const above = rows[overIndex - 1];
    // Ako se prevlači red koji je već neposredno iznad mete → no-op.
    if (above && above.id === dragId) return;
    move.reset();
    move.mutate({ workOrderId: dragId, afterWorkOrderId: above ? above.id : null });
  }

  const columns: Column<CncProgram>[] = [
    {
      key: 'queueOrder',
      header: 'R.',
      align: 'right',
      numeric: true,
      render: (r) =>
        r.cam.queueOrder != null ? (
          <span className="tnums font-semibold text-ink">{r.cam.queueOrder}</span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
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

  if (canPrioritize) {
    columns.push({
      key: 'reorder',
      header: 'Redosled',
      align: 'right',
      render: (r) => {
        const index = rows.findIndex((x) => x.id === r.id);
        if (index < 0) return null;
        return <ReorderCell rows={rows} index={index} onMove={(i) => move.mutate(i)} busy={moveBusy} />;
      },
    });
  }

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

        {moveError && (
          <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger" role="alert">
            {moveError}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
          expandedKey={expanded}
          renderExpanded={(r) => <CncProgramDetail workOrderId={r.id} />}
          rowDraggable={canPrioritize && !moveBusy}
          onRowDrop={onRowDrop}
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

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  HANDOVER_STATUS,
  useHandovers,
  usePrepareHandoverWorkOrder,
  useTechnologistsLookup,
  type Handover,
} from '@/api/handovers';
import type { WorkerRef } from '@/api/tech-processes';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatNumber } from '@/lib/format';
import { LEGACY_TOOLTIP, LegacyBadge, UrgentBadge, errMsg, errorBox } from './common';
import { HandoverDetailPanel } from './handover-detail';
import { TakeOverButton } from './take-over-button';
import { LaunchHandoverDialog, ReturnToPendingDialog } from './workflow-dialogs';

const rowBtn =
  'rounded-control px-2.5 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Tab "Odobrene" — radna lista tehnologa (statusId=1 SAGLASAN): odavde se kuca
 * TP ("Otkucaj TP" → RN bez lansiranja → /work-orders?open=ID), lansira, ili
 * vraća na čekanje (undo odobravanja). Posle lansiranja red prirodno nestaje
 * (lista filtrira samo status SAGLASAN). "RN otkucan a nelansiran" se vidi po
 * popunjenoj koloni RN.
 */
export function ApprovedTab() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [rn, setRn] = useState('');
  const [technologist, setTechnologist] = useState<WorkerRef | null>(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [launchTarget, setLaunchTarget] = useState<Handover | null>(null);
  const [returnTarget, setReturnTarget] = useState<Handover | null>(null);
  const resetPage = () => setPage(1);

  const prepare = usePrepareHandoverWorkOrder();
  const list = useHandovers({
    page,
    statusId: HANDOVER_STATUS.APPROVED,
    drawingNumber: q.trim() || undefined,
    rn: rn.trim() || undefined,
    technologistId: technologist?.id ?? '',
  });

  function onPrepare(r: Handover) {
    prepare.mutate(r.id, {
      onSuccess: (res) => router.push(`/work-orders?open=${res.data.workOrderId}`),
    });
  }

  // Kolone zavise od router-a/mutacije, pa žive u komponenti (za razliku od
  // statičnih kolona ostalih tabova).
  const columns: Column<Handover>[] = [
    {
      key: 'drawing',
      header: 'Crtež',
      // Tab nema kolonu Status (sve je SAGLASAN) — Legacy/HITNO bedž ide uz broj crteža.
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="tnums font-semibold text-ink">
            {r.drawing ? `${r.drawing.drawingNumber} / ${r.drawing.revision}` : '—'}
          </span>
          {r.isUrgent && <UrgentBadge />}
          {r.isLegacy && <LegacyBadge />}
        </span>
      ),
    },
    { key: 'name', header: 'Naziv', render: (r) => r.drawing?.name || '—' },
    {
      // Predmet = broj predmeta po kome je crtež pušten (backend enrich).
      key: 'project',
      header: 'Predmet',
      render: (r) =>
        r.project ? (
          <span className="tnums text-ink">{r.project.projectNumber}</span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
    {
      key: 'quantity',
      header: 'Kom',
      align: 'right',
      numeric: true,
      render: (r) => (r.draftContext ? formatNumber(r.draftContext.quantityToProduce) : '—'),
    },
    {
      key: 'handoverDate',
      header: 'Datum',
      render: (r) => <span className="text-ink-secondary">{formatDate(r.handoverDate)}</span>,
    },
    {
      // Rok izrade unet pri odobravanju (P4 §6.5.1) — propagira se u RN.
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
      key: 'technologist',
      header: 'Tehnolog',
      render: (r) => <span className="text-ink-secondary">{r.technologist?.fullName ?? '—'}</span>,
    },
    {
      key: 'workOrder',
      header: 'RN',
      render: (r) =>
        r.workOrder ? (
          <span className="tnums font-semibold text-ink">{r.workOrder.identNumber}</span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
    {
      key: 'actions',
      header: 'Akcije',
      align: 'right',
      render: (r) => (
        // Permission gate po obrascu sa work-orders/page.tsx: Otkucaj TP kreira
        // RN = rn.write; Lansiraj/Vrati = primopredaje.approve (backend gate).
        <span className="inline-flex gap-1.5" onClick={(e) => e.stopPropagation()}>
          {r.workOrder ? (
            <button
              onClick={() => router.push(`/work-orders?open=${r.workOrder!.id}`)}
              className={`${rowBtn} bg-accent text-accent-fg`}
            >
              Otvori RN
            </button>
          ) : (
            <Can permission={PERMISSIONS.RN_WRITE}>
              <button
                disabled={prepare.isPending || r.isLegacy}
                title={r.isLegacy ? LEGACY_TOOLTIP : undefined}
                onClick={() => onPrepare(r)}
                className={`${rowBtn} bg-accent text-accent-fg`}
              >
                Otkucaj TP
              </button>
            </Can>
          )}
          {/* „Preuzmi izradu" (P4 §6.4) — komponenta se sama krije kad je red
              legacy/zaključan ili je zaduženje već moje (workerId iz JWT-a). */}
          <TakeOverButton
            handover={r}
            className={`${rowBtn} border border-line text-ink-secondary hover:bg-surface-2`}
          />
          {/* Legacy red: mutacije do cutover-a idu u QBigTehn (backend 409 je
              krajnja istina ako stariji tab ipak okine) — dugmad disabled. */}
          <Can permission={PERMISSIONS.PRIMOPREDAJE_APPROVE}>
            <button
              disabled={prepare.isPending || r.isLegacy}
              title={r.isLegacy ? LEGACY_TOOLTIP : undefined}
              onClick={() => setLaunchTarget(r)}
              className={`${rowBtn} border border-accent text-accent`}
            >
              Lansiraj
            </button>
            <button
              disabled={prepare.isPending || r.isLegacy}
              title={r.isLegacy ? LEGACY_TOOLTIP : undefined}
              onClick={() => setReturnTarget(r)}
              className={`${rowBtn} border border-line text-ink-secondary`}
            >
              Vrati
            </button>
          </Can>
        </span>
      ),
    },
  ];

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs text-ink-secondary">
          Pretraga
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="Broj crteža…"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs text-ink-secondary">
          RN
          <SearchBox
            value={rn}
            onChange={(v) => {
              setRn(v);
              resetPage();
            }}
            placeholder="Broj RN…"
          />
        </div>
        <div className="flex w-56 flex-col gap-1 text-xs text-ink-secondary">
          Za tehnologa
          <ComboBox<WorkerRef>
            value={technologist}
            onChange={(t) => {
              setTechnologist(t);
              resetPage();
            }}
            useSearch={useTechnologistsLookup}
            getKey={(t) => t.id}
            getLabel={(t) => t.fullName ?? t.username}
            getSublabel={(t) => t.username}
            placeholder="Svi tehnolozi…"
          />
        </div>
        {(q || rn || technologist) && (
          <button
            onClick={() => {
              setQ('');
              setRn('');
              setTechnologist(null);
              resetPage();
            }}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}
        {meta && (
          <span className="ml-auto text-sm text-ink-secondary">
            {formatNumber(meta.total)} odobrenih
          </span>
        )}
      </div>

      {list.error && <div className={errorBox}>{(list.error as Error).message}</div>}
      {prepare.error && <div className={errorBox}>{errMsg(prepare.error)}</div>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
        expandedKey={expanded}
        renderExpanded={(r) => <HandoverDetailPanel handover={r} />}
        empty={
          <EmptyState
            title="Nema odobrenih primopredaja"
            hint="Odobri primopredaju u tabu „Na čekanju” — ovde onda čeka kucanje TP-a i lansiranje."
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

      {launchTarget && (
        <LaunchHandoverDialog
          handover={launchTarget}
          open
          onClose={() => setLaunchTarget(null)}
        />
      )}
      {returnTarget && (
        <ReturnToPendingDialog
          handover={returnTarget}
          open
          onClose={() => setReturnTarget(null)}
        />
      )}
    </div>
  );
}

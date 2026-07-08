'use client';

import { useState } from 'react';
import { PART_QUALITY } from '@/api/tech-processes';
import { usePartLocations, type PartLocation } from '@/api/part-locations';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { formatDate, formatNumber } from '@/lib/format';
import { ComingSoonNote, errorBox, qualityLabel, workerLabel } from './common';
import { PartLocationCardDetail } from './part-location-card';

const columns: Column<PartLocation>[] = [
  {
    key: 'identNumber',
    header: 'RN / Ident',
    render: (r) => (
      <span className="tnums font-semibold text-ink">
        {r.workOrder?.identNumber ?? `#${r.workOrderId}`}
      </span>
    ),
  },
  {
    key: 'partName',
    header: 'Naziv pozicije',
    render: (r) => r.workOrder?.partName || '—',
  },
  {
    key: 'position',
    header: 'Pozicija/polica',
    render: (r) => (
      <span>
        <span className="tnums font-medium text-ink">
          {r.position?.positionCode ?? `#${r.positionId}`}
        </span>
        {r.position?.description && (
          <span className="ml-1.5 text-xs text-ink-disabled">{r.position.description}</span>
        )}
      </span>
    ),
  },
  {
    key: 'quality',
    header: 'Kvalitet',
    render: (r) => (
      <span className="text-ink-secondary">
        {qualityLabel(r.qualityTypeId, r.qualityType?.name)}
      </span>
    ),
  },
  {
    key: 'quantity',
    header: 'Kom',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.quantity),
  },
  {
    key: 'worker',
    header: 'Uneo',
    render: (r) => <span className="text-ink-secondary">{workerLabel(r.worker, r.workerId)}</span>,
  },
  {
    key: 'recordDate',
    header: 'Datum',
    render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.recordDate)}</span>,
  },
];

/**
 * "Delovi na lokacijama" — pregled ledger-a `part_locations` (READ-ONLY,
 * MODULE_SPEC_lokacije §1/§5). Expand reda = kartica dela za taj RN (ledger
 * istorija + stanje po poziciji).
 */
export function PartsTab() {
  const [q, setQ] = useState('');
  const [qualityTypeId, setQualityTypeId] = useState<number | ''>('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const list = usePartLocations({ page, q: q.trim() || undefined, qualityTypeId });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const resetPage = () => setPage(1);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="RN, predmet, pozicija…"
          />
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Kvalitet
            <select
              value={qualityTypeId}
              onChange={(e) => {
                setQualityTypeId(e.target.value === '' ? '' : Number(e.target.value));
                resetPage();
              }}
              className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            >
              <option value="">Svi</option>
              <option value={PART_QUALITY.GOOD}>Dobar</option>
              <option value={PART_QUALITY.REWORK}>Dorada</option>
              <option value={PART_QUALITY.SCRAP}>Škart</option>
            </select>
          </label>
          {(q || qualityTypeId !== '') && (
            <button
              onClick={() => {
                setQ('');
                setQualityTypeId('');
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>
        <span className="text-sm text-ink-secondary">
          {meta ? `${formatNumber(meta.total)} zapisa` : ''}
        </span>
      </div>

      <ComingSoonNote
        title="Premeštanje i trebovanje delova između lokacija"
        hint="Uskoro — ovaj pregled je za sada samo za čitanje, prenos i trebovanje dolaze u narednom talasu modula."
      />

      {list.error && <div className={errorBox}>{(list.error as Error).message}</div>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
        expandedKey={expanded}
        renderExpanded={(r) => <PartLocationCardDetail workOrderId={r.workOrderId} />}
        empty={
          <EmptyState
            title="Nema zapisa lokacija delova"
            hint="Promeni pretragu/filter ili proveri da je sync popunio podatke."
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

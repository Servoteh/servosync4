'use client';

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { formatDateTime } from '@/lib/format';
import {
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABEL,
  useAllLocations,
  useMovements,
  type LocMovement,
} from '@/api/lokacije';
import { buildLocIndex, downloadCsv, movementLabel, tableEmpty } from './common';

const INPUT = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent';

/** Istorija premeštanja (movements) — filteri korisnik/lokacija/tip/nalog/datum + CSV. */
export function MovementsTab() {
  const [search, setSearch] = useState('');
  const [movementType, setMovementType] = useState('');
  const [orderNo, setOrderNo] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 100;

  const locs = useAllLocations('all');
  const locIndex = useMemo(() => buildLocIndex(locs.data ?? []), [locs.data]);

  const q = useMovements({
    search: search || undefined,
    movementType: movementType || undefined,
    orderNo: orderNo || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    pageSize,
  });

  const rows = q.data?.data ?? [];
  const meta = q.data?.meta.pagination;

  const columns: Column<LocMovement>[] = [
    { key: 'movedAt', header: 'Vreme', render: (r) => <span className="tnums whitespace-nowrap">{formatDateTime(r.movedAt)}</span> },
    { key: 'type', header: 'Tip', render: (r) => movementLabel(r.movementType) },
    { key: 'order', header: 'Nalog', render: (r) => r.orderNo || '—' },
    { key: 'item', header: 'Stavka', render: (r) => <span className="tnums">{r.itemRefId}</span> },
    { key: 'drawing', header: 'Crtež', render: (r) => r.drawingNo || '—' },
    { key: 'from', header: 'Sa', render: (r) => locIndex.labelOf(r.fromLocationId) },
    { key: 'to', header: 'Na', render: (r) => locIndex.labelOf(r.toLocationId) },
    { key: 'qty', header: 'Kol.', align: 'right', numeric: true, render: (r) => String(r.quantity) },
    { key: 'note', header: 'Napomena', render: (r) => <span className="text-ink-secondary">{r.movementReason || r.note || '—'}</span> },
  ];

  function exportCsv() {
    downloadCsv(
      `pokreti_lokacija_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Vreme', 'Tip', 'Nalog', 'Stavka', 'Crtež', 'Sa', 'Na', 'Količina', 'Razlog/Napomena'],
      rows.map((r) => [
        formatDateTime(r.movedAt),
        movementLabel(r.movementType),
        r.orderNo,
        r.itemRefId,
        r.drawingNo,
        locIndex.labelOf(r.fromLocationId),
        locIndex.labelOf(r.toLocationId),
        String(r.quantity),
        r.movementReason || r.note || '',
      ]),
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className={INPUT} placeholder="Pretraga (stavka/nalog)…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <input className={INPUT} placeholder="Broj naloga" value={orderNo} onChange={(e) => { setOrderNo(e.target.value); setPage(1); }} />
        <select className={INPUT} value={movementType} onChange={(e) => { setMovementType(e.target.value); setPage(1); }}>
          <option value="">Svi tipovi</option>
          {MOVEMENT_TYPES.map((t) => (
            <option key={t} value={t}>{MOVEMENT_TYPE_LABEL[t]}</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-ink-secondary">
          Od <input className={INPUT} type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
        </label>
        <label className="flex items-center gap-1 text-xs text-ink-secondary">
          Do <input className={INPUT} type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
        </label>
        <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0} className="ml-auto">
          <Download className="h-4 w-4" /> CSV
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        empty={tableEmpty(q.isError, 'Nema pokreta', 'Za izabrane filtere nema zabeleženih premeštanja.')}
      />

      {meta && meta.totalPages > 1 && (
        <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
      )}
    </div>
  );
}

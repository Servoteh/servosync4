'use client';

import { useState } from 'react';
import { useMrpStock, type MrpStockRow } from '@/api/mrp';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { formatDateTime, formatNumber } from '@/lib/format';
import { ComingSoonNote, errorBox, qtyLabel } from './common';
import { cn } from '@/lib/cn';

const columns: Column<MrpStockRow>[] = [
  {
    key: 'catalogNumber',
    header: 'Kat. broj',
    render: (r) => (
      <span className="tnums font-semibold text-ink">
        {r.catalogNumber ?? r.item?.catalogNumber ?? `#${r.itemId}`}
      </span>
    ),
  },
  {
    key: 'name',
    header: 'Naziv',
    render: (r) => r.name ?? r.item?.name ?? '—',
  },
  {
    key: 'inStock',
    header: 'Zalihe',
    align: 'right',
    numeric: true,
    render: (r) => qtyLabel(r.inStock, r.unit),
  },
  {
    key: 'reserved',
    header: 'Rezervisano',
    align: 'right',
    numeric: true,
    render: (r) => <span className="text-ink-secondary">{qtyLabel(r.reserved, r.unit)}</span>,
  },
  {
    key: 'freeStock',
    header: 'Slobodno',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span
        className={cn(
          'font-semibold',
          r.freeStock <= 0 ? 'text-status-danger' : 'text-status-success',
        )}
      >
        {qtyLabel(r.freeStock, r.unit)}
      </span>
    ),
  },
  {
    key: 'updatedAt',
    header: 'Ažurirano',
    render: (r) => <span className="tnums text-ink-secondary">{formatDateTime(r.updatedAt)}</span>,
  },
];

export function StockTab() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const resetPage = () => setPage(1);

  const list = useMrpStock({ page, q: q.trim() || undefined });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  return (
    <div className="space-y-4">
      <ComingSoonNote
        title="Ažuriranje lagera i rezervacija iz planiranja dolazi u sledećoj fazi."
        hint="Ovo je trenutni snapshot zaliha (BigBit overlay) — samo za pregled."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs text-ink-secondary">
          Pretraga po artiklu
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="Katalog broj, naziv…"
          />
        </div>
        {q && (
          <button
            onClick={() => {
              setQ('');
              resetPage();
            }}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}
        {meta && (
          <span className="ml-auto text-sm text-ink-secondary">
            {formatNumber(meta.total)} artikala
          </span>
        )}
      </div>

      {list.error && <div className={errorBox}>{(list.error as Error).message}</div>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.itemId}
        loading={list.isLoading}
        empty={
          <EmptyState
            title="Nema podataka o zalihama"
            hint="Promeni pretragu ili proveri da je sync popunio snapshot zaliha."
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

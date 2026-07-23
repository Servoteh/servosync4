'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Input } from '@/components/ui-kit/form-field';
import { formatDecimal } from '@/lib/format';
import { useLager, type LagerRow } from '@/api/robno';

/**
 * Lager lista (BigBit paritet — stanje zaliha po magacinu + prosečne cene).
 * Snapshot iz StockLevel: onHand, prosečna nabavna, prosečna VP, vrednost zaliha.
 * Filter: pretraga po nazivu/šifri + samo-sa-stanjem. Kit komponente + tokeni.
 */
const columns: Column<LagerRow>[] = [
  {
    key: 'item',
    header: 'Artikal',
    render: (r) => (
      <div className="min-w-0">
        <div className="truncate text-ink">{r.itemName ?? `#${r.itemId}`}</div>
        <div className="tnums text-2xs text-ink-secondary">{r.itemCode ?? '—'}</div>
      </div>
    ),
  },
  {
    key: 'warehouse',
    header: 'Magacin',
    render: (r) => <span className="tnums text-ink-secondary">#{r.warehouseId}</span>,
  },
  {
    key: 'onHand',
    header: 'Stanje',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="tnums text-ink">
        {formatDecimal(r.onHand)} {r.unit ?? ''}
      </span>
    ),
  },
  {
    key: 'avgPurchaseNet',
    header: 'Pros. nabavna',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.avgPurchaseNet)}</span>,
  },
  {
    key: 'avgWholesalePrice',
    header: 'Pros. VP',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.avgWholesalePrice)}</span>,
  },
  {
    key: 'stockValue',
    header: 'Vrednost',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{formatDecimal(r.stockValue)}</span>,
  },
];

export function LagerPanel() {
  const [q, setQ] = useState('');
  const [onlyInStock, setOnlyInStock] = useState(true);
  const query = useLager({ q: q.trim() || undefined, onlyInStock });
  const rows = query.data?.data ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-md font-semibold text-ink">Lager lista</h2>
        <div className="flex items-center gap-3">
          <div className="w-56">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Pretraga po nazivu/šifri…"
            />
          </div>
          <label className="flex items-center gap-1 whitespace-nowrap text-xs text-ink-secondary">
            <input
              type="checkbox"
              checked={onlyInStock}
              onChange={(e) => setOnlyInStock(e.target.checked)}
            />
            samo sa stanjem
          </label>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${r.warehouseId}:${r.itemId}`}
        loading={query.isLoading}
        empty={
          <EmptyState
            title="Nema zaliha"
            hint="Lager se puni knjiženjem robnih dokumenata (ulaz/izlaz). Isključi filter samo-sa-stanjem da vidiš i nulte."
          />
        }
      />
    </section>
  );
}

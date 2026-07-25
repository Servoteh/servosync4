'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Input } from '@/components/ui-kit/form-field';
import { ExportCsvButton } from '@/components/export-csv-button';
import { type CsvColumn } from '@/lib/table-csv';
import { formatDecimal } from '@/lib/format';
import { useLager, type LagerRow } from '@/api/robno';

/** CSV kolone lagera (money/količine → zarez za Excel sr). */
const lagerCsvDec = (s: string | null | undefined) => (s == null ? '' : s.replace('.', ','));
const lagerCsvColumns: CsvColumn<LagerRow>[] = [
  { header: 'Artikal', value: (r) => r.itemName ?? '' },
  { header: 'Šifra', value: (r) => r.itemCode ?? '' },
  { header: 'Magacin', value: (r) => r.warehouseId },
  { header: 'Jedinica', value: (r) => r.unit ?? '' },
  { header: 'Stanje', value: (r) => lagerCsvDec(r.onHand) },
  { header: 'Rezervisano', value: (r) => lagerCsvDec(r.reserved) },
  { header: 'Raspoloživo', value: (r) => lagerCsvDec(r.available) },
  { header: 'Pros. nabavna', value: (r) => lagerCsvDec(r.avgPurchaseNet) },
  { header: 'Pros. VP', value: (r) => lagerCsvDec(r.avgWholesalePrice) },
  { header: 'Vrednost', value: (r) => lagerCsvDec(r.stockValue) },
];

/**
 * Lager lista (BigBit paritet — stanje zaliha po magacinu + prosečne cene).
 * Snapshot iz StockLevel: onHand, prosečna nabavna, prosečna VP, vrednost zaliha.
 * Filter: pretraga po nazivu/šifri + samo-sa-stanjem. Kit komponente + tokeni.
 *
 * REZERVACIJA (C3): „Rezervisano" je agregat otvorenih rezervacija (predračuni drže robu),
 * „Raspoloživo" = stanje − rezervisano. Raspoloživo ≤ 0 je crveno + ikonica upozorenja —
 * roba je već obećana i ne sme se obećati ponovo (detalji na /robno/rezervacije).
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
    key: 'reserved',
    header: 'Rezervisano',
    align: 'right',
    numeric: true,
    render: (r) =>
      Number(r.reserved) > 0 ? (
        <span className="tnums text-status-warn">
          {formatDecimal(r.reserved)} {r.unit ?? ''}
        </span>
      ) : (
        <span className="tnums text-ink-disabled">—</span>
      ),
  },
  {
    key: 'available',
    header: 'Raspoloživo',
    align: 'right',
    numeric: true,
    render: (r) => {
      const low = Number(r.available) <= 0;
      return (
        <span
          className={`tnums inline-flex items-center justify-end gap-1 ${
            low ? 'font-semibold text-status-danger' : 'text-ink'
          }`}
          title={
            low
              ? 'Nema raspoložive robe — sve je zauzeto otvorenim rezervacijama.'
              : undefined
          }
        >
          {low && <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          {formatDecimal(r.available)} {r.unit ?? ''}
        </span>
      );
    },
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
          <ExportCsvButton
            columns={lagerCsvColumns}
            rows={rows}
            filename={`lager-${new Date().toISOString().slice(0, 10)}`}
          />
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

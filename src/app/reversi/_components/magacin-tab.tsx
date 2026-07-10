'use client';

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { formatNumber } from '@/lib/format';
import { useWarehouse, type WarehouseRow } from '@/api/reversi';
import { ToolDetailDialog } from './tool-detail-dialog';

/** Objedinjeno stanje magacina (v_rev_warehouse_unified — paritet 1.0 magacinTab). */
export function MagacinTab() {
  const [q, setQ] = useState('');
  const [toolId, setToolId] = useState<string | null>(null);
  const warehouse = useWarehouse();

  const rows = useMemo(() => {
    const all = warehouse.data?.data ?? [];
    if (!q.trim()) return all;
    const t = q.trim().toLowerCase();
    return all.filter((r) =>
      [r.oznaka, r.naziv, r.barcode, r.serijski_broj, r.subgroup_label, r.group_label]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t)),
    );
  }, [warehouse.data, q]);

  const cols: Column<WarehouseRow>[] = [
    { key: 'grupa', header: 'Grupa', render: (r) => <span className="text-ink-secondary">{r.group_label ?? r.grupa}</span> },
    { key: 'oznaka', header: 'Oznaka', render: (r) => <span className="font-medium">{r.oznaka}</span> },
    { key: 'naziv', header: 'Naziv', render: (r) => r.naziv },
    { key: 'sn', header: 'Ser. broj', render: (r) => <span className="text-ink-secondary">{r.serijski_broj ?? '—'}</span> },
    {
      key: 'qty',
      header: 'Na stanju',
      align: 'right',
      numeric: true,
      render: (r) => {
        const qty = r.qty_on_hand ?? r.in_warehouse_qty;
        const low = r.min_stock_qty != null && qty != null && Number(qty) < Number(r.min_stock_qty);
        return (
          <span className={low ? 'font-semibold text-status-danger' : undefined}>
            {qty == null ? '—' : formatNumber(Number(qty))}
            {r.unit ? ` ${r.unit}` : ''}
          </span>
        );
      },
    },
    { key: 'loc', header: 'Lokacija', render: (r) => <span className="text-ink-secondary">{r.location_code ?? '—'}</span> },
  ];

  return (
    <div className="space-y-3">
      <SearchBox value={q} onChange={setQ} placeholder="Oznaka, naziv, barkod, grupa…" />
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => `${r.grupa}-${r.item_id}-${r.location_code ?? ''}`}
        loading={warehouse.isLoading}
        onRowActivate={(r) => {
          // Kartica se otvara samo za ručni alat/opremu (rev_tools); rezni alat ima
          // svoj tok (kartica reznog stiže sa reznim modulom).
          if (!/rezn/i.test(r.grupa)) setToolId(r.item_id);
        }}
        empty={<EmptyState title="Magacin je prazan" hint="Nema stavki koje odgovaraju pretrazi." />}
      />
      <ToolDetailDialog toolId={toolId} onClose={() => setToolId(null)} />
    </div>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { Download, ScanLine } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDateTime } from '@/lib/format';
import { fetchAllPlacements, useAllLocations, usePlacements, type LocPlacement } from '@/api/lokacije';
import { buildCsvFilename, buildLocIndex, downloadCsv, PlacementStatusBadge, tableEmpty } from './common';
import { ItemHistoryDialog } from './item-history-dialog';
import { MovementDialog, type MovementPreset } from './movement-dialog';
import { ScanOverlay } from './scan-overlay';

const INPUT = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent';

/** Stavke (placements) — pretraga smeštaja + istorija stavke + brzo premeštanje. */
export function StavkeTab({ initialSearch = '' }: { initialSearch?: string }) {
  const [search, setSearch] = useState(initialSearch);
  const [itemRefTable, setItemRefTable] = useState('bigtehn_rn');
  const [page, setPage] = useState(1);
  const pageSize = 100;
  const [history, setHistory] = useState<{ itemRefId: string; itemRefTable: string; orderNo?: string } | null>(null);
  const [move, setMove] = useState<MovementPreset | null>(null);
  const [scan, setScan] = useState(false);
  const [exporting, setExporting] = useState<{ loaded: number; total: number | null } | null>(null);

  const locs = useAllLocations('all');
  const locIndex = useMemo(() => buildLocIndex(locs.data ?? []), [locs.data]);

  const q = usePlacements({ search: search || undefined, itemRefTable, page, pageSize });
  const rows = q.data?.data ?? [];
  const meta = q.data?.meta.pagination;

  // CSV = CEO filtrirani skup (fetch-all), 13 kolona kao 1.0 (index.js:1176
  // attachItemsExport). Hala_kod/Hala_naziv = direktan roditelj lokacije.
  async function exportCsv() {
    if (exporting) return;
    setExporting({ loaded: 0, total: null });
    try {
      const { rows: all, total, truncated } = await fetchAllPlacements(
        { search: search || undefined, itemRefTable },
        { onProgress: (p) => setExporting(p) },
      );
      if (all.length === 0) {
        window.alert('Nema stavki koje odgovaraju trenutnoj pretrazi.');
        return;
      }
      downloadCsv(
        buildCsvFilename('lokacije_stavke', search),
        ['Nalog', 'Tehnološki postupak (TP)', 'Crtež', 'Polica_kod', 'Hala_kod', 'Hala_naziv', 'Tip_reda', 'Putanja lokacije', 'Količina', 'Status', 'Napomena', 'Premeštena u', 'Poslednja izmena'],
        all.map((p) => {
          const loc = locIndex.byId.get(p.locationId);
          const parent = loc?.parentId ? locIndex.byId.get(loc.parentId) : undefined;
          const tp = p.itemRefTable.toLowerCase() === 'bigtehn_rn' ? p.itemRefId : '';
          return [
            p.orderNo,
            tp,
            p.drawingNo,
            loc?.locationCode ?? '',
            parent?.locationCode ?? '',
            parent?.name ?? '',
            p.itemRefTable,
            loc?.pathCached ?? '',
            p.quantity == null ? '' : String(p.quantity),
            p.placementStatus,
            p.notes ?? '',
            p.placedAt ?? '',
            p.updatedAt ?? '',
          ];
        }),
      );
      if (truncated) {
        window.alert(
          `Export prekinut na 50 000 zapisa radi sigurnosti. Ukupno u bazi: ${total ?? '?'}. Suzi pretragu za kompletniji izvoz.`,
        );
      }
    } catch (err) {
      window.alert(`Export neuspešan: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      setExporting(null);
    }
  }

  const columns: Column<LocPlacement>[] = [
    { key: 'order', header: 'Nalog', render: (r) => r.orderNo || '—' },
    { key: 'item', header: 'Stavka', render: (r) => <span className="tnums font-medium">{r.itemRefId}</span> },
    { key: 'drawing', header: 'Crtež', render: (r) => r.drawingNo || '—' },
    { key: 'loc', header: 'Lokacija', render: (r) => locIndex.labelOf(r.locationId) },
    { key: 'qty', header: 'Kol.', align: 'right', numeric: true, render: (r) => String(r.quantity) },
    { key: 'status', header: 'Status', render: (r) => <PlacementStatusBadge status={r.placementStatus} /> },
    { key: 'updated', header: 'Ažurirano', render: (r) => <span className="tnums whitespace-nowrap text-ink-secondary">{formatDateTime(r.updatedAt)}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <div className="flex justify-end gap-1.5">
          <Can permission={PERMISSIONS.LOKACIJE_MOVE}>
            <button
              className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
              onClick={(e) => { e.stopPropagation(); setMove({ itemRefTable: r.itemRefTable, itemRefId: r.itemRefId, orderNo: r.orderNo, drawingNo: r.drawingNo, fromLocationId: r.locationId, movementType: 'TRANSFER' }); }}
            >
              Premesti
            </button>
          </Can>
          <button
            className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
            onClick={(e) => { e.stopPropagation(); setHistory({ itemRefId: r.itemRefId, itemRefTable: r.itemRefTable, orderNo: r.orderNo }); }}
          >
            Istorija
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${INPUT} min-w-64`} placeholder="Pretraga (stavka / nalog / crtež)…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <select className={INPUT} value={itemRefTable} onChange={(e) => { setItemRefTable(e.target.value); setPage(1); }} title="Vrsta stavke">
          <option value="bigtehn_rn">Predmeti (BigTehn)</option>
          <option value="rev_tools">Rezni alat (Reversi)</option>
        </select>
        <Button variant="secondary" onClick={() => setScan(true)}>
          <ScanLine className="h-4 w-4" /> Skeniraj stavku
        </Button>
        <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0 || exporting != null} className="ml-auto">
          <Download className="h-4 w-4" />
          {exporting
            ? `Izvezi CSV… ${exporting.loaded}${exporting.total != null ? `/${exporting.total}` : ''}`
            : 'Izvezi CSV'}
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        onRowActivate={(r) => setHistory({ itemRefId: r.itemRefId, itemRefTable: r.itemRefTable, orderNo: r.orderNo })}
        empty={tableEmpty(q.isError, 'Nema smeštenih stavki', 'Pretraži po broju stavke, nalogu ili crtežu.')}
      />

      {meta && meta.totalPages > 1 && (
        <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
      )}

      {history && <ItemHistoryDialog {...history} onClose={() => setHistory(null)} />}
      {move && <MovementDialog preset={move} onClose={() => setMove(null)} />}
      {scan && (
        <ScanOverlay
          title="Skeniraj stavku"
          accept={['ITEM']}
          onResult={(r) => { if (r.kind === 'ITEM') setSearch(r.parsed.itemRefId); }}
          onClose={() => setScan(false)}
        />
      )}
    </div>
  );
}

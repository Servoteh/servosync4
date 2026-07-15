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
  fetchAllMovements,
  useAllLocations,
  useMovementMovers,
  useMovements,
  type LocMovement,
  type MovementsParams,
} from '@/api/lokacije';
import { buildCsvFilename, buildLocIndex, csvTimestamp, downloadCsv, movementLabel, PageSizeSelect, tableEmpty, userDisplay } from './common';
import { LocationSelect } from './location-select';

const INPUT = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent';

/** Istorija premeštanja (movements) — filteri korisnik/lokacija/tip/nalog/datum + CSV. */
export function MovementsTab() {
  const [search, setSearch] = useState('');
  const [movementType, setMovementType] = useState('');
  const [orderNo, setOrderNo] = useState('');
  const [locationId, setLocationId] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [exporting, setExporting] = useState<{ loaded: number; total: number | null } | null>(null);

  const locs = useAllLocations('all');
  const locList = useMemo(() => locs.data ?? [], [locs.data]);
  const locIndex = useMemo(() => buildLocIndex(locList), [locList]);

  const baseFilters: MovementsParams = {
    search: search || undefined,
    movementType: movementType || undefined,
    orderNo: orderNo || undefined,
    locationId: locationId || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };

  const q = useMovements({ ...baseFilters, userId: userId || undefined, page, pageSize });

  // Opcije za „Korisnik" filter (paritet 1.0 `loadHistoryUsers` = PUNA lista movera):
  // primarno iz nove rute `/movements/movers` (DISTINCT moved_by + ime, bez page-clamp-a
  // — svaki mover uvek dostupan). Dok BE grana nije spojena (404) padamo na distinct iz
  // učitane strane (staro ponašanje; extra 500-red upit se pali SAMO tada). Vrednost
  // opcije = moved_by UUID (BE `userId` filter); labela = ime (fallback UUID).
  const movers = useMovementMovers();
  const userSource = useMovements({ ...baseFilters, pageSize: 500 }, movers.isError);
  const userOptions = useMemo(() => {
    const full = movers.data?.data;
    if (full && full.length) {
      return full
        .map((m) => ({ uid: m.id, label: userDisplay(m.name, m.id) }))
        .filter((o) => o.uid)
        .sort((a, b) => a.label.localeCompare(b.label, 'sr'));
    }
    const map = new Map<string, string>();
    for (const m of userSource.data?.data ?? []) {
      if (m.movedBy && !map.has(m.movedBy)) map.set(m.movedBy, userDisplay(m.movedByName, m.movedBy));
    }
    return [...map.entries()]
      .map(([uid, label]) => ({ uid, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'sr'));
  }, [movers.data, userSource.data]);

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
    { key: 'user', header: 'Korisnik', render: (r) => <span className="text-ink-secondary" title={r.movedBy}>{userDisplay(r.movedByName, r.movedBy)}</span> },
    { key: 'note', header: 'Napomena', render: (r) => <span className="text-ink-secondary">{r.movementReason || r.note || '—'}</span> },
  ];

  // CSV = CEO filtrirani skup (fetch-all), 12 kolona kao 1.0 (index.js:2785):
  // Sa/Na razbijeni na šifru + putanju (locIndex code+path_cached) + Tabela.
  const fmtLoc = (id: string | null | undefined): { code: string; path: string } => {
    const l = id ? locIndex.byId.get(id) : undefined;
    return { code: l?.locationCode ?? '', path: l?.pathCached ?? '' };
  };

  async function exportCsv() {
    if (exporting) return;
    setExporting({ loaded: 0, total: null });
    try {
      const { rows: all, total, truncated } = await fetchAllMovements(
        { ...baseFilters, userId: userId || undefined },
        { onProgress: (p) => setExporting(p) },
      );
      if (all.length === 0) {
        window.alert('Nema zapisa koji odgovaraju trenutnim filterima.');
        return;
      }
      downloadCsv(
        buildCsvFilename('lokacije_istorija'),
        ['Vreme', 'Korisnik', 'Tip', 'Količina', 'Sa lokacije', 'Sa putanje', 'Na lokaciju', 'Na putanju', 'Tabela', 'Crtež', 'Nalog', 'Napomena'],
        all.map((r) => {
          const from = fmtLoc(r.fromLocationId);
          const to = fmtLoc(r.toLocationId);
          return [
            csvTimestamp(r.movedAt),
            userDisplay(r.movedByName, r.movedBy),
            movementLabel(r.movementType),
            r.quantity == null ? '' : String(r.quantity),
            from.code,
            from.path,
            to.code,
            to.path,
            r.itemRefTable,
            r.drawingNo,
            r.orderNo,
            r.movementReason || r.note || '',
          ];
        }),
      );
      if (truncated) {
        window.alert(
          `Export prekinut na 50 000 zapisa radi sigurnosti. Ukupno u bazi: ${total ?? '?'}. Suzi filtere za kompletniji izvoz.`,
        );
      }
    } catch (err) {
      window.alert(`Export neuspešan: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      setExporting(null);
    }
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
        <select className={INPUT} value={userId} onChange={(e) => { setUserId(e.target.value); setPage(1); }} title="Korisnik">
          <option value="">Svi korisnici</option>
          {userOptions.map((u) => (
            <option key={u.uid} value={u.uid}>{u.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-ink-secondary">
          Od <input className={INPUT} type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} />
        </label>
        <label className="flex items-center gap-1 text-xs text-ink-secondary">
          Do <input className={INPUT} type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} />
        </label>
        <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0 || exporting != null} className="ml-auto">
          <Download className="h-4 w-4" />
          {exporting
            ? `CSV… ${exporting.loaded}${exporting.total != null ? `/${exporting.total}` : ''}`
            : 'CSV'}
        </Button>
      </div>

      <div className="max-w-md">
        <LocationSelect
          locations={locList}
          value={locationId}
          onChange={(v) => { setLocationId(v); setPage(1); }}
          placeholder="Filter po lokaciji (polazna ILI odredišna)…"
        />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        empty={tableEmpty(q.isError, 'Nema pokreta', 'Za izabrane filtere nema zabeleženih premeštanja.')}
      />

      <div className="flex items-center justify-between gap-3">
        <PageSizeSelect value={pageSize} onChange={(n) => { setPageSize(n); setPage(1); }} />
        {meta && meta.totalPages > 1 && (
          <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
        )}
      </div>
    </div>
  );
}

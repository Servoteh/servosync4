'use client';

import { useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { buildTspLabelProgram } from '@/lib/tspl2';
import { labelDate } from '@/lib/label-print';
import { TpProcedureModal } from '@/app/plan-proizvodnje/_components/tp-procedure-modal';
import {
  HALL_TYPES,
  fetchAllReportByLocation,
  useAllLocations,
  usePrintLocLabel,
  useReportByLocation,
  useReportSuggest,
  type LocLocation,
  type ReportParams,
  type ReportRow,
} from '@/api/lokacije';
import { buildCsvFilename, buildLocIndex, csvTimestamp, downloadCsv, PageSizeSelect, PlacementStatusBadge, tableEmpty, type LocIndex } from './common';
import { LocationSelect } from './location-select';
import { ItemHistoryDialog } from './item-history-dialog';
import { barcodeForRow } from './label-build';

const INPUT = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent';

const num = (v: unknown): string => (v == null || v === '' ? '—' : String(v));

// ------------------------------------------------------------------ CSV izvoz (paritet 1.0)
// Zaglavlja + red = 1.0 `REPORT_CSV_HEADERS` / `buildReportCsvRow`
// (src/lib/lokacijeReportLocations.js). RPC `loc_report_parts_by_locations`
// vraća lokaciona polja (hall_*, location_kind, location_path…) direktno u redu,
// ALI za mašinu ugnježdenu 2+ nivoa ispod hale vraća hall_code=NULL — pa se za
// takve redove hala razrešava 1.0 loc-index fallback-om (`resolveReportHall` preko
// `useAllLocations` indeksa, `location_id` → najbliži predak tipa HALA).

const REPORT_CSV_HEADERS = [
  'Predmet kod', 'Predmet naziv', 'Kupac', 'RN', 'Crtež', 'Naziv dela',
  'Materijal', 'Dimenzija materijala', 'Komada (RN)', 'Težina obr (kg)',
  'Revizija', 'Status RN', 'Rok izrade', 'TP ref', 'Tabela',
  'Hala šifra', 'Hala naziv', 'Tip lokacije', 'Polica/Kavez šifra',
  'Polica/Kavez naziv', 'Putanja', 'Opis police', 'Kol lok', 'Ukupno bucket',
  'Status placement', 'Poslednje',
];

function reportLocationKindLabel(kind: string): string {
  if (kind === 'shelf') return 'POLICA';
  if (kind === 'cage') return 'KAVEZ';
  if (kind === 'hall') return 'HALA';
  if (kind === 'machine') return 'MAŠINA';
  return '';
}

/**
 * Hala reda (šifra + naziv). Primarno iz RPC polja `hall_code`/`hall_name`; kad su
 * prazna (mašina 2+ nivoa ispod hale → RPC vraća NULL), fallback preko loc-indeksa:
 * `location_id` → najbliži predak tipa HALA (paritet 1.0 resolveHallForLocation).
 */
function resolveReportHall(r: ReportRow, locIndex: LocIndex | null): { code: string; name: string } {
  let code = String(r.hall_code ?? '').trim();
  let name = String(r.hall_name ?? '').trim();
  if (!code && locIndex) {
    const locId = typeof r.location_id === 'string' ? r.location_id : '';
    const hall = locId ? locIndex.hallOf(locId) : null;
    if (hall) {
      code = hall.locationCode;
      name = hall.name;
    }
  }
  return { code, name };
}

function buildReportCsvRow(r: ReportRow, locIndex: LocIndex | null): (string | number)[] {
  const { code: hallCode, name: hallName } = resolveReportHall(r, locIndex);
  // SIROVI kind iz reda (hall/machine/shelf/cage) → labela. Ranije se hranila
  // shelf/cage-normalizovana vrednost pa su HALA/MAŠINA redovi dobijali praznu ćeliju.
  const rawKind = String(r.location_kind ?? '').trim().toLowerCase();
  const shelfCode = String(r.location_code ?? '').trim();
  const shelfName = String(r.location_name ?? '').trim();
  return [
    r.project_code ?? '',
    r.project_name ?? '',
    r.customer_name ?? '',
    r.order_no ?? '',
    r.drawing_no || r.wo_broj_crteza || '',
    r.naziv_dela ?? '',
    r.materijal ?? '',
    r.dimenzija_materijala ?? '',
    r.komada_rn ?? '',
    r.tezina_obr ?? '',
    r.revizija ?? '',
    r.status_rn === true ? 'Zatvoren' : r.status_rn === false ? 'Otvoren' : '',
    r.rok_izrade ? String(r.rok_izrade).slice(0, 10) : '',
    r.item_ref_id ?? '',
    r.item_ref_table ?? '',
    hallCode,
    hallName,
    reportLocationKindLabel(rawKind),
    shelfCode,
    shelfName,
    r.location_path ?? '',
    r.shelf_note ?? '',
    r.qty_on_location ?? '',
    r.qty_total_for_bucket ?? '',
    r.placement_status ?? '',
    csvTimestamp(r.last_moved_at || r.updated_at),
  ];
}

/** Pregled delova po lokacijama — loc_report_parts_by_locations (filteri + CSV). */
export function ReportTab() {
  const [orderNo, setOrderNo] = useState('');
  const [drawingNo, setDrawingNo] = useState('');
  const [tpNo, setTpNo] = useState('');
  const [nazivDela, setNazivDela] = useState('');
  const [nazivFocus, setNazivFocus] = useState(false);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [hallId, setHallId] = useState('');
  const [locationKind, setLocationKind] = useState<'' | 'shelf' | 'cage'>('');
  const [projectSearch, setProjectSearch] = useState('');
  const [sort, setSort] = useState('');
  const [desc, setDesc] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [exporting, setExporting] = useState<{ loaded: number; total: number | null } | null>(null);
  // Akcije reda (paritet 1.0 index.js:969-1028): klik→istorija, RN/TP modal, TP nalepnica.
  const [history, setHistory] = useState<{ itemRefTable: string; itemRefId: string; orderNo: string } | null>(null);
  const [tpModalWo, setTpModalWo] = useState<string | null>(null);
  const print = usePrintLocLabel();

  /** TP nalepnica reda izveštaja (paritet 1.0 data-rep-print-tp → barcodeForPlacementRow). */
  async function printRowTp(r: ReportRow) {
    const bc = barcodeForRow({
      itemRefTable: String(r.item_ref_table ?? ''),
      orderNo: String(r.order_no ?? ''),
      itemRefId: String(r.item_ref_id ?? ''),
      drawingNo: String(r.drawing_no ?? r.wo_broj_crteza ?? ''),
    });
    if (!bc) {
      window.alert('Za ovaj red nema prepoznatljivog barkoda (RNZ / kratki format).');
      return;
    }
    const ident = r.order_no && r.item_ref_id ? `${r.order_no}/${r.item_ref_id}` : String(r.order_no ?? '');
    const qty = r.qty_on_location != null ? String(r.qty_on_location) : '';
    const komRn = r.komada_rn != null ? String(r.komada_rn) : '';
    const kolicina = qty && komRn ? `${qty}/${komRn}` : qty || komRn || '';
    const tspl2 = buildTspLabelProgram({
      fields: {
        brojPredmeta: ident,
        nazivDela: String(r.naziv_dela ?? ''),
        brojCrteza: String(r.drawing_no ?? r.wo_broj_crteza ?? ''),
        materijal: [r.materijal, r.dimenzija_materijala].filter(Boolean).join(' '),
        kolicina,
        datum: labelDate(),
      },
      barcodeValue: bc,
      copies: 1,
    });
    try {
      await print.mutateAsync({ tspl2, copies: 1 });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Štampa nije uspela.');
    }
  }

  const allLocs = useAllLocations('true');
  // Indeks (id → loc, parent-lanac) za loc-index fallback hale ugnježdenih mašina.
  const locIndex = useMemo<LocIndex>(() => buildLocIndex(allLocs.data ?? []), [allLocs.data]);
  const hallOptions = useMemo<LocLocation[]>(
    () => (allLocs.data ?? []).filter((l) => HALL_TYPES.includes(l.locationType)).sort((a, b) => a.locationCode.localeCompare(b.locationCode)),
    [allLocs.data],
  );
  const suggest = useReportSuggest(nazivDela);

  // Filteri deljeni ekranom i CSV izvozom (page/pageSize dodaje svaki potrošač).
  const filters: ReportParams = {
    orderNo: orderNo || undefined,
    drawingNo: drawingNo || undefined,
    tpNo: tpNo || undefined,
    nazivDela: nazivDela || undefined,
    locationId: locationId || undefined,
    hallId: hallId || undefined,
    locationKind: locationKind || undefined,
    projectSearch: projectSearch || undefined,
    sort: sort || undefined,
    desc: sort ? desc : undefined,
  };

  const q = useReportByLocation({ ...filters, page, pageSize });

  const rows = q.data?.data.rows ?? [];
  const total = q.data?.data.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Klik na sortabilno zaglavlje: ista kolona → obrni smer; nova → opadajuće (paritet toggleReportSort).
  function toggleSort(key: string) {
    setPage(1);
    if (sort === key) setDesc((d) => !d);
    else { setSort(key); setDesc(true); }
  }

  const columns: Column<ReportRow>[] = [
    { key: 'project_code', header: 'Projekat', sortable: true, render: (r) => [r.project_code, r.project_name].filter(Boolean).join(' — ') || '—' },
    { key: 'customer_name', header: 'Komitent', sortable: true, render: (r) => r.customer_name || '—' },
    { key: 'order_no', header: 'Nalog', sortable: true, render: (r) => (r.order_no ? <strong>{r.order_no}</strong> : '—') },
    {
      key: 'drawing_no',
      header: 'Crtež / naziv',
      sortable: true,
      render: (r) => (
        <div>
          <span>{r.drawing_no || r.wo_broj_crteza || '—'}</span>
          {r.naziv_dela && <div className="text-xs text-ink-secondary">{String(r.naziv_dela).slice(0, 48)}</div>}
        </div>
      ),
    },
    { key: 'item_ref_id', header: 'Stavka', sortable: true, render: (r) => <span className="tnums">{r.item_ref_id || '—'}</span> },
    { key: 'hall_code', header: 'Hala', sortable: true, render: (r) => resolveReportHall(r, locIndex).code || '—' },
    { key: 'location_code', header: 'Polica', sortable: true, render: (r) => r.location_code || '—' },
    { key: 'material', header: 'Materijal', render: (r) => [r.materijal, r.dimenzija_materijala].filter(Boolean).join(' · ') || '—' },
    { key: 'qty_on_location', header: 'Na lok.', align: 'right', numeric: true, sortable: true, render: (r) => num(r.qty_on_location) },
    // „Ukupno" = qty_total_for_bucket (paritet 1.0 kolona „Ukupno", index.js:2013).
    { key: 'qty_total_for_bucket', header: 'Ukupno', align: 'right', numeric: true, render: (r) => num(r.qty_total_for_bucket) },
    // „Status" placement kao StatusBadge (paritet 1.0 kolona „Status" + DESIGN §5/§7).
    { key: 'placement_status', header: 'Status', render: (r) => (r.placement_status ? <PlacementStatusBadge status={String(r.placement_status)} /> : '—') },
    { key: 'rok_izrade', header: 'Rok', sortable: true, render: (r) => (r.rok_izrade ? String(r.rok_izrade).slice(0, 10) : '—') },
    // Akcije reda (paritet 1.0 „📋 RN/TP" + „TP" nalepnica) — stopPropagation da ne okine row-click istorije.
    {
      key: 'actions',
      header: 'Akcije',
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          {r.work_order_id != null && (
            <button
              className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
              title="Otvori tehnološki postupak (operacije + prijave)"
              onClick={(e) => { e.stopPropagation(); setTpModalWo(String(r.work_order_id)); }}
            >
              RN/TP
            </button>
          )}
          <Can permission={PERMISSIONS.LOKACIJE_LABELS}>
            <button
              className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
              title="Nalepnica TP (barkod)"
              onClick={(e) => { e.stopPropagation(); void printRowTp(r); }}
            >
              <Printer className="h-3.5 w-3.5" />
            </button>
          </Can>
        </div>
      ),
    },
  ];

  // CSV = CEO filtrirani skup (fetch-all po stranama), ne samo tekuća strana.
  async function exportCsv() {
    if (exporting) return;
    setExporting({ loaded: 0, total: null });
    try {
      const { rows: all, total, truncated } = await fetchAllReportByLocation(filters, {
        onProgress: (p) => setExporting(p),
      });
      if (all.length === 0) {
        window.alert('Nema redova za export.');
        return;
      }
      downloadCsv(buildCsvFilename('lokacije_pregled_po_lokacijama'), REPORT_CSV_HEADERS, all.map((r) => buildReportCsvRow(r, locIndex)));
      if (truncated) {
        window.alert(`Export prekinut na 50 000 redova. Ukupno u upitu: ${total ?? '?'}. Suzi filtere.`);
      }
    } catch (err) {
      window.alert(`Export neuspešan: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      setExporting(null);
    }
  }

  const suggestions = suggest.data?.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className={INPUT} placeholder="Nalog" value={orderNo} onChange={(e) => { setOrderNo(e.target.value); setPage(1); }} />
        <input className={INPUT} placeholder="Crtež" value={drawingNo} onChange={(e) => { setDrawingNo(e.target.value); setPage(1); }} />
        <input className={INPUT} placeholder="TP" value={tpNo} onChange={(e) => { setTpNo(e.target.value); setPage(1); }} />
        <div className="relative">
          <input
            className={INPUT}
            placeholder="Naziv dela"
            value={nazivDela}
            onChange={(e) => { setNazivDela(e.target.value); setPage(1); }}
            onFocus={() => setNazivFocus(true)}
            onBlur={() => setTimeout(() => setNazivFocus(false), 150)}
          />
          {nazivFocus && suggestions.length > 0 && (
            <div className="absolute z-10 mt-1 max-h-56 w-64 overflow-auto rounded-control border border-line bg-surface shadow-lg">
              {suggestions.map((s, i) => (
                <button
                  key={`${s.naziv_dela}|${i}`}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); setNazivDela(s.naziv_dela); setNazivFocus(false); setPage(1); }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2"
                >
                  <span className="truncate text-ink">{s.naziv_dela}</span>
                  {s.placement_count != null && <span className="shrink-0 text-xs text-ink-disabled">{s.placement_count}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <select className={INPUT} value={hallId} onChange={(e) => { setHallId(e.target.value); setPage(1); }} title="Hala">
          <option value="">Sve hale</option>
          {hallOptions.map((h) => (
            <option key={h.id} value={h.id}>{h.locationCode} — {h.name}</option>
          ))}
        </select>
        <select className={INPUT} value={locationKind} onChange={(e) => { setLocationKind(e.target.value as '' | 'shelf' | 'cage'); setPage(1); }} title="Vrsta lokacije">
          <option value="">Police + kavezi</option>
          <option value="shelf">Samo police</option>
          <option value="cage">Samo kavezi</option>
        </select>
        <div className="min-w-56">
          <LocationSelect
            locations={allLocs.data ?? []}
            value={locationId}
            onChange={(v) => { setLocationId(v); setPage(1); }}
            kinds={['SHELF', 'RACK', 'BIN', 'CAGE']}
            placeholder="Polica / kavez (npr. KV 7)…"
          />
        </div>
        <input className={INPUT} placeholder="Projekat / komitent" value={projectSearch} onChange={(e) => { setProjectSearch(e.target.value); setPage(1); }} />
        <span className="ml-auto text-sm text-ink-secondary tnums">{total} zapisa</span>
        <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0 || exporting != null}>
          <Download className="h-4 w-4" />
          {exporting
            ? `CSV… ${exporting.loaded}${exporting.total != null ? `/${exporting.total}` : ''}`
            : 'CSV'}
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.placement_id ?? `${r.item_ref_id}|${r.order_no}|${r.location_code}`)}
        loading={q.isLoading}
        sort={sort ? { key: sort, dir: desc ? 'desc' : 'asc' } : null}
        onSortToggle={toggleSort}
        onRowActivate={(r) =>
          setHistory({
            itemRefTable: String(r.item_ref_table ?? ''),
            itemRefId: String(r.item_ref_id ?? ''),
            orderNo: String(r.order_no ?? ''),
          })
        }
        empty={tableEmpty(q.isError, 'Nema rezultata', 'Suzi ili promeni filtere pregleda.')}
      />

      <div className="flex items-center justify-between gap-3">
        <PageSizeSelect value={pageSize} onChange={(n) => { setPageSize(n); setPage(1); }} />
        {totalPages > 1 && (
          <Pager page={page} totalPages={totalPages} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
        )}
      </div>

      {history && (
        <ItemHistoryDialog
          itemRefId={history.itemRefId}
          itemRefTable={history.itemRefTable}
          orderNo={history.orderNo || undefined}
          onClose={() => setHistory(null)}
        />
      )}
      {tpModalWo && <TpProcedureModal workOrderId={tpModalWo} onClose={() => setTpModalWo(null)} />}
    </div>
  );
}

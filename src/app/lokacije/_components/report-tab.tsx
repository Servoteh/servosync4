'use client';

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import {
  HALL_TYPES,
  fetchAllReportByLocation,
  useAllLocations,
  useReportByLocation,
  useReportSuggest,
  type LocLocation,
  type ReportParams,
  type ReportRow,
} from '@/api/lokacije';
import { buildCsvFilename, csvTimestamp, downloadCsv, tableEmpty } from './common';

const INPUT = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent';

const num = (v: unknown): string => (v == null || v === '' ? '—' : String(v));

// ------------------------------------------------------------------ CSV izvoz (paritet 1.0)
// Zaglavlja + red = 1.0 `REPORT_CSV_HEADERS` / `buildReportCsvRow`
// (src/lib/lokacijeReportLocations.js). RPC `loc_report_parts_by_locations`
// vraća sva lokaciona polja (hall_*, location_kind, location_path…) direktno u
// redu — bez `location_id` — pa se prikaz lokacije čita iz reda (1.0 loc-index
// fallback se nikad ne aktivira za ove redove).

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

function normalizeReportKind(v: unknown): '' | 'shelf' | 'cage' {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'shelf' || s === 'cage' ? s : '';
}

function buildReportCsvRow(r: ReportRow): (string | number)[] {
  const hallCode = String(r.hall_code ?? '').trim();
  const hallName = String(r.hall_name ?? '').trim();
  const kind = normalizeReportKind(r.location_kind);
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
    reportLocationKindLabel(kind) || kind,
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
  const [locationQ, setLocationQ] = useState('');
  const [hallId, setHallId] = useState('');
  const [locationKind, setLocationKind] = useState<'' | 'shelf' | 'cage'>('');
  const [projectSearch, setProjectSearch] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<{ loaded: number; total: number | null } | null>(null);
  const pageSize = 100;

  const halls = useAllLocations('true');
  const hallOptions = useMemo<LocLocation[]>(
    () => (halls.data ?? []).filter((l) => HALL_TYPES.includes(l.locationType)).sort((a, b) => a.locationCode.localeCompare(b.locationCode)),
    [halls.data],
  );
  const suggest = useReportSuggest(nazivDela);

  // Filteri deljeni ekranom i CSV izvozom (page/pageSize dodaje svaki potrošač).
  const filters: ReportParams = {
    orderNo: orderNo || undefined,
    drawingNo: drawingNo || undefined,
    tpNo: tpNo || undefined,
    nazivDela: nazivDela || undefined,
    locationQ: locationQ || undefined,
    hallId: hallId || undefined,
    locationKind: locationKind || undefined,
    projectSearch: projectSearch || undefined,
  };

  const q = useReportByLocation({ ...filters, page, pageSize });

  const rows = q.data?.data.rows ?? [];
  const total = q.data?.data.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const columns: Column<ReportRow>[] = [
    { key: 'project', header: 'Projekat', render: (r) => [r.project_code, r.project_name].filter(Boolean).join(' — ') || '—' },
    { key: 'customer', header: 'Komitent', render: (r) => r.customer_name || '—' },
    { key: 'order', header: 'Nalog', render: (r) => (r.order_no ? <strong>{r.order_no}</strong> : '—') },
    {
      key: 'drawing',
      header: 'Crtež / naziv',
      render: (r) => (
        <div>
          <span>{r.drawing_no || r.wo_broj_crteza || '—'}</span>
          {r.naziv_dela && <div className="text-xs text-ink-secondary">{String(r.naziv_dela).slice(0, 48)}</div>}
        </div>
      ),
    },
    { key: 'item', header: 'Stavka', render: (r) => <span className="tnums">{r.item_ref_id || '—'}</span> },
    { key: 'hall', header: 'Hala', render: (r) => r.hall_code || '—' },
    { key: 'shelf', header: 'Polica', render: (r) => r.location_code || '—' },
    { key: 'material', header: 'Materijal', render: (r) => [r.materijal, r.dimenzija_materijala].filter(Boolean).join(' · ') || '—' },
    { key: 'qty', header: 'Na lok.', align: 'right', numeric: true, render: (r) => num(r.qty_on_location) },
    { key: 'rok', header: 'Rok', render: (r) => (r.rok_izrade ? String(r.rok_izrade).slice(0, 10) : '—') },
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
      downloadCsv(buildCsvFilename('lokacije_pregled_po_lokacijama'), REPORT_CSV_HEADERS, all.map(buildReportCsvRow));
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
        <input className={INPUT} placeholder="Lokacija (šifra)" value={locationQ} onChange={(e) => { setLocationQ(e.target.value); setPage(1); }} />
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
        rowKey={(r) => `${r.item_ref_table}|${r.item_ref_id}|${r.order_no}|${r.location_code}`}
        loading={q.isLoading}
        empty={tableEmpty(q.isError, 'Nema rezultata', 'Suzi ili promeni filtere pregleda.')}
      />

      {totalPages > 1 && (
        <Pager page={page} totalPages={totalPages} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
      )}
    </div>
  );
}

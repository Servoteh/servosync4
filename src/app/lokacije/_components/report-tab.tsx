'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { useReportByLocation, type ReportRow } from '@/api/lokacije';
import { downloadCsv, tableEmpty } from './common';

const INPUT = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent';

const num = (v: unknown): string => (v == null || v === '' ? '—' : String(v));

/** Pregled delova po lokacijama — loc_report_parts_by_locations (filteri + CSV). */
export function ReportTab() {
  const [orderNo, setOrderNo] = useState('');
  const [drawingNo, setDrawingNo] = useState('');
  const [nazivDela, setNazivDela] = useState('');
  const [locationQ, setLocationQ] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 100;

  const q = useReportByLocation({
    orderNo: orderNo || undefined,
    drawingNo: drawingNo || undefined,
    nazivDela: nazivDela || undefined,
    locationQ: locationQ || undefined,
    projectSearch: projectSearch || undefined,
    page,
    pageSize,
  });

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

  function exportCsv() {
    downloadCsv(
      `pregled_po_lokacijama_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Projekat', 'Komitent', 'Nalog', 'Crtež', 'Naziv dela', 'Stavka', 'Hala', 'Polica', 'Materijal', 'Dimenzija', 'Na lokaciji', 'Ukupno', 'Rok'],
      rows.map((r) => [
        [r.project_code, r.project_name].filter(Boolean).join(' — '),
        r.customer_name, r.order_no, r.drawing_no || r.wo_broj_crteza, r.naziv_dela,
        r.item_ref_id, r.hall_code, r.location_code, r.materijal, r.dimenzija_materijala,
        num(r.qty_on_location), num(r.qty_total_for_bucket), r.rok_izrade ? String(r.rok_izrade).slice(0, 10) : '',
      ]),
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className={INPUT} placeholder="Nalog" value={orderNo} onChange={(e) => { setOrderNo(e.target.value); setPage(1); }} />
        <input className={INPUT} placeholder="Crtež" value={drawingNo} onChange={(e) => { setDrawingNo(e.target.value); setPage(1); }} />
        <input className={INPUT} placeholder="Naziv dela" value={nazivDela} onChange={(e) => { setNazivDela(e.target.value); setPage(1); }} />
        <input className={INPUT} placeholder="Lokacija (šifra)" value={locationQ} onChange={(e) => { setLocationQ(e.target.value); setPage(1); }} />
        <input className={INPUT} placeholder="Projekat / komitent" value={projectSearch} onChange={(e) => { setProjectSearch(e.target.value); setPage(1); }} />
        <span className="ml-auto text-sm text-ink-secondary tnums">{total} zapisa</span>
        <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="h-4 w-4" /> CSV
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

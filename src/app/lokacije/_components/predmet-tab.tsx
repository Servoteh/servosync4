'use client';

import { useState } from 'react';
import { FileText, Printer, Search } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { apiFetch } from '@/api/client';
import { openDrawingPdf, type Drawing } from '@/api/pdm';
import { usePredmetTps, usePrintLocLabel, type PredmetTpRow } from '@/api/lokacije';
import { buildTspLabelProgram } from '@/lib/tspl2';
import { labelDate } from '@/lib/label-print';
import { tableEmpty } from './common';
import { barcodeForRow } from './label-build';

const INPUT = 'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent';
const num = (v: unknown): string => (v == null || v === '' ? '—' : String(v));

/** Otvori PDF crteža preko 2.0 PDM (rezolucija broja crteža → id). */
async function openDrawingByNumber(drawingNumber: string) {
  try {
    const res = await apiFetch<{ data: Drawing[] }>(
      `/v1/pdm/drawings?q=${encodeURIComponent(drawingNumber)}&pageSize=5`,
    );
    const hit = res.data.find((d) => d.drawingNumber === drawingNumber) ?? res.data[0];
    if (hit) await openDrawingPdf(hit.id);
    else alert(`Crtež ${drawingNumber} nije nađen u PDM-u.`);
  } catch {
    alert('PDF crteža trenutno nije dostupan.');
  }
}

/** Pregled predmeta — TP-ovi + placement + op-status (loc_tps_for_predmet). */
export function PredmetTab() {
  const [predmetInput, setPredmetInput] = useState('');
  const [predmetId, setPredmetId] = useState<string | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [includeAssembled, setIncludeAssembled] = useState(false);
  const [woId, setWoId] = useState<string | undefined>(undefined);

  const print = usePrintLocLabel();
  const q = usePredmetTps(predmetId, { onlyOpen, includeAssembled, workOrderId: woId, pageSize: 500 });
  const rows = q.data?.data.rows ?? [];
  const opStatus = q.data?.meta.opStatus as { rows?: Record<string, unknown>[] } | null;

  async function printTp(r: PredmetTpRow) {
    const bc = barcodeForRow({
      itemRefTable: 'bigtehn_rn',
      orderNo: r.wo_ident_broj,
      itemRefId: r.tp_no,
      drawingNo: r.wo_broj_crteza,
    });
    if (!bc) return alert('Za ovaj TP nema prepoznatljivog barkoda (RNZ / kratki format).');
    const tspl2 = buildTspLabelProgram({
      fields: {
        brojPredmeta: r.wo_ident_broj,
        nazivDela: r.naziv_dela,
        brojCrteza: r.wo_broj_crteza,
        materijal: [r.materijal, r.dimenzija_materijala].filter(Boolean).join(' '),
        kolicina: r.komada_rn != null ? String(r.komada_rn) : '',
        datum: labelDate(),
      },
      barcodeValue: bc,
      copies: 1,
    });
    try {
      await print.mutateAsync({ tspl2, copies: 1 });
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Štampa nije uspela.');
    }
  }

  const columns: Column<PredmetTpRow>[] = [
    { key: 'ident', header: 'Predmet', render: (r) => r.wo_ident_broj || '—' },
    { key: 'tp', header: 'TP', render: (r) => <span className="tnums">{r.tp_no || '—'}</span> },
    {
      key: 'crtez',
      header: 'Crtež',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          {r.wo_broj_crteza || '—'}
          {r.wo_broj_crteza && r.has_pdf === true && (
            <button
              onClick={(e) => { e.stopPropagation(); void openDrawingByNumber(String(r.wo_broj_crteza)); }}
              className="text-accent hover:opacity-80"
              title="PDF crteža"
              aria-label="PDF crteža"
            >
              <FileText className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      ),
    },
    { key: 'naziv', header: 'Naziv dela', render: (r) => String(r.naziv_dela ?? '—').slice(0, 60) },
    {
      key: 'qty',
      header: 'Na lok. / RN',
      align: 'right',
      numeric: true,
      render: (r) => `${num(r.qty_on_location)} / ${num(r.komada_rn)}`,
    },
    { key: 'loc', header: 'Lokacija', render: (r) => (r.location_code ? `${r.location_code}${r.location_name ? ` (${r.location_name})` : ''}` : '— bez lokacije —') },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          {r.work_order_id != null && (
            <button className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); setWoId(String(r.work_order_id)); }}>
              Op-status
            </button>
          )}
          <Can permission={PERMISSIONS.LOKACIJE_LABELS}>
            <button className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); void printTp(r); }} title="Nalepnica TP">
              <Printer className="h-3.5 w-3.5" />
            </button>
          </Can>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); setPredmetId(predmetInput.trim() || null); setWoId(undefined); }}
      >
        <input className={INPUT} placeholder="ID predmeta (broj)" value={predmetInput} onChange={(e) => setPredmetInput(e.target.value)} inputMode="numeric" />
        <Button type="submit"><Search className="h-4 w-4" /> Učitaj</Button>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Samo otvoreni
        </label>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={includeAssembled} onChange={(e) => setIncludeAssembled(e.target.checked)} /> Sa montiranim
        </label>
      </form>

      {!predmetId ? (
        tableEmpty(false, 'Unesi ID predmeta', 'Prikazuju se tehnološki postupci predmeta sa placement-ima i op-statusom.')
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => `${r.work_order_id}|${r.tp_no}`}
            loading={q.isLoading}
            empty={tableEmpty(q.isError, 'Nema tehnoloških postupaka', 'Za ovaj predmet i filtere nema TP-ova.')}
          />
          {opStatus?.rows && opStatus.rows.length > 0 && (
            <div className="rounded-panel border border-line bg-surface-2 p-3">
              <div className="mb-2 text-sm font-semibold text-ink">Op-status (radni nalog {woId})</div>
              <pre className="max-h-64 overflow-auto text-xs text-ink-secondary">{JSON.stringify(opStatus.rows, null, 2)}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

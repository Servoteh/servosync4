/**
 * Lokacije → „Pregled predmeta" — Štampa / Export PDF filtriranog spiska TP-ova
 * kroz PREGLEDAČ (`window.open` + print CSS), VERAN port 1.0
 * `src/ui/lokacije/predmetTab.js` (`openPrintWindow`, linije 987-1064).
 *
 * `mode === 'pdf'` i `mode === 'print'` dele isti HTML; jedina razlika je da PDF
 * auto-okine `window.print()` (korisnik u dijalogu bira „Sačuvaj kao PDF"). Ovo je
 * 1.0 kanon — nema zasebnog jsPDF generatora za ovaj spisak (izbor: print
 * stylesheet, jednostavnije + verno 1.0). CSV je odvojen (klijentski, common.tsx).
 */

import type { PredmetTpRow } from '@/api/lokacije';

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PredmetPrintSel {
  broj_predmeta?: string | null;
  naziv_predmeta?: string | null;
  customer_name?: string | null;
}

export interface PredmetPrintFilters {
  tpNo: string;
  drawingNo: string;
  locationFilter: 'all' | 'with' | 'without';
  includeAssembled: boolean;
}

/**
 * Otvori prozor za štampu/PDF filtriranog spiska (paritet 1.0 openPrintWindow).
 * @param mode 'print' = odmah print(); 'pdf' = print() sa uputstvom „Sačuvaj kao PDF".
 */
export function openPredmetPrintWindow({
  rows,
  total,
  sel,
  filters,
  mode,
}: {
  rows: PredmetTpRow[];
  total: number;
  sel: PredmetPrintSel;
  filters: PredmetPrintFilters;
  mode: 'print' | 'pdf';
}): void {
  const win = window.open('', '_blank', 'width=1200,height=900');
  if (!win) {
    window.alert('Pop-up blocker je sprečio otvaranje prozora za štampu. Dozvoli pop-up za ovaj sajt.');
    return;
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateLabel = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const filtChips: string[] = [];
  if (filters.tpNo) filtChips.push(`TP: ${escHtml(filters.tpNo)}`);
  if (filters.drawingNo) filtChips.push(`Crtež: ${escHtml(filters.drawingNo)}`);
  if (filters.locationFilter === 'with') filtChips.push('Samo sa lokacijom');
  else if (filters.locationFilter === 'without') filtChips.push('Samo BEZ lokacije');
  filtChips.push('Samo aktivni RN');
  if (filters.includeAssembled) filtChips.push('Uključeni ugrađeni/otpisani');

  const tableBody = rows
    .map((r) => {
      const qtyLoc = r.qty_on_location != null ? r.qty_on_location : '';
      const qtyRn = r.komada_rn != null ? r.komada_rn : '';
      const loc = r.location_code
        ? `${escHtml(r.location_code)}${r.location_name ? ` — ${escHtml(r.location_name)}` : ''}`
        : '<span class="muted">— bez lokacije —</span>';
      const status = r.status_rn === true ? 'Zatvoren' : r.status_rn === false ? 'Otvoren' : '';
      return `<tr>
      <td><strong>${escHtml(r.wo_ident_broj || '')}</strong></td>
      <td>${escHtml(r.wo_broj_crteza || '')}</td>
      <td>${escHtml(String(r.naziv_dela || '').slice(0, 80))}</td>
      <td class="num">${escHtml(String(qtyLoc))}${qtyRn !== '' ? ` <span class="muted">/ ${escHtml(String(qtyRn))}</span>` : ''}</td>
      <td>${loc}</td>
      <td>${escHtml(String(r.materijal || ''))}${r.dimenzija_materijala ? ` <span class="muted">${escHtml(r.dimenzija_materijala)}</span>` : ''}</td>
      <td>${escHtml(status)}</td>
    </tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="sr"><head>
<meta charset="utf-8" />
<title>Predmet ${escHtml(sel.broj_predmeta || '')} — lokacije TP</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 18mm 12mm 14mm; color: #111; font-size: 11px; }
  h1 { margin: 0 0 4px; font-size: 16px; } h2 { margin: 0 0 10px; font-size: 13px; font-weight: 500; color: #333; }
  .meta { margin: 6px 0 12px; font-size: 11px; color: #444; }
  .filt { margin: 6px 0 12px; font-size: 11px; color: #333; padding: 6px 8px; background: #f3f4f6; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  thead th { background: #e5e7eb; text-align: left; padding: 6px 8px; border: 1px solid #9ca3af; font-weight: 600; }
  tbody td { padding: 5px 8px; border: 1px solid #d1d5db; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #f9fafb; }
  td.num { text-align: right; } .muted { color: #6b7280; }
  .actions { margin: 0 0 12px; } .actions button { font-size: 12px; padding: 6px 12px; cursor: pointer; }
  @media print { .actions { display: none !important; } body { margin: 12mm 8mm 10mm; } thead { display: table-header-group; } tr { page-break-inside: avoid; } }
</style></head><body>
  <div class="actions">
    <button type="button" onclick="window.print()">${mode === 'pdf' ? 'Sačuvaj kao PDF' : 'Štampaj'}</button>
    <button type="button" onclick="window.close()">Zatvori</button>
    ${mode === 'pdf' ? '<span class="muted" style="margin-left:8px">U dijalogu štampe izaberi „Sačuvaj kao PDF".</span>' : ''}
  </div>
  <h1>Predmet ${escHtml(sel.broj_predmeta || '')} — ${escHtml(sel.naziv_predmeta || '')}</h1>
  ${sel.customer_name ? `<h2>Komitent: ${escHtml(sel.customer_name)}</h2>` : ''}
  <div class="meta">Datum: ${escHtml(dateLabel)} · Ukupno redova: ${escHtml(String(total))}</div>
  <div class="filt"><strong>Filteri:</strong> ${filtChips.length ? filtChips.join(' · ') : 'nema'}</div>
  <table>
    <thead><tr><th>RN (Predmet/TP)</th><th>Crtež</th><th>Naziv dela</th><th class="num">Količina (lok / RN)</th><th>Lokacija</th><th>Materijal</th><th>Status RN</th></tr></thead>
    <tbody>${tableBody || '<tr><td colspan="7" class="muted" style="text-align:center;padding:14px">Nema redova.</td></tr>'}</tbody>
  </table>
  <script>window.addEventListener('load', () => { ${mode === 'pdf' ? 'setTimeout(() => window.print(), 250);' : ''} });<\/script>
</body></html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
  if (mode === 'print') {
    setTimeout(() => {
      try {
        win.print();
      } catch {
        /* ignore */
      }
    }, 200);
  }
}

/** CSV zaglavlja punog spiska (18 kolona; paritet 1.0 predmetTab buildCsvText). */
export const PREDMET_CSV_HEADERS = [
  'RN (Predmet/TP)', 'Broj TP', 'Broj crteža', 'Naziv dela', 'Materijal',
  'Dimenzija materijala', 'Komada (RN)', 'Količina na lokaciji', 'Ukupno raspoređeno',
  'Lokacija šifra', 'Lokacija naziv', 'Putanja lokacije', 'Tip lokacije',
  'Status placement', 'Status RN', 'Revizija', 'Rok izrade', 'Težina obr (kg)',
];

/** Jedan CSV red punog spiska (18 kolona; paritet 1.0 predmetTab buildCsvText). */
export function buildPredmetCsvRow(r: PredmetTpRow): (string | number)[] {
  return [
    r.wo_ident_broj ?? '',
    r.tp_no ?? '',
    r.wo_broj_crteza ?? '',
    r.naziv_dela ?? '',
    r.materijal ?? '',
    r.dimenzija_materijala ?? '',
    r.komada_rn ?? '',
    r.qty_on_location ?? '',
    r.qty_total_placed ?? '',
    r.location_code ?? '',
    r.location_name ?? '',
    r.location_path ?? '',
    r.location_type ?? '',
    r.placement_status ?? '',
    r.status_rn === true ? 'Zatvoren' : r.status_rn === false ? 'Otvoren' : '',
    r.revizija ?? '',
    r.rok_izrade ? String(r.rok_izrade).slice(0, 10) : '',
    r.tezina_obr != null && Number(r.tezina_obr) > 0 ? Number(r.tezina_obr).toFixed(2) : '',
  ];
}

// Praćenje proizvodnje — izvozi tabele praćenja i RN tabova (port 1.0
// services/pracenjeIzvestajExport.js + pracenjeExport.js). XLSX preko bundlovanog
// SheetJS-a (`xlsx`), PDF preko jsPDF (Roboto latin-ext font iz /public/fonts, A3
// landscape). Poštuje aktivni filter + parent override + opseg (redovi stižu već
// re-parentovani/filtrirani iz komponente). Radi u browseru: writeFile → download.

import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import { ensureRoboto } from './plan-montaze/pdf-font';
import { fetchCrtezSignUrl, type IzvestajResult, type IzvestajRow, type PracenjeStatusi, type PracenjeOperacija } from '@/api/pracenje';

/** Izvozni tekst DA/NE (1.0 daNeText — pracenjeIzvestajExport.js:30): „DA — {pun status}". */
export function daNeText(statusStr: string | null | undefined): string {
  const s = String(statusStr ?? '').trim();
  if (!s || s === '—') return 'NE';
  return `DA — ${s}`;
}

// ------------------------------------------------------------------ helpers

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeNamePart(s: string | null | undefined): string {
  return String(s || 'predmet').replace(/[^\w-]+/g, '_').slice(0, 40);
}

function buildBaseFileName(result: IzvestajResult): string {
  const broj = result.predmet?.broj_predmeta || 'predmet';
  const root = result.root;
  const scope = root?.node_id != null ? `root-${root.node_id}` : 'ceo-predmet';
  return `pracenje-proizvodnje_${safeNamePart(broj)}_${safeNamePart(scope)}_${todayYmd()}`;
}

function statusBitsText(st: PracenjeStatusi | undefined): string {
  const s = st ?? {};
  return (
    [
      s.kasni && 'Kasni',
      s.nema_tp && 'Nema TP',
      s.nema_crtez && 'Nema crtež',
      s.nema_zavrsnu_kontrolu && 'Nema ZK',
      s.nije_kompletirano && 'Nije kompl.',
      s.nema_rn && 'Nema RN',
    ]
      .filter(Boolean)
      .join(', ') || 'OK'
  );
}

// NAMERNO ODSTUPANJE OD 1.0: izvoz koristi override-aware vrednost („DA — ručno" / „NE — ručno")
// umesto 1.0 auto-only daNeText — tako je izvezena ćelija verna onome što korisnik vidi na ekranu.
/** DA/NE za izvoz uz override (override gazi auto — kao ekran). */
function daNeExport(auto: string | null | undefined, ovr: boolean | null | undefined): string {
  if (ovr === true) return 'DA — ručno';
  if (ovr === false) return 'NE — ručno';
  return daNeText(auto);
}

function maxOpSlots(rows: IzvestajRow[]): number {
  let m = 0;
  for (const r of rows) if (Array.isArray(r.operations)) m = Math.max(m, r.operations.length);
  return m;
}

/** „Završna kol." iz poslednje ZK operacije (1.0 pravilo — completed/planned poslednje is_final_control). */
function finalQtyText(ops: PracenjeOperacija[] | undefined): string {
  const list = ops ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.is_final_control) return `${list[i].completed_qty ?? ''}/${list[i].planned_qty ?? ''}`;
  }
  return '';
}

/** Sumar operacija za PDF (1.0 formatOpsSummaryForPdf). */
function opsSummaryForPdf(ops: PracenjeOperacija[] | undefined): string {
  const list = ops ?? [];
  if (!list.length) return '—';
  const fin = list.filter((o) => o.is_final_control);
  const lastFin = fin.length ? fin[fin.length - 1] : null;
  const tail = lastFin ? ` · završna ${lastFin.completed_qty ?? ''}/${lastFin.planned_qty ?? ''}` : '';
  return `${list.length} operacija${tail}`;
}

/** Signed URL-ovi za sve (radne + sklopne) crteže u redovima (za Excel hiperlinkove / PDF link). */
async function resolveDrawingUrls(rows: IzvestajRow[]): Promise<Map<string, string>> {
  const nos = new Set<string>();
  for (const r of rows) {
    if (r.crtez_drawing_no) nos.add(String(r.crtez_drawing_no));
    if (r.sklop_drawing_no) nos.add(String(r.sklop_drawing_no));
  }
  const entries = await Promise.all(
    [...nos].map(async (n): Promise<[string, string] | null> => {
      try {
        const res = await fetchCrtezSignUrl(n);
        return res.data?.url ? [n, res.data.url] : null;
      } catch {
        return null;
      }
    }),
  );
  const map = new Map<string, string>();
  for (const e of entries) if (e) map.set(e[0], e[1]);
  return map;
}

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ Tabela praćenja: XLSX (PR-18)

export interface IzvestajExportInput {
  result: IzvestajResult;
  rows: IzvestajRow[]; // već re-parentovani + filtrirani (kao ekran)
  filter: string;
  lot: number;
}

/**
 * Pravi .xlsx (PR-18): meta blok 8 redova, 17 fiksnih kolona + dinamički parovi
 * Operacija N/Kol. N, Excel hiperlinkovi na signed URL crteža (radni + sklopni),
 * „Završna kol." iz poslednje ZK operacije. Ime fajla 1:1 sa 1.0.
 */
export async function exportIzvestajXlsx({ result, rows, filter, lot }: IzvestajExportInput): Promise<void> {
  if (!rows.length) throw new Error('Nema redova za izvoz.');
  const nSlots = maxOpSlots(rows);
  const urlMap = await resolveDrawingUrls(rows);
  const pred = result.predmet ?? {};

  const meta: (string | number)[][] = [
    ['Praćenje proizvodnje — izveštaj'],
    ['Predmet', pred.broj_predmeta || '', pred.naziv_predmeta || ''],
    ['Komitent', pred.komitent || ''],
    ['Rok završetka', pred.rok_zavrsetka != null ? String(pred.rok_zavrsetka) : ''],
    ['Opseg', result.root?.naziv || 'Ceo predmet'],
    ['Lot', String(result.lot_qty ?? lot ?? 12)],
    ['Generisano', result.generated_at != null ? String(result.generated_at) : new Date().toISOString()],
    ['Filter', filter || 'sve'],
    [],
  ];

  const opHeaders: string[] = [];
  for (let i = 0; i < nSlots; i += 1) opHeaders.push(`Operacija ${i + 1}`, `Kol. ${i + 1}`);
  const headers = [
    'Nivo', 'Naziv', 'Broj crteža', 'Sklopni crtež', 'RN', 'Lansirano', 'Završeno', 'Za lot',
    'Datum lans. TP', 'Datum izrade', 'Maš. obrada', 'Površ. zaštita', 'Materijal', 'Dimenzije',
    'Napomena', 'Status', 'Završna kol.', ...opHeaders,
  ];

  const aoa: (string | number)[][] = [...meta, headers];

  for (const r of rows) {
    const note = [r.sistemska_napomena, r.korisnicka_napomena].filter(Boolean).join(' | ');
    const row: (string | number)[] = [
      Number(r.level ?? 0),
      r.naziv_pozicije || '',
      r.broj_crteza || '',
      r.broj_sklopnog_crteza || '',
      r.rn_broj || '',
      r.lansirana_kolicina ?? '',
      r.zavrsena_kolicina ?? '',
      r.required_for_lot ?? 'N/A',
      r.datum_lansiranja_tp || '',
      r.datum_izrade || '',
      daNeExport(r.masinska_obrada_status, r.masinska_done_override),
      daNeExport(r.povrsinska_zastita_status, r.povrsinska_done_override),
      r.materijal || '',
      r.dimenzije || '',
      note,
      statusBitsText(r.statusi),
      finalQtyText(r.operations),
    ];
    const ops = r.operations ?? [];
    for (let i = 0; i < nSlots; i += 1) {
      const o = ops[i];
      if (!o) row.push('', '');
      else row.push(String(o.naziv ?? ''), `${o.completed_qty ?? ''}/${o.planned_qty ?? ''}`);
    }
    aoa.push(row);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headers.map((_, i) => ({ wch: i === 1 ? 36 : 14 }));

  // Hiperlinkovi na crteže (redovi podataka počinju posle meta + header).
  const metaRows = meta.length;
  const drawCol = 2;
  const sklopCol = 3;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const rIdx = metaRows + 1 + i; // 0-based (meta + header = metaRows+1 redova pre podataka)
    const cr = r.crtez_drawing_no ? urlMap.get(String(r.crtez_drawing_no)) : null;
    if (cr) {
      const addr = XLSX.utils.encode_cell({ r: rIdx, c: drawCol });
      if (ws[addr]) ws[addr].l = { Target: cr, Tooltip: 'Crtež' };
    }
    const sr = r.sklop_drawing_no ? urlMap.get(String(r.sklop_drawing_no)) : null;
    if (sr) {
      const addr = XLSX.utils.encode_cell({ r: rIdx, c: sklopCol });
      if (ws[addr]) ws[addr].l = { Target: sr, Tooltip: 'Sklopni crtež' };
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Praćenje');
  XLSX.writeFile(wb, `${buildBaseFileName(result)}.xlsx`);
}

// ------------------------------------------------------------------ Tabela praćenja: PDF (PR-19)

/**
 * jsPDF A3 landscape (PR-19): meta zaglavlje, 10 kolona sa truncation, klikabilan
 * doc.link na crtež, druga sekcija „Detalj operacija po pozicijama", page-break.
 */
export async function exportIzvestajPdf({ result, rows, lot }: IzvestajExportInput): Promise<void> {
  if (!rows.length) throw new Error('Nema redova za izvoz.');
  const urlMap = await resolveDrawingUrls(rows);
  const pred = result.predmet ?? {};

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
  await ensureRoboto(doc);
  doc.setFont('Roboto', 'normal');
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const m = 10;
  const line = 5;
  let y = m;

  doc.setFontSize(14);
  doc.setFont('Roboto', 'bold');
  doc.text('Praćenje proizvodnje', m, y);
  doc.setFont('Roboto', 'normal');
  y += line + 2;
  doc.setFontSize(10);
  doc.text(`Predmet: ${pred.broj_predmeta || ''} ${pred.naziv_predmeta || ''}`, m, y); y += line;
  doc.text(`Komitent: ${pred.komitent || ''}`, m, y); y += line;
  doc.text(`Opseg: ${result.root?.naziv || 'Ceo predmet'}`, m, y); y += line;
  doc.text(`Lot: ${result.lot_qty ?? lot ?? 12}`, m, y); y += line;
  doc.text(`Generisano: ${result.generated_at != null ? String(result.generated_at) : new Date().toISOString()}`, m, y);
  y += line + 4;

  const colW = (pageW - 2 * m) / 10;
  const headers = ['Pozicija', 'Crtež', 'RN', 'Lans.', 'Zavr.', 'Za lot', 'Datumi', 'Mat./dim.', 'Napomena', 'Operacije'];
  doc.setFont('Roboto', 'bold');
  headers.forEach((h, i) => doc.text(h, m + i * colW, y));
  doc.setFont('Roboto', 'normal');
  y += line;

  for (const r of rows) {
    if (y > pageH - 20) {
      doc.addPage();
      y = m;
    }
    const drawL = r.crtez_drawing_no ? urlMap.get(String(r.crtez_drawing_no)) : null;
    const poz = `${'  '.repeat(Number(r.level || 0))}${(r.naziv_pozicije || '').slice(0, 42)}`;
    doc.text(poz, m, y);
    doc.text(String(r.broj_crteza || '—').slice(0, 14), m + colW, y);
    doc.text(String(r.rn_broj || '').slice(0, 12), m + 2 * colW, y);
    doc.text(String(r.lansirana_kolicina ?? '—'), m + 3 * colW, y);
    doc.text(String(r.zavrsena_kolicina ?? '—'), m + 4 * colW, y);
    doc.text(String(r.required_for_lot ?? 'N/A'), m + 5 * colW, y);
    doc.text(`${r.datum_lansiranja_tp || '—'} / ${r.datum_izrade || '—'}`, m + 6 * colW, y);
    doc.text(`${(r.materijal || '').slice(0, 10)} ${(r.dimenzije || '').slice(0, 10)}`, m + 7 * colW, y);
    doc.text((r.korisnicka_napomena || r.sistemska_napomena || '').slice(0, 28), m + 8 * colW, y);
    doc.text(opsSummaryForPdf(r.operations).slice(0, 72), m + 9 * colW, y);
    if (drawL) doc.link(m + colW, y - 4, colW, line, { url: drawL });
    y += line;
  }

  // Detalj operacija — druga sekcija.
  doc.addPage();
  y = m;
  doc.setFontSize(12);
  doc.setFont('Roboto', 'bold');
  doc.text('Detalj operacija po pozicijama', m, y);
  doc.setFont('Roboto', 'normal');
  y += line + 2;
  doc.setFontSize(9);
  for (const r of rows) {
    const ops = r.operations ?? [];
    if (!ops.length) continue;
    if (y > pageH - 24) {
      doc.addPage();
      y = m;
    }
    doc.setFont('Roboto', 'bold');
    doc.text(`${r.rn_broj || r.node_id} — ${(r.naziv_pozicije || '').slice(0, 80)}`, m, y);
    doc.setFont('Roboto', 'normal');
    y += line;
    for (const o of ops) {
      if (y > pageH - 10) {
        doc.addPage();
        y = m;
      }
      doc.text(
        `  ${o.redosled ?? ''}. ${String(o.naziv || '').slice(0, 40)} | ${o.masina || ''} | ${o.completed_qty ?? ''}/${o.planned_qty ?? ''}`,
        m,
        y,
      );
      y += line - 1;
    }
    y += 2;
  }

  doc.save(`${buildBaseFileName(result)}.pdf`);
}

// ------------------------------------------------------------------ RN Tab1/Tab2: XLSX (PR-06)

type Rec = Record<string, unknown>;

function s(v: unknown): string {
  return v == null ? '' : String(v);
}

function rnFileName(rnBroj: unknown, tab: string): string {
  const rn = s(rnBroj || 'rn').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const date = todayYmd().replace(/-/g, '');
  return `pracenje_${rn}_${tab}_${date}.xlsx`;
}

/** Ravan popis pozicija sa nivoom (po parent_id) — 1.0 flattenPositions. */
function flattenPositions(positions: Rec[], level = 0): Array<Rec & { level: number }> {
  const nodes = new Map<string, Rec & { children: Rec[] }>();
  positions.forEach((p) => nodes.set(String(p.id), { ...p, children: [] }));
  const roots: Array<Rec & { children: Rec[] }> = [];
  nodes.forEach((n) => {
    const pid = n.parent_id != null ? String(n.parent_id) : '';
    if (pid && nodes.has(pid)) (nodes.get(pid)!.children as Rec[]).push(n);
    else roots.push(n);
  });
  const out: Array<Rec & { level: number }> = [];
  const walk = (node: Rec & { children: Rec[] }, depth: number): void => {
    out.push({ ...node, level: depth });
    (node.children as Array<Rec & { children: Rec[] }>).forEach((ch) => walk(ch, depth + 1));
  };
  roots.forEach((r) => walk(r, level));
  return out;
}

/** Tab1 „Po pozicijama": sheetovi RN + Pozicije + Operacije (1.0 exportTab1ToExcel). */
export function exportRnTab1Xlsx(payload: {
  header?: Rec;
  positions?: Rec[];
  summary?: Rec;
}): void {
  const header = payload.header ?? {};
  const positions = flattenPositions(payload.positions ?? []);
  const operations = positions.flatMap((p) =>
    ((p.operations as Rec[]) ?? []).map((op) => ({
      Pozicija: s(p.sifra_pozicije || p.id),
      NazivPozicije: s(p.naziv),
      Operacija: s(op.operacija_kod),
      NazivOperacije: s(op.naziv),
      WorkCenter: s(op.work_center),
      Planirano: op.planirano_komada ?? '',
      Prijavljeno: op.prijavljeno_komada ?? '',
      Status: s(op.status),
      PoslednjaPrijava: s(op.poslednja_prijava_at),
    })),
  );

  const rnSheet = [
    ['Kupac', s(header.kupac)],
    ['Projekat', s(header.projekat_naziv || header.projekat_id)],
    ['RN', s(header.rn_broj)],
    ['Datum isporuke', s(header.datum_isporuke)],
    ['Koordinator', s(header.koordinator)],
    ['Napomena', s(header.napomena)],
    ['Lansirana količina', payload.summary?.lansirana_kolicina ?? ''],
    ['Završena kol. (KK)', payload.summary?.zavrsena_kolicina_kk ?? ''],
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rnSheet), 'RN');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      positions.map((p) => ({
        Nivo: p.level,
        Pozicija: s(p.sifra_pozicije || p.id),
        Naziv: s(p.naziv),
        Crtez: s(p.drawing_no),
        KolicinaPlan: p.kolicina_plan ?? '',
        ProgressPct: p.progress_pct ?? '',
        ParentId: s(p.parent_id),
      })),
    ),
    'Pozicije',
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(operations.length ? operations : [{}]), 'Operacije');
  XLSX.writeFile(wb, rnFileName(header.rn_broj, 'po_pozicijama'));
}

/** Tab2 „Operativni plan": sheetovi Plan po odeljenjima + Pregled (1.0 exportTab2ToExcel). */
export function exportRnTab2Xlsx(payload: {
  header?: Rec;
  activities?: Rec[];
  dashboard?: Rec;
}): void {
  const header = payload.header ?? {};
  const activities = payload.activities ?? [];
  const dashboard = payload.dashboard ?? {};

  const planRows: (string | number)[][] = [
    ['Kupac', s(header.kupac), '', 'RN', s(header.rn_broj)],
    ['Mašina/linija', s(header.masina_linija), '', 'Datum isporuke', s(header.datum_isporuke)],
    ['Koordinator', s(header.koordinator), '', 'Napomena', s(header.napomena)],
    [],
    ['RB', 'Odeljenje', 'Aktivnost', 'Br. TP', 'Količina', 'Plan. početak', 'Plan. završetak', 'Odgovoran', 'Zavisi od', 'Status', 'Prioritet', 'Rizik', 'Rezerva', 'Kasni'],
    ...activities.map((a) => [
      (a.rb as number) ?? '',
      s(a.odeljenje || a.odeljenje_naziv),
      s(a.naziv_aktivnosti),
      s(a.broj_tp),
      s(a.kolicina_text),
      s(a.planirani_pocetak),
      s(a.planirani_zavrsetak),
      s(a.odgovoran || a.odgovoran_label),
      s(a.zavisi_od || a.zavisi_od_text),
      s(a.efektivni_status || a.status),
      s(a.prioritet),
      s(a.rizik_napomena),
      (a.rezerva_dani as number) ?? '',
      a.kasni ? 'DA' : 'NE',
    ]),
  ];
  const wsPlan = XLSX.utils.aoa_to_sheet(planRows);
  wsPlan['!cols'] = [
    { wch: 6 }, { wch: 22 }, { wch: 42 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 20 }, { wch: 26 }, { wch: 14 },
    { wch: 12 }, { wch: 32 }, { wch: 10 }, { wch: 8 },
  ];

  const pregledRows: (string | number)[][] = [
    ['Odeljenje', 'Ukupno', 'Završeno', 'U toku', 'Blokirano', 'Nije krenulo', 'Najkasniji planirani završetak'],
    ...((dashboard.po_odeljenjima as Rec[]) ?? []).map((r) => [
      s(r.odeljenje),
      (r.ukupno as number) ?? 0,
      (r.zavrseno as number) ?? 0,
      (r.u_toku as number) ?? 0,
      (r.blokirano as number) ?? 0,
      (r.nije_krenulo as number) ?? 0,
      s(r.najkasniji_planirani_zavrsetak),
    ]),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsPlan, 'Plan po odeljenjima');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pregledRows), 'Pregled');
  XLSX.writeFile(wb, rnFileName(header.rn_broj, 'operativni_plan'));
}

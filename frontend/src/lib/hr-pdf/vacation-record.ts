import { newPdf, drawLogo, safeName, MARGIN, PAGE_W, PAGE_H, CONTENT_W } from './pdf-core';
import type { PdfResult } from './hr-documents';

// „Evidencija godišnjeg odmora" po zaposlenom (A4, latinica, Roboto/UTF-8, logo).
// Port 1.0 `src/lib/vacationRecordPdf.js` na bundlovan jsPDF (pdf-core.newPdf).
// Sadržaj: zaglavlje + kartica stanja + po godini iskorišćeni/planirani/ranije
// (iz go_ledger, usklađeno sa saldom) + footer paginacija.

const BODY_BOTTOM = PAGE_H - 16;
const KIND_LABEL: Record<string, string> = { go: 'GO', slava: 'Slava', bolovanje: 'Bolovanje', praznik: 'Praznik', other: '—' };

interface LedgerPeriod { od: string; do: string; dana: number }
interface LedgerEntry { days: number | null; kind: string; dates: string; comment?: string | null; approx?: boolean }
export interface VacationLedgerBlock {
  godina: number;
  izvor: 'grid' | 'istorija';
  pravo: number | null;
  preneto: number | null;
  zaradjeno_do_danas: number | null;
  srazmerno_sticanje?: boolean | null;
  ukupno: number | null;
  iskorisceno: number;
  planirano: number;
  preostalo: number | null;
  iskorisceno_periodi: LedgerPeriod[];
  planirano_periodi: LedgerPeriod[];
  ranije_evidentirano: number;
  ranije_napomena?: string | null;
  stara_evidencija?: LedgerEntry[];
  istorija_unosi?: LedgerEntry[];
}

export interface VacationRecordInput {
  employeeName: string;
  position?: string;
  jmbg?: string;
  year: number;
  current?: VacationLedgerBlock | null;
  blocks: VacationLedgerBlock[];
  generatedDate: string; // „29.06.2026."
}

function fmtIsoDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}.` : String(iso || '');
}
function fmtPeriod(p: LedgerPeriod): string {
  if (!p.od) return '—';
  if (!p.do || p.od === p.do) return fmtIsoDay(p.od);
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.od);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.do);
  if (a && b && a[1] === b[1] && a[2] === b[2]) return `${a[3]}–${b[3]}.${b[2]}.${b[1]}.`;
  return `${fmtIsoDay(p.od)} – ${fmtIsoDay(p.do)}`;
}

interface TableCol { h: string; w: number }

export async function generateVacationRecordPdf(d: VacationRecordInput): Promise<PdfResult> {
  const { doc, logo } = await newPdf('portrait');

  let y = MARGIN;
  const ink = (r: number, g: number, b: number) => doc.setTextColor(r, g, b);
  const pageBreak = (need: number): boolean => {
    if (y + need > BODY_BOTTOM) { doc.addPage(); y = MARGIN; return true; }
    return false;
  };

  /* ── Zaglavlje ── */
  const drew = drawLogo(doc, logo, MARGIN, y, 12, 44);
  doc.setFont('Roboto', 'bold'); doc.setFontSize(11); ink(20, 20, 20);
  doc.text('SERVOTEH d.o.o.', PAGE_W - MARGIN, y + 4, { align: 'right' });
  doc.setFont('Roboto', 'normal'); doc.setFontSize(8.5); ink(110, 110, 110);
  doc.text('Ugrinovačka 163, Dobanovci', PAGE_W - MARGIN, y + 8.5, { align: 'right' });
  y += drew ? 16 : 14;
  doc.setDrawColor(190, 190, 190); doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 7;

  /* ── Naslov ── */
  doc.setFont('Roboto', 'bold'); doc.setFontSize(15); ink(20, 20, 20);
  doc.text('EVIDENCIJA GODIŠNJEG ODMORA', PAGE_W / 2, y, { align: 'center' });
  y += 7;

  /* ── Podaci o zaposlenom ── */
  doc.setFont('Roboto', 'normal'); doc.setFontSize(10.5); ink(40, 40, 40);
  doc.text('Zaposleni: ', MARGIN, y);
  doc.setFont('Roboto', 'bold');
  doc.text(String(d.employeeName || '—'), MARGIN + 22, y);
  doc.setFont('Roboto', 'normal'); ink(90, 90, 90); doc.setFontSize(9.5);
  doc.text(`Datum: ${d.generatedDate || ''}`, PAGE_W - MARGIN, y, { align: 'right' });
  y += 5;
  if (d.position) {
    ink(90, 90, 90); doc.setFontSize(9.5);
    doc.text(`Radno mesto: ${d.position}`, MARGIN, y);
    y += 5;
  }
  y += 2;

  /* ── Kartica trenutnog stanja (tekuća godina) ── */
  if (d.current) {
    const c = d.current;
    const boxH = 20;
    pageBreak(boxH + 4);
    doc.setFillColor(244, 247, 250); doc.setDrawColor(206, 216, 226);
    doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 2, 2, 'FD');
    const cellW = CONTENT_W / 4;
    const cell = (i: number, label: string, val: number | null, color: [number, number, number]) => {
      const cx = MARGIN + cellW * i + cellW / 2;
      doc.setFont('Roboto', 'normal'); doc.setFontSize(8); ink(110, 110, 110);
      doc.text(label, cx, y + 6, { align: 'center' });
      doc.setFont('Roboto', 'bold'); doc.setFontSize(15); ink(color[0], color[1], color[2]);
      doc.text(String(val == null ? '—' : val), cx, y + 15, { align: 'center' });
    };
    cell(0, `Raspoloživo ${d.year}.`, c.ukupno, [40, 90, 160]);
    cell(1, 'Iskorišćeno', c.iskorisceno, [120, 90, 40]);
    cell(2, 'Planirano', c.planirano, [37, 99, 235]);
    cell(3, 'Preostalo', c.preostalo, (Number(c.preostalo) < 0 ? [198, 83, 79] : [59, 140, 78]));
    doc.setDrawColor(220, 228, 236);
    for (let i = 1; i < 4; i++) doc.line(MARGIN + cellW * i, y + 3, MARGIN + cellW * i, y + boxH - 3);
    y += boxH + 2;
    doc.setFont('Roboto', 'normal'); doc.setFontSize(8); ink(130, 130, 130);
    doc.text(`Raspoloživo = preneto (${c.preneto ?? 0}) + ${c.srazmerno_sticanje ? 'zarađeno do danas' : 'godišnje pravo'} (${c.zaradjeno_do_danas ?? c.pravo ?? '—'}). Slobodno = Preostalo (Raspoloživo − Iskorišćeno − Planirano).`, MARGIN, y);
    y += 6;
  }

  /* ── Tabela (zajednički crtač) ── */
  const drawTable = (cols: TableCol[], rows: string[][]) => {
    const headH = 7;
    const drawHead = () => {
      doc.setFillColor(234, 238, 242); doc.setDrawColor(200, 208, 216);
      doc.rect(MARGIN, y, CONTENT_W, headH, 'FD');
      doc.setFont('Roboto', 'bold'); doc.setFontSize(8.5); ink(50, 50, 50);
      let cx = MARGIN;
      for (const c of cols) { doc.text(c.h, cx + 1.6, y + 4.7); cx += c.w; }
      y += headH;
    };
    pageBreak(headH + 8); drawHead();
    doc.setFont('Roboto', 'normal'); doc.setFontSize(8.5); ink(30, 30, 30);
    for (const r of rows) {
      const wrapped = cols.map((c, i) => doc.splitTextToSize(String(r[i] == null ? '' : r[i]), c.w - 3) as string[]);
      const rowH = Math.max(5.6, ...wrapped.map((w) => w.length * 4.2 + 2.4));
      if (pageBreak(rowH)) drawHead();
      doc.setDrawColor(224, 228, 232);
      doc.rect(MARGIN, y, CONTENT_W, rowH);
      let cx = MARGIN;
      for (let i = 0; i < cols.length; i++) {
        if (i > 0) doc.line(cx, y, cx, y + rowH);
        doc.text(wrapped[i], cx + 1.6, y + 4, { lineHeightFactor: 1.15 });
        cx += cols[i].w;
      }
      y += rowH;
    }
    y += 4;
  };

  /* ── Po godinama (go_ledger): iskorišćeni + planirani + ranije ── */
  const COLS: TableCol[] = [{ h: 'Dana', w: 16 }, { h: 'Tip', w: 26 }, { h: 'Datumi', w: 74 }, { h: 'Napomena', w: CONTENT_W - 16 - 26 - 74 }];
  const blocks = (d.blocks || []).slice().sort((a, b) => (b.godina || 0) - (a.godina || 0));
  if (!blocks.length) {
    pageBreak(8); doc.setFont('Roboto', 'normal'); doc.setFontSize(9.5); ink(120, 120, 120);
    doc.text('Nema podataka o godišnjem odmoru za ovog zaposlenog.', MARGIN, y); y += 6;
  }
  const sectionLabel = (txt: string, color: [number, number, number]) => {
    pageBreak(8); doc.setFont('Roboto', 'bold'); doc.setFontSize(9); ink(color[0], color[1], color[2]);
    doc.text(txt, MARGIN, y + 3); y += 5.5;
  };
  for (const b of blocks) {
    const isHist = b.izvor === 'istorija';
    pageBreak(16);
    doc.setFont('Roboto', 'bold'); doc.setFontSize(11); ink(20, 20, 20);
    doc.text(`Godina ${b.godina}.`, MARGIN, y);
    const sum = [
      b.ukupno != null ? `raspoloživo ${b.ukupno}` : null,
      `iskorišćeno ${b.iskorisceno}`,
      b.planirano > 0 ? `planirano ${b.planirano}` : null,
      b.preostalo != null ? `preostalo ${b.preostalo}` : null,
    ].filter(Boolean).join('   ·   ');
    doc.setFont('Roboto', 'normal'); doc.setFontSize(9); ink(90, 90, 90);
    doc.text(sum, PAGE_W - MARGIN, y, { align: 'right' });
    y += 5;

    const usedRows: string[][] = [];
    if (isHist) {
      const entries = b.istorija_unosi ?? b.stara_evidencija ?? [];
      for (const e of entries) usedRows.push([e.days == null ? '' : String(e.days), KIND_LABEL[e.kind] || e.kind || '—', e.dates || '', e.comment || '']);
      const goSum = entries.filter((e) => e.kind === 'go' && typeof e.days === 'number').reduce((s, e) => s + (e.days as number), 0);
      const residue = (b.iskorisceno || 0) - goSum;
      if (residue > 0) usedRows.push([String(residue), 'ranije', 'bez preciznog datuma (iz stare evidencije)', '']);
    } else {
      for (const p of (b.iskorisceno_periodi ?? [])) usedRows.push([String(p.dana), 'GO', fmtPeriod(p), '']);
      if (b.ranije_evidentirano > 0) usedRows.push([String(b.ranije_evidentirano), 'bez dat.', 'bez preciznog datuma (ranija evidencija)', '']);
    }
    sectionLabel(isHist ? 'Iskorišćeni dani (ranija evidencija)' : 'Iskorišćeni dani', [60, 60, 60]);
    drawTable(COLS, usedRows.length ? usedRows : [['', '', '— nema —', '']]);

    if (!isHist && (b.planirano_periodi ?? []).length) {
      sectionLabel('Planirani (odobreni) dani', [37, 99, 235]);
      drawTable(COLS, b.planirano_periodi.map((p) => [String(p.dana), 'planirano', fmtPeriod(p), '']));
    }
  }

  /* ── Footer ── */
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('Roboto', 'normal'); doc.setFontSize(8); ink(140, 140, 140);
    doc.text(`Evidencija godišnjeg odmora — ${d.employeeName || ''}`, MARGIN, PAGE_H - 8);
    doc.text(`${i} / ${total}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
  }

  const blob = doc.output('blob');
  return { blob, fileName: `Evidencija_GO_${safeName(d.employeeName)}.pdf` };
}

import { newPdf, drawLogo, safeName, MARGIN, PAGE_W, PAGE_H, CONTENT_W } from './pdf-core';
import type { PdfResult } from './hr-documents';
import type { RegroupedYear } from '@/lib/vacation-regroup';

// „Evidencija godišnjeg odmora" po zaposlenom (A4, latinica, Roboto/UTF-8, logo).
// Port 1.0 `src/lib/vacationRecordPdf.js` na bundlovan jsPDF (pdf-core.newPdf).
// Sadržaj: zaglavlje + saldo kartica + upisani GO dani grida + tabela po
// istorijskoj godini + izvor + footer paginacija.

const BODY_BOTTOM = PAGE_H - 16;
const KIND_LABEL: Record<string, string> = { go: 'GO', slava: 'Slava', bolovanje: 'Bolovanje', praznik: 'Praznik', other: '—' };

export interface VacationRecordSaldo {
  ukupno: number;
  iskorisceno: number;
  preostalo: number;
  preneto: number;
  zaradjeno: number;
}

export interface VacationRecordInput {
  employeeName: string;
  position?: string;
  jmbg?: string;
  year: number;
  saldo?: VacationRecordSaldo | null;
  history: RegroupedYear[];
  /** YYYY-MM-DD GO ćelije tekuće godine (upisane u sistem/grid). */
  gridDays?: string[];
  generatedDate: string; // „29.06.2026."
}

function fmtYmd(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? `${m[3]}.${m[2]}.` : String(ymd || '');
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

  /* ── Kartica trenutnog stanja ── */
  if (d.saldo) {
    const boxH = 20;
    pageBreak(boxH + 4);
    doc.setFillColor(244, 247, 250); doc.setDrawColor(206, 216, 226);
    doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 2, 2, 'FD');
    const cellW = CONTENT_W / 3;
    const cell = (i: number, label: string, val: number, color: [number, number, number]) => {
      const cx = MARGIN + cellW * i + cellW / 2;
      doc.setFont('Roboto', 'normal'); doc.setFontSize(8.5); ink(110, 110, 110);
      doc.text(label, cx, y + 6, { align: 'center' });
      doc.setFont('Roboto', 'bold'); doc.setFontSize(16); ink(color[0], color[1], color[2]);
      doc.text(String(val), cx, y + 15, { align: 'center' });
    };
    const s = d.saldo;
    cell(0, `Ukupno (do danas) ${d.year}.`, s.ukupno, [40, 90, 160]);
    cell(1, 'Iskorišćeno', s.iskorisceno, [120, 90, 40]);
    cell(2, 'Preostalo', s.preostalo, (Number(s.preostalo) < 0 ? [198, 83, 79] : [59, 140, 78]));
    doc.setDrawColor(220, 228, 236);
    doc.line(MARGIN + cellW, y + 3, MARGIN + cellW, y + boxH - 3);
    doc.line(MARGIN + cellW * 2, y + 3, MARGIN + cellW * 2, y + boxH - 3);
    y += boxH + 2;
    doc.setFont('Roboto', 'normal'); doc.setFontSize(8); ink(130, 130, 130);
    doc.text(`Ukupno = preneto (${s.preneto}) + zarađeno do danas (${s.zaradjeno}). Preostalo = Ukupno − Iskorišćeno − planirano.`, MARGIN, y);
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

  /* ── Tekuća godina: upisani GO dani u sistemu (grid) ── */
  if (Array.isArray(d.gridDays) && d.gridDays.length) {
    pageBreak(12);
    doc.setFont('Roboto', 'bold'); doc.setFontSize(10.5); ink(20, 20, 20);
    doc.text(`Korišćeni dani ${d.year}. (upisano u sistemu)`, MARGIN, y); y += 5;
    doc.setFont('Roboto', 'normal'); doc.setFontSize(9); ink(50, 50, 50);
    const sorted = [...d.gridDays].sort();
    const line = `${sorted.length} dana: ` + sorted.map(fmtYmd).join(', ');
    const lines = doc.splitTextToSize(line, CONTENT_W) as string[];
    for (const ln of lines) { pageBreak(5); doc.text(ln, MARGIN, y); y += 4.6; }
    y += 4;
  }

  /* ── Po godinama iz istorije ── */
  const hist = (d.history || []).slice().sort((a, b) => (b.year || 0) - (a.year || 0));
  if (!hist.length) {
    pageBreak(8); doc.setFont('Roboto', 'normal'); doc.setFontSize(9.5); ink(120, 120, 120);
    doc.text('Nema istorijskih GO podataka (vacation_history) za ovog zaposlenog.', MARGIN, y); y += 6;
  }
  for (const r of hist) {
    pageBreak(16);
    doc.setFont('Roboto', 'bold'); doc.setFontSize(11); ink(20, 20, 20);
    doc.text(`Godina ${r.year}.`, MARGIN, y);
    const sum = [
      r.entitled != null ? `pravo ${r.entitled}` : null,
      r.used != null ? `iskorišćeno ${r.used}` : null,
      r.remaining != null ? `preostalo ${r.remaining}` : null,
    ].filter(Boolean).join('   ·   ');
    if (sum) { doc.setFont('Roboto', 'normal'); doc.setFontSize(9); ink(90, 90, 90); doc.text(sum, PAGE_W - MARGIN, y, { align: 'right' }); }
    y += 4;
    const entries = Array.isArray(r.entries) ? r.entries : [];
    if (!entries.length) {
      doc.setFont('Roboto', 'normal'); doc.setFontSize(8.5); ink(140, 140, 140);
      doc.text('— nema pojedinačnih unosa —', MARGIN, y + 3); y += 8;
      continue;
    }
    drawTable(
      [{ h: 'Dana', w: 16 }, { h: 'Tip', w: 24 }, { h: 'Datumi', w: 76 }, { h: 'Napomena', w: CONTENT_W - 16 - 24 - 76 }],
      entries.map((e) => [
        e.days == null ? '' : String(e.days),
        KIND_LABEL[e.kind] || e.kind || '—',
        e.dates || '',
        e.comment || '',
      ]),
    );
  }

  const src = hist.find((r) => r.sourceFile)?.sourceFile;
  if (src) { pageBreak(6); doc.setFont('Roboto', 'normal'); doc.setFontSize(7.5); ink(150, 150, 150); doc.text(`Izvor istorije: ${src} (ručna evidencija).`, MARGIN, y); y += 4; }

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

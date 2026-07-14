import { newPdf, drawLogo, safeName, PAGE_W, PAGE_H, MARGIN, CONTENT_W } from './pdf-core';
import type { JobPosition } from '@/api/kadrovska';

// PDF „Opis radnog mesta" (job_positions) — A4 portret, Roboto/UTF-8 (srpska
// latinica), selektabilan tekst. Port 1.0 `src/lib/jobPositionPdf.js`: 8 sekcija
// sistematizacije + „Linijski odgovara" box + laki markdown render + logo header/
// footer sa paginacijom. Bez ćirilizacije (opisi su latinica u bazi).

const HEADER_H = 14;
const FOOTER_H = 10;
const LINE_H = 5.4;
const BODY_TOP = MARGIN + HEADER_H + 4;
const BODY_BOTTOM = PAGE_H - MARGIN - FOOTER_H;

/** 8 sekcija opisa pozicije (redosled = „Moj profil"). */
const SECTIONS: [keyof JobPosition, string][] = [
  ['summaryMd', 'Svrha radnog mesta'],
  ['responsibilitiesMd', 'Ključne odgovornosti'],
  ['authorityMd', 'Ovlašćenja'],
  ['dutiesMd', 'Odgovornost (accountability)'],
  ['kpiMd', 'KPI / merila uspeha'],
  ['qualificationsMd', 'Kvalifikacije i iskustvo'],
  ['collaborationMd', 'Ključna saradnja'],
  ['expectationsMd', 'Očekivanja'],
];

function hasText(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

type Block = { kind: 'h' | 'li' | 'p' | 'gap'; text?: string };

/** Lagani markdown u blokove: skida bold/code markere, hvata # naslove i - liste. */
function mdToBlocks(md: string): Block[] {
  const out: Block[] = [];
  for (const raw of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) { out.push({ kind: 'gap' }); continue; }
    const h = trimmed.match(/^#{1,4}\s+(.*)$/);
    if (h) { out.push({ kind: 'h', text: h[1].trim() }); continue; }
    const li = trimmed.match(/^[-*•]\s+(.*)$/);
    if (li) { out.push({ kind: 'li', text: li[1].trim() }); continue; }
    const ol = trimmed.match(/^(\d+[.)])\s+(.*)$/);
    if (ol) { out.push({ kind: 'li', text: `${ol[1]} ${ol[2].trim()}` }); continue; }
    out.push({ kind: 'p', text: trimmed });
  }
  return out;
}

export interface JobPositionEmployee {
  fullName?: string;
  department?: string;
}

export async function generateJobPositionPdf(
  position: Partial<JobPosition>,
  employee?: JobPositionEmployee | null,
): Promise<{ blob: Blob; fileName: string }> {
  const p = position || {};
  const title = String(p.name || employee?.department || 'Opis radnog mesta').trim();

  const { doc, logo } = await newPdf('portrait');

  const drawHeaderFooter = (pageNum: number, totalPages: number | string) => {
    if (!drawLogo(doc, logo, MARGIN, MARGIN - 3, 9, 46)) {
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(37, 99, 235);
      doc.text('SERVOTEH d.o.o.', MARGIN, MARGIN + 5);
    }
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(80, 80, 80);
    doc.text('OPIS RADNOG MESTA', PAGE_W / 2, MARGIN + 5, { align: 'center' });
    doc.text(`${pageNum} / ${totalPages}`, PAGE_W - MARGIN, MARGIN + 5, { align: 'right' });
    doc.setDrawColor(229, 231, 235);
    doc.line(MARGIN, MARGIN + 8, PAGE_W - MARGIN, MARGIN + 8);
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text(title.slice(0, 90), MARGIN, PAGE_H - MARGIN + 4);
    doc.setTextColor(0, 0, 0);
  };

  drawHeaderFooter(1, '?');
  let y = BODY_TOP;

  const pageBreak = (need: number) => {
    if (y + need > BODY_BOTTOM) { doc.addPage(); drawHeaderFooter(doc.getNumberOfPages(), '?'); y = BODY_TOP; }
  };

  // Naslov pozicije
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(17, 24, 39);
  const titleLines = doc.splitTextToSize(title, CONTENT_W) as string[];
  doc.text(titleLines, MARGIN, y);
  y += titleLines.length * 7 + 2;

  if (employee && employee.fullName) {
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(107, 114, 128);
    const who = [employee.fullName, employee.department].filter(Boolean).join(' · ');
    if (who) { doc.text(who, MARGIN, y); y += LINE_H; }
  }

  // „Linijski odgovara" box
  if (hasText(p.reportsToLine)) {
    y += 1;
    doc.setFillColor(243, 245, 250);
    const rl = doc.splitTextToSize(`Linijski odgovara:  ${p.reportsToLine.trim()}`, CONTENT_W - 6) as string[];
    const boxH = rl.length * LINE_H + 4;
    doc.rect(MARGIN, y - 4, CONTENT_W, boxH, 'F');
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(37, 99, 235);
    doc.text(rl, MARGIN + 3, y);
    y += boxH;
    doc.setTextColor(0, 0, 0);
  }
  y += 4;

  let printedAny = false;
  for (const [field, secTitle] of SECTIONS) {
    const val = p[field];
    if (!hasText(val)) continue;
    printedAny = true;

    pageBreak(14);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(17, 24, 39);
    doc.text(secTitle, MARGIN, y);
    doc.setDrawColor(37, 99, 235);
    doc.line(MARGIN, y + 1.5, PAGE_W - MARGIN, y + 1.5);
    y += LINE_H + 2;
    doc.setTextColor(0, 0, 0);

    for (const b of mdToBlocks(val)) {
      if (b.kind === 'gap') { y += LINE_H * 0.5; continue; }
      const isH = b.kind === 'h';
      const isLi = b.kind === 'li';
      doc.setFont('Roboto', isH ? 'bold' : 'normal');
      doc.setFontSize(isH ? 10.5 : 9.5);
      doc.setTextColor(31, 41, 55);
      const indent = isLi ? 5 : 0;
      const wrapped = doc.splitTextToSize(b.text || '', CONTENT_W - indent - (isLi ? 3 : 0)) as string[];
      wrapped.forEach((line, i) => {
        pageBreak(LINE_H + 1);
        if (isLi && i === 0) {
          doc.text('•', MARGIN + 1, y);
          doc.text(line, MARGIN + indent + 3, y);
        } else {
          doc.text(line, MARGIN + indent + (isLi ? 3 : 0), y);
        }
        y += LINE_H;
      });
    }
    y += 3;
  }

  if (!printedAny && !hasText(p.reportsToLine)) {
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(107, 114, 128);
    doc.text('Opis ove pozicije još nije unet u sistematizaciju.', MARGIN, y);
  }

  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    drawHeaderFooter(i, totalPages);
  }

  return { blob: doc.output('blob'), fileName: `Opis_pozicije_${safeName(title, 'pozicija')}.pdf` };
}

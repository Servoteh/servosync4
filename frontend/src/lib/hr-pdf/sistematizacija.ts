import { newPdf, drawLogo, PAGE_W, PAGE_H, MARGIN, CONTENT_W } from './pdf-core';
import {
  POSITION_SECTIONS,
  buildOrgTree,
  hasText,
  mdToBlocks,
  positionHasContent,
} from './position-sections';
import type { JobPosition, OrgStructure } from '@/api/kadrovska';

// PDF „Sistematizacija radnih mesta" — CELA org struktura (odeljenje → pododeljenje →
// radno mesto sa 8 opisnih sekcija). A4 portret, Roboto/UTF-8 (srpska latinica),
// selektabilan tekst. Isti obrazac kao `job-position.ts` (opis JEDNE pozicije), samo
// prošireno naslovnom stranom, sadržajem i hijerarhijom naslova. Bez ćirilizacije —
// opisi su latinica u bazi i prenose se doslovno.

const HEADER_H = 14;
const FOOTER_H = 10;
const LINE_H = 5.4;
const BODY_TOP = MARGIN + HEADER_H + 4;
const BODY_BOTTOM = PAGE_H - MARGIN - FOOTER_H;

const DOC_TITLE = 'SISTEMATIZACIJA RADNIH MESTA';

/** dd.MM.yyyy. (lokalno — generator ne zavisi od UI format helpera). */
function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** „3 radna mesta" / „1 radno mesto" — srpska množina za mali skup. */
function pluralMesta(n: number): string {
  const d1 = n % 10;
  const d2 = n % 100;
  if (d1 === 1 && d2 !== 11) return `${n} radno mesto`;
  if (d1 >= 2 && d1 <= 4 && (d2 < 12 || d2 > 14)) return `${n} radna mesta`;
  return `${n} radnih mesta`;
}

export interface SistematizacijaOptions {
  /** Datum generisanja (dd.MM.yyyy.); podrazumevano danas. */
  generatedDate?: string;
}

export async function generateSistematizacijaPdf(
  org: OrgStructure,
  opts: SistematizacijaOptions = {},
): Promise<{ blob: Blob; fileName: string }> {
  const tree = buildOrgTree(org);
  const datum = opts.generatedDate || today();

  const { doc, logo } = await newPdf('portrait');

  const drawHeaderFooter = (pageNum: number, totalPages: number | string) => {
    if (pageNum > 1) {
      if (!drawLogo(doc, logo, MARGIN, MARGIN - 3, 9, 46)) {
        doc.setFont('Roboto', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(37, 99, 235);
        doc.text('SERVOTEH d.o.o.', MARGIN, MARGIN + 5);
      }
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(80, 80, 80);
      doc.text(DOC_TITLE, PAGE_W / 2, MARGIN + 5, { align: 'center' });
      doc.text(`${pageNum} / ${totalPages}`, PAGE_W - MARGIN, MARGIN + 5, { align: 'right' });
      doc.setDrawColor(229, 231, 235);
      doc.line(MARGIN, MARGIN + 8, PAGE_W - MARGIN, MARGIN + 8);
    }
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text(`SERVOTEH d.o.o. — sistematizacija radnih mesta · ${datum}`, MARGIN, PAGE_H - MARGIN + 4);
    if (pageNum === 1) {
      doc.text(`${pageNum} / ${totalPages}`, PAGE_W - MARGIN, PAGE_H - MARGIN + 4, { align: 'right' });
    }
    doc.setTextColor(0, 0, 0);
  };

  // Zaglavlja/podnožja se crtaju TEK u završnom prolazu (kad se zna ukupan broj
  // strana) — crtanje sa „?" pa preko toga sa brojem ostavlja preklopljen tekst.
  let y = MARGIN;
  const pageBreak = (need: number) => {
    if (y + need > BODY_BOTTOM) { doc.addPage(); y = BODY_TOP; }
  };
  const newPage = () => {
    doc.addPage();
    y = BODY_TOP;
  };

  /* ── Naslovna strana ───────────────────────────────────────────────────── */
  const drew = drawLogo(doc, logo, MARGIN, y, 14, 52);
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(20, 20, 20);
  doc.text('SERVOTEH d.o.o.', PAGE_W - MARGIN, y + 5, { align: 'right' });
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(110, 110, 110);
  doc.text('Ugrinovačka 163, Dobanovci', PAGE_W - MARGIN, y + 10, { align: 'right' });
  y += drew ? 20 : 18;
  doc.setDrawColor(190, 190, 190);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);

  y += 46;
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(24);
  doc.setTextColor(17, 24, 39);
  const titleLines = doc.splitTextToSize('Sistematizacija radnih mesta', CONTENT_W) as string[];
  doc.text(titleLines, PAGE_W / 2, y, { align: 'center' });
  y += titleLines.length * 10;

  doc.setFont('Roboto', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(107, 114, 128);
  doc.text('Opisi radnih mesta po organizacionoj strukturi', PAGE_W / 2, y + 2, { align: 'center' });
  y += 12;
  doc.setDrawColor(37, 99, 235);
  doc.setLineWidth(0.8);
  doc.line(PAGE_W / 2 - 22, y, PAGE_W / 2 + 22, y);
  doc.setLineWidth(0.2);

  y += 16;
  doc.setFontSize(10);
  doc.setTextColor(55, 65, 81);
  const meta = [
    `Datum generisanja: ${datum}`,
    `Ukupno: ${pluralMesta(tree.positionCount)} u ${tree.depts.length} org. celina`,
    `Sa unetim opisom: ${tree.describedCount} od ${tree.positionCount}`,
  ];
  for (const line of meta) {
    doc.text(line, PAGE_W / 2, y, { align: 'center' });
    y += 6;
  }

  /* ── Sadržaj (bez brojeva strana — dokument se generiše u jednom prolazu) ─ */
  if (tree.depts.length) {
    y += 14;
    pageBreak(20);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(17, 24, 39);
    doc.text('Sadržaj', MARGIN, y);
    y += LINE_H + 1;
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(55, 65, 81);
    tree.depts.forEach((d, i) => {
      pageBreak(LINE_H + 1);
      const label = `${i + 1}. ${d.department.name}`;
      const count = `${d.positionCount}`;
      doc.text(doc.splitTextToSize(label, CONTENT_W - 14)[0] as string, MARGIN, y);
      doc.text(count, PAGE_W - MARGIN, y, { align: 'right' });
      y += LINE_H;
    });
  }

  /* ── Sadržaj dokumenta: odeljenje → pododeljenje → radno mesto ─────────── */
  tree.depts.forEach((d, di) => {
    newPage();

    // Odeljenje — puna traka
    doc.setFillColor(17, 24, 39);
    doc.rect(MARGIN, y - 5.5, CONTENT_W, 11, 'F');
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(255, 255, 255);
    doc.text(`${di + 1}. ${d.department.name}`, MARGIN + 3, y + 1.5);
    doc.setFontSize(9);
    doc.text(pluralMesta(d.positionCount), PAGE_W - MARGIN - 3, y + 1.5, { align: 'right' });
    doc.setTextColor(0, 0, 0);
    y += 12;

    d.subs.forEach((sub) => {
      if (sub.subDepartment) {
        pageBreak(16);
        y += 3;
        doc.setFont('Roboto', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(55, 65, 81);
        doc.text(sub.subDepartment.name, MARGIN, y);
        doc.setDrawColor(209, 213, 219);
        doc.line(MARGIN, y + 1.5, PAGE_W - MARGIN, y + 1.5);
        y += LINE_H + 2;
        doc.setTextColor(0, 0, 0);
      }

      sub.positions.forEach((p) => {
        drawPosition(p);
      });
    });
  });

  function drawPosition(p: JobPosition) {
    pageBreak(24);
    y += 3;

    // Naziv radnog mesta
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(17, 24, 39);
    const nameLines = doc.splitTextToSize(String(p.name || '—').trim(), CONTENT_W) as string[];
    doc.text(nameLines, MARGIN, y);
    y += nameLines.length * 6;
    doc.setDrawColor(37, 99, 235);
    doc.line(MARGIN, y - 3.5, PAGE_W - MARGIN, y - 3.5);
    doc.setTextColor(0, 0, 0);

    // „Linijski odgovara" box
    if (hasText(p.reportsToLine)) {
      pageBreak(12);
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
    y += 2;

    if (!positionHasContent(p)) {
      pageBreak(LINE_H + 2);
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(107, 114, 128);
      doc.text('Opis ovog radnog mesta još nije unet u sistematizaciju.', MARGIN, y);
      doc.setTextColor(0, 0, 0);
      y += LINE_H + 2;
      return;
    }

    for (const [field, secTitle] of POSITION_SECTIONS) {
      const val = p[field];
      if (!hasText(val)) continue;

      pageBreak(12);
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(37, 99, 235);
      doc.text(secTitle, MARGIN, y);
      y += LINE_H;
      doc.setTextColor(0, 0, 0);

      for (const b of mdToBlocks(val)) {
        if (b.kind === 'gap') { y += LINE_H * 0.5; continue; }
        const isH = b.kind === 'h';
        const isLi = b.kind === 'li';
        doc.setFont('Roboto', isH ? 'bold' : 'normal');
        doc.setFontSize(isH ? 10 : 9.5);
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
      y += 2;
    }
    y += 2;
  }

  if (!tree.depts.length) {
    newPage();
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(107, 114, 128);
    doc.text('Organizaciona struktura još nije uneta.', MARGIN, y);
  }

  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    drawHeaderFooter(i, totalPages);
  }

  return {
    blob: doc.output('blob'),
    fileName: `Sistematizacija_radnih_mesta_${fileStamp()}.pdf`,
  };
}

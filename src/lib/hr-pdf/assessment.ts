import type { jsPDF } from 'jspdf';
import { newPdf, drawLogo, safeName } from './pdf-core';
import { downloadBlob, openBlob } from './badges';

// jsPDF generator za 360° procenu kompetencija (port 1.0 src/lib/assessmentPdf.js).
// A4 portrait, Roboto (ćirilica/latinica UTF-8), Servoteh logo, selektabilan tekst.
// Zavisi od GET assessments/:id/results (self/peer/leader/target po grupi i kompetenciji).

export interface AssessmentPdfGroup {
  groupName: string;
  scope?: string;
  self: number | null;
  peer: number | null;
  leader: number | null;
  target: number | null;
}
export interface AssessmentPdfComp {
  groupName: string;
  competenceName: string;
  self: number | null;
  peer: number | null;
  leader: number | null;
  target: number | null;
}
export interface AssessmentPdfInput {
  employeeName: string;
  positionName?: string;
  period?: string;
  groups: AssessmentPdfGroup[];
  competences: AssessmentPdfComp[];
  answers?: { question: string; answers: string[] }[];
}

type RGB = [number, number, number];
const MARGIN = 18;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const HEADER_H = 14;
const FOOTER_H = 10;
const LINE_H = 5.2;
const BODY_TOP = MARGIN + HEADER_H + 4;
const BODY_BOTTOM = PAGE_H - MARGIN - FOOTER_H;

const COLORS: Record<string, RGB> = {
  self: [37, 99, 235],
  peer: [22, 163, 74],
  leader: [202, 138, 4],
  target: [147, 51, 234],
  ink: [17, 24, 39],
  sub: [107, 114, 128],
  rule: [229, 231, 235],
  zebra: [247, 248, 250],
  headFill: [243, 245, 250],
};

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1) : '—';
}
function nowStamp(): string {
  try {
    return new Date().toLocaleString('sr-RS', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date().toISOString().slice(0, 16).replace('T', ' ');
  }
}

interface Col {
  key: string;
  label: string;
  w: number;
  align: 'left' | 'center';
  color?: RGB;
}

export async function exportAssessmentPdf(data: AssessmentPdfInput): Promise<void> {
  const employeeName = (data.employeeName || '').trim();
  const positionName = (data.positionName || '').trim();
  const period = (data.period || '').trim();
  const groups = data.groups ?? [];
  const competences = data.competences ?? [];
  const answers = (data.answers ?? []).filter((a) => a && (a.question?.trim() || a.answers?.some((x) => x?.trim())));

  const { doc, logo } = await newPdf('portrait');
  const stamp = nowStamp();
  const whoFooter = [employeeName, positionName].filter(Boolean).join(' · ');
  const st = { y: BODY_TOP };

  const header = () => {
    const drew = drawLogo(doc, logo, MARGIN, MARGIN - 3, 9, 44);
    if (!drew) {
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(37, 99, 235);
      doc.text('SERVOTEH d.o.o.', MARGIN, MARGIN + 5);
    }
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(80, 80, 80);
    doc.text('360° PROCENA KOMPETENCIJA', PAGE_W / 2, MARGIN + 5, { align: 'center' });
    doc.setDrawColor(...COLORS.rule);
    doc.line(MARGIN, MARGIN + 8, PAGE_W - MARGIN, MARGIN + 8);
    doc.setTextColor(0, 0, 0);
  };
  header();

  const pageBreak = (need: number) => {
    if (st.y + need > BODY_BOTTOM) {
      doc.addPage();
      header();
      st.y = BODY_TOP;
    }
  };

  const sectionTitle = (text: string) => {
    pageBreak(20);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(12.5);
    doc.setTextColor(...COLORS.ink);
    doc.text(text, MARGIN, st.y);
    doc.setDrawColor(37, 99, 235);
    doc.line(MARGIN, st.y + 1.5, PAGE_W - MARGIN, st.y + 1.5);
    st.y += LINE_H + 2.5;
    doc.setTextColor(0, 0, 0);
  };

  const drawTable = (cols: Col[], rows: Record<string, string>[]) => {
    const rowPadX = 2;
    const lineH = 4.6;
    const headH = 7;
    const drawHead = () => {
      doc.setFillColor(...COLORS.headFill);
      doc.rect(MARGIN, st.y, CONTENT_W, headH, 'F');
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(8.6);
      let x = MARGIN;
      for (const c of cols) {
        doc.setTextColor(...(c.color ?? COLORS.ink));
        const tx = c.align === 'center' ? x + c.w / 2 : x + rowPadX;
        doc.text(String(c.label), tx, st.y + headH - 2.2, { align: c.align === 'center' ? 'center' : 'left' });
        x += c.w;
      }
      doc.setDrawColor(...COLORS.rule);
      doc.line(MARGIN, st.y + headH, PAGE_W - MARGIN, st.y + headH);
      doc.setTextColor(0, 0, 0);
      st.y += headH;
    };
    if (st.y + headH + lineH + 2 > BODY_BOTTOM) pageBreak(headH + lineH + 2);
    drawHead();
    let zebra = false;
    for (const row of rows) {
      const first = cols[0];
      const cellLines = doc.splitTextToSize(String(row[first.key] ?? ''), first.w - rowPadX * 2) as string[];
      const rowH = Math.max(lineH + 1.6, cellLines.length * lineH + 1.6);
      if (st.y + rowH > BODY_BOTTOM) {
        pageBreak(rowH);
        drawHead();
        zebra = false;
      }
      if (zebra) {
        doc.setFillColor(...COLORS.zebra);
        doc.rect(MARGIN, st.y, CONTENT_W, rowH, 'F');
      }
      zebra = !zebra;
      let x = MARGIN;
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(8.8);
      for (const c of cols) {
        doc.setTextColor(...(c.align === 'center' ? COLORS.ink : ([31, 41, 55] as RGB)));
        const val = String(row[c.key] ?? '');
        if (c === first) {
          cellLines.forEach((line, i) => doc.text(line, x + rowPadX, st.y + lineH + i * lineH - 0.6));
        } else {
          doc.text(val, x + c.w / 2, st.y + lineH - 0.6, { align: 'center' });
        }
        x += c.w;
      }
      doc.setDrawColor(...COLORS.rule);
      doc.line(MARGIN, st.y + rowH, PAGE_W - MARGIN, st.y + rowH);
      st.y += rowH;
    }
    doc.setTextColor(0, 0, 0);
  };

  const drawLegend = () => {
    const items: { label: string; color: RGB; dashed: boolean }[] = [
      { label: 'Samoprocena', color: COLORS.self, dashed: false },
      { label: 'Kolege', color: COLORS.peer, dashed: false },
      { label: 'Rukovodilac', color: COLORS.leader, dashed: false },
      { label: 'Cilj', color: COLORS.target, dashed: true },
    ];
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8.5);
    let x = MARGIN;
    const sw = 4;
    for (const it of items) {
      if (it.dashed) {
        doc.setDrawColor(...it.color);
        doc.setLineWidth(0.7);
        try { doc.setLineDashPattern([1.2, 1], 0); } catch { /* stariji jsPDF */ }
        doc.line(x, st.y - 1.4, x + sw, st.y - 1.4);
        try { doc.setLineDashPattern([], 0); } catch { /* ignore */ }
        doc.setLineWidth(0.2);
      } else {
        doc.setFillColor(...it.color);
        doc.rect(x, st.y - 3, sw, sw, 'F');
      }
      doc.setTextColor(60, 60, 60);
      doc.text(it.label, x + sw + 1.6, st.y);
      x += sw + 2 + doc.getTextWidth(it.label) + 6;
    }
    doc.setTextColor(0, 0, 0);
  };

  // Naslov + meta
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(...COLORS.ink);
  doc.text('360° procena kompetencija', MARGIN, st.y);
  st.y += 8;
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(55, 65, 81);
  if (employeeName) { doc.text(`Zaposleni: ${employeeName}`, MARGIN, st.y); st.y += LINE_H + 0.4; }
  if (positionName) { doc.text(`Radno mesto: ${positionName}`, MARGIN, st.y); st.y += LINE_H + 0.4; }
  if (period) { doc.text(`Period: ${period}`, MARGIN, st.y); st.y += LINE_H + 0.4; }
  st.y += 2;
  drawLegend();
  st.y += 8;

  if (groups.length) {
    sectionTitle('Pregled po grupama kompetencija');
    st.y += 1;
    const cols: Col[] = [
      { key: 'groupName', label: 'Grupa', w: CONTENT_W - 4 * 24, align: 'left' },
      { key: 'self', label: 'Samopr.', w: 24, align: 'center', color: COLORS.self },
      { key: 'peer', label: 'Kolege', w: 24, align: 'center', color: COLORS.peer },
      { key: 'leader', label: 'Rukov.', w: 24, align: 'center', color: COLORS.leader },
      { key: 'target', label: 'Cilj', w: 24, align: 'center', color: COLORS.target },
    ];
    drawTable(cols, groups.map((g) => ({ groupName: g.groupName || '', self: fmt(g.self), peer: fmt(g.peer), leader: fmt(g.leader), target: fmt(g.target) })));
    st.y += 4;
  }

  if (competences.length) {
    sectionTitle('Detaljan prikaz po kompetencijama');
    st.y += 1;
    const cols: Col[] = [
      { key: 'competenceName', label: 'Kompetencija', w: CONTENT_W - 4 * 22, align: 'left' },
      { key: 'self', label: 'Samopr.', w: 22, align: 'center', color: COLORS.self },
      { key: 'peer', label: 'Kolege', w: 22, align: 'center', color: COLORS.peer },
      { key: 'leader', label: 'Rukov.', w: 22, align: 'center', color: COLORS.leader },
      { key: 'target', label: 'Cilj', w: 22, align: 'center', color: COLORS.target },
    ];
    const order: string[] = [];
    const byGroup = new Map<string, Record<string, string>[]>();
    for (const c of competences) {
      const gn = c.groupName || 'Ostalo';
      if (!byGroup.has(gn)) { byGroup.set(gn, []); order.push(gn); }
      byGroup.get(gn)!.push({ competenceName: c.competenceName || '', self: fmt(c.self), peer: fmt(c.peer), leader: fmt(c.leader), target: fmt(c.target) });
    }
    for (const gn of order) {
      pageBreak(LINE_H + 8);
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(...COLORS.ink);
      doc.text(gn, MARGIN, st.y);
      st.y += LINE_H + 0.5;
      drawTable(cols, byGroup.get(gn)!);
      st.y += 3;
    }
  }

  if (answers.length) {
    sectionTitle('Otvorena pitanja');
    st.y += 2;
    for (const a of answers) {
      const list = (a.answers ?? []).filter((x) => x?.trim());
      pageBreak(LINE_H + 4);
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...COLORS.ink);
      (doc.splitTextToSize(a.question?.trim() || '(bez teksta pitanja)', CONTENT_W) as string[]).forEach((line) => { pageBreak(LINE_H + 1); doc.text(line, MARGIN, st.y); st.y += LINE_H; });
      st.y += 0.5;
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(9.5);
      if (!list.length) {
        pageBreak(LINE_H + 1);
        doc.setTextColor(...COLORS.sub);
        doc.text('— nema odgovora —', MARGIN + 4, st.y);
        st.y += LINE_H;
      } else {
        for (const ans of list) {
          (doc.splitTextToSize(ans.trim(), CONTENT_W - 6) as string[]).forEach((line, i) => {
            pageBreak(LINE_H + 1);
            if (i === 0) { doc.setTextColor(...COLORS.sub); doc.text('•', MARGIN + 1.5, st.y); }
            doc.setTextColor(31, 41, 55);
            doc.text(line, MARGIN + 6, st.y);
            st.y += LINE_H;
          });
        }
      }
      st.y += 2.5;
    }
  }

  if (!groups.length && !competences.length && !answers.length) {
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...COLORS.sub);
    doc.text('Nema podataka procene za prikaz.', MARGIN, st.y);
  }

  // Footer (broj strana) — final pass
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 150);
    doc.text(String(whoFooter).slice(0, 80), MARGIN, PAGE_H - MARGIN + 4);
    doc.text(`Generisano: ${stamp} · ${i} / ${total}`, PAGE_W - MARGIN, PAGE_H - MARGIN + 4, { align: 'right' });
  }

  const blob = (doc as jsPDF).output('blob');
  const fileName = `Procena_kompetencija_${safeName(employeeName, 'procena')}.pdf`;
  openBlob(blob);
  downloadBlob(blob, fileName);
}

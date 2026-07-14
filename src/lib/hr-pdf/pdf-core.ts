import { jsPDF } from 'jspdf';

// Deljena osnova HR PDF generatora (ćirilica, Roboto/UTF-8, logo u zaglavlju).
// Port 1.0 `src/lib/hrDocPdf.js` / `vacationDecisionPdf.js` / `contractPdf.js`
// na bundlovan jsPDF (2.0 dependency) + fontove iz /public/fonts (isti origin →
// radi offline/LAN, bez CDN-a koji je 1.0 koristio). Logo iz /public/logo-servoteh.jpg.

async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} nedostupan (${res.status})`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

let _fonts: Promise<{ reg: string; bold: string }> | null = null;
function loadFonts(): Promise<{ reg: string; bold: string }> {
  if (!_fonts) {
    _fonts = Promise.all([
      fetchAsBase64('/fonts/Roboto-Regular.ttf'),
      fetchAsBase64('/fonts/Roboto-Bold.ttf'),
    ])
      .then(([reg, bold]) => ({ reg, bold }))
      .catch((e) => { _fonts = null; throw e; });
  }
  return _fonts;
}

interface Logo { dataUrl: string; ratio: number }
let _logo: Promise<Logo | null> | undefined;

function imageRatio(dataUrl: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** Servoteh logo za zaglavlje (kešira se; null ako nedostupan → dokument radi bez njega). */
async function loadLogo(): Promise<Logo | null> {
  if (_logo !== undefined) return _logo;
  _logo = (async () => {
    try {
      const b64 = await fetchAsBase64('/logo-servoteh.jpg');
      const dataUrl = `data:image/jpeg;base64,${b64}`;
      return { dataUrl, ratio: (await imageRatio(dataUrl)) || 971 / 207 };
    } catch {
      return null;
    }
  })();
  return _logo;
}

/** Iscrtaj logo gore-levo. Vraća true ako je iscrtan. */
export function drawLogo(doc: jsPDF, logo: Logo | null, x: number, y: number, targetH: number, maxW = 50): boolean {
  if (!logo?.dataUrl) return false;
  const ratio = logo.ratio || 971 / 207;
  let h = targetH;
  let w = h * ratio;
  if (w > maxW) { w = maxW; h = w / ratio; }
  try { doc.addImage(logo.dataUrl, 'JPEG', x, y, w, h); return true; } catch { return false; }
}

/** Nova jsPDF instanca sa registrovanim Roboto fontovima (+ opcioni učitan logo). */
export async function newPdf(orientation: 'portrait' | 'landscape' = 'portrait'): Promise<{ doc: jsPDF; logo: Logo | null }> {
  const [{ reg, bold }, logo] = await Promise.all([loadFonts(), loadLogo()]);
  const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
  doc.addFileToVFS('Roboto-Regular.ttf', reg);
  doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
  doc.addFileToVFS('Roboto-Bold.ttf', bold);
  doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
  doc.setFont('Roboto', 'normal');
  return { doc, logo };
}

export function safeName(s: string, fallback = 'zaposleni'): string {
  return String(s || '').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 50) || fallback;
}

/* ── Layout portret A4 ─────────────────────────────────────────────────── */
export const MARGIN = 20;
export const PAGE_W = 210;
export const PAGE_H = 297;
export const CONTENT_W = PAGE_W - MARGIN * 2;
export const BODY_BOTTOM = PAGE_H - MARGIN;

export interface DocText {
  bold?: boolean;
  align?: 'left' | 'center' | 'justify';
  size?: number;
  gap?: number;
  indent?: number;
  color?: [number, number, number];
}

export interface DocCtx {
  doc: jsPDF;
  y: () => number;
  para: (text: string, opts?: DocText) => void;
  bullet: (text: string) => void;
  pageBreak: (need: number) => void;
  signatures: (
    leftLabel: string,
    leftName: string,
    rightLabel: string,
    rightName: string,
    opts?: { rightMP?: boolean; leftDate?: boolean },
  ) => void;
  finalize: (footerLabel: string) => Blob;
  advance: (mm: number) => void;
}

/**
 * Otvara A4 dokument, iscrtava standardno zaglavlje (logo + СЕРВОТЕХ д.о.о. +
 * broj/datum/mesto) i vraća kontekst sa para/bullet/signatures/finalize.
 * Font/velicine su verne 1.0 hrDocPdf.js/vacationDecisionPdf.js (FONT_PT=11).
 */
export async function openDocument(opts: {
  broj?: string;
  datum?: string;
  mesto?: string;
  fontPt?: number;
  lineH?: number;
}): Promise<DocCtx> {
  const FONT_PT = opts.fontPt ?? 11;
  const LINE_H = opts.lineH ?? 5.2;
  const { doc, logo } = await newPdf('portrait');
  const st = { y: MARGIN };

  const drew = drawLogo(doc, logo, MARGIN, st.y, 12, 46);
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text('СЕРВОТЕХ д.о.о.', PAGE_W - MARGIN, st.y + 4, { align: 'right' });
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(110, 110, 110);
  doc.text('Угриновачка 163, Добановци', PAGE_W - MARGIN, st.y + 8.5, { align: 'right' });
  st.y += drew ? 16 : 14;
  doc.setDrawColor(190, 190, 190);
  doc.line(MARGIN, st.y, PAGE_W - MARGIN, st.y);
  st.y += 6;

  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(70, 70, 70);
  if (opts.broj) doc.text(`Број: ${opts.broj}`, MARGIN, st.y);
  doc.text(`${opts.mesto || 'Добановци'}, ${opts.datum || '________'} године`, PAGE_W - MARGIN, st.y, { align: 'right' });
  st.y += 8;

  const pageBreak = (need: number) => {
    if (st.y + need > BODY_BOTTOM) { doc.addPage(); st.y = MARGIN; }
  };

  const para = (text: string, o: DocText = {}) => {
    const { bold = false, align = 'justify', size = FONT_PT, gap = 1.8, indent = 0, color = [20, 20, 20] } = o;
    doc.setFont('Roboto', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
    const w = CONTENT_W - indent;
    const lines = doc.splitTextToSize(String(text), w) as string[];
    lines.forEach((line, i) => {
      pageBreak(LINE_H + 1);
      const isLast = i === lines.length - 1;
      if (align === 'center') {
        doc.text(line, PAGE_W / 2, st.y, { align: 'center' });
      } else if (align === 'justify' && !isLast && lines.length > 1) {
        doc.text(line, MARGIN + indent, st.y, { align: 'justify', maxWidth: w });
      } else {
        doc.text(line, MARGIN + indent, st.y);
      }
      st.y += LINE_H;
    });
    st.y += gap;
  };

  const bullet = (text: string) => {
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(FONT_PT);
    doc.setTextColor(20, 20, 20);
    const wrapped = doc.splitTextToSize(String(text), CONTENT_W - 8) as string[];
    wrapped.forEach((line, i) => {
      pageBreak(LINE_H + 1);
      if (i === 0) doc.text('•', MARGIN + 2, st.y);
      doc.text(line, MARGIN + 8, st.y);
      st.y += LINE_H;
    });
    st.y += 0.8;
  };

  const signatures = (
    leftLabel: string,
    leftName: string,
    rightLabel: string,
    rightName: string,
    o: { rightMP?: boolean; leftDate?: boolean } = {},
  ) => {
    pageBreak(30);
    st.y += 4;
    const colL = MARGIN + CONTENT_W * 0.22;
    const colR = MARGIN + CONTENT_W * 0.8;
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(FONT_PT);
    doc.setTextColor(20, 20, 20);
    doc.text(leftLabel, colL, st.y, { align: 'center' });
    doc.text(rightLabel, colR, st.y, { align: 'center' });
    st.y += 16;
    doc.setDrawColor(40, 40, 40);
    doc.line(colL - 26, st.y, colL + 26, st.y);
    doc.line(colR - 26, st.y, colR + 26, st.y);
    st.y += 5;
    if (leftName) doc.text(leftName, colL, st.y, { align: 'center' });
    if (rightName) doc.text(rightName, colR, st.y, { align: 'center' });
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 120);
    if (o.leftDate) doc.text('(датум: ____________)', colL, st.y + 5, { align: 'center' });
    if (o.rightMP) doc.text('М.П.', colR, st.y + 5, { align: 'center' });
  };

  const finalize = (footerLabel: string): Blob => {
    const total = doc.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      doc.setPage(i);
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(140, 140, 140);
      doc.text(String(footerLabel).slice(0, 90), MARGIN, PAGE_H - 8);
      doc.text(`${i} / ${total}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
    }
    return doc.output('blob');
  };

  return {
    doc,
    y: () => st.y,
    para,
    bullet,
    pageBreak,
    signatures,
    finalize,
    advance: (mm: number) => { st.y += mm; },
  };
}

import { jsPDF } from 'jspdf';

// Zapisnik sastanka PDF — port 1.0 `lib/sastanciPdf.js` (433 LOC) na 2.0 (bundlovan
// jsPDF + Roboto iz /public/fonts, isti origin → radi offline/LAN). Layout 1:1 sa
// 1.0 (meta → učesnici → zapisnik → akcioni plan po projektu). Logo = port 1.0
// pdfLogo.js: /logo-servoteh.jpg iz public/ u zaglavlju svake strane; tekstualni
// SERVOTEH fallback samo ako fetch/crtanje padne (paritet fallback grane 1.0).

async function fetchFontBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font ${url} nedostupan (${res.status})`);
  const buf = await res.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ── Servoteh logo (port 1.0 lib/pdfLogo.js) ──────────────────────────────────
// Keš na nivou modula: undefined = nije pokušano; null = nedostupan (fallback).

interface PdfLogo {
  dataUrl: string;
  ratio: number;
}

const LOGO_DEFAULT_RATIO = 971 / 207; // š/v originala iz memoranduma

let logoCache: PdfLogo | null | undefined;
/** Logo tekuće generacije — postavlja se na početku generateSastanakPdf (1.0 `_logo`). */
let currentLogo: PdfLogo | null = null;

function imageRatioFromDataUrl(dataUrl: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!dataUrl || typeof Image === 'undefined') return resolve(null);
    const img = new Image();
    img.onload = () =>
      resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function loadServotehLogo(): Promise<PdfLogo | null> {
  if (logoCache !== undefined) return logoCache;
  try {
    const buf = await fetch('/logo-servoteh.jpg').then((r) => (r.ok ? r.arrayBuffer() : null));
    if (!buf) {
      logoCache = null;
      return logoCache;
    }
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    const dataUrl = `data:image/jpeg;base64,${btoa(bin)}`;
    logoCache = { dataUrl, ratio: (await imageRatioFromDataUrl(dataUrl)) || LOGO_DEFAULT_RATIO };
  } catch {
    logoCache = null;
  }
  return logoCache;
}

/** Iscrtaj logo (gore-levo, visina targetH mm, širina ograničena maxW). true = uspeh. */
function drawServotehLogo(
  doc: jsPDF,
  logo: PdfLogo | null,
  x: number,
  y: number,
  targetH: number,
  maxW = 50,
): boolean {
  if (!logo?.dataUrl) return false;
  const ratio = logo.ratio || LOGO_DEFAULT_RATIO;
  let h = targetH;
  let w = h * ratio;
  if (w > maxW) {
    w = maxW;
    h = w / ratio;
  }
  try {
    doc.addImage(logo.dataUrl, 'JPEG', x, y, w, h);
    return true;
  } catch {
    return false;
  }
}

async function initDoc(): Promise<jsPDF> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const [reg, bold] = await Promise.all([
    fetchFontBase64('/fonts/Roboto-Regular.ttf'),
    fetchFontBase64('/fonts/Roboto-Bold.ttf'),
  ]);
  doc.addFileToVFS('Roboto-Regular.ttf', reg);
  doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
  doc.addFileToVFS('Roboto-Bold.ttf', bold);
  doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
  return doc;
}

// ── layout konstante (mm, A4) — paritet 1.0 ──
const MARGIN = 20;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const HEADER_H = 14;
const FOOTER_H = 10;
const LINE_H = 6;
const BODY_TOP = MARGIN + HEADER_H + 4;
const BODY_BOTTOM = PAGE_H - MARGIN - FOOTER_H;

interface PageState {
  pageNum: number;
}

function drawPageNumber(doc: jsPDF, pageNum: number, totalPages: number) {
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  doc.text(`${pageNum} / ${totalPages}`, PAGE_W - MARGIN, MARGIN + 5, { align: 'right' });
  doc.setTextColor(0, 0, 0);
}

function drawPageHeader(doc: jsPDF, naslov: string) {
  // Logo u zaglavlju (1.0 paritet: sastanciPdf.js drawPageHeader); tekst fallback.
  if (!drawServotehLogo(doc, currentLogo, MARGIN, MARGIN - 2, 7, 34)) {
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(37, 99, 235);
    doc.text('SERVOTEH d.o.o.', MARGIN, MARGIN + 5);
  }
  doc.setFontSize(8);
  doc.setFont('Roboto', 'normal');
  doc.setTextColor(80, 80, 80);
  doc.text('ZAPISNIK SA SASTANKA', PAGE_W / 2, MARGIN + 5, { align: 'center' });
  doc.setDrawColor(229, 231, 235);
  doc.line(MARGIN, MARGIN + 8, PAGE_W - MARGIN, MARGIN + 8);
  doc.setFontSize(7);
  doc.setTextColor(150, 150, 150);
  doc.text(naslov.slice(0, 80), MARGIN, PAGE_H - MARGIN + 4);
  doc.setTextColor(0, 0, 0);
}

function checkPageBreak(
  doc: jsPDF,
  y: number,
  heightNeeded: number,
  naslov: string,
  pageState: PageState,
): number {
  if (y + heightNeeded > BODY_BOTTOM) {
    doc.addPage();
    pageState.pageNum++;
    drawPageHeader(doc, naslov);
    return BODY_TOP;
  }
  return y;
}

function drawSectionHeading(doc: jsPDF, y: number, text: string): number {
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(17, 24, 39);
  doc.text(text, MARGIN, y);
  doc.setDrawColor(37, 99, 235);
  doc.line(MARGIN, y + 1.5, PAGE_W - MARGIN, y + 1.5);
  doc.setTextColor(0, 0, 0);
  return y + LINE_H + 2;
}

function drawMetaRow(doc: jsPDF, y: number, label: string, value: string): number {
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(107, 114, 128);
  doc.text(label, MARGIN, y);
  doc.setTextColor(17, 24, 39);
  doc.setFont('Roboto', 'bold');
  const wrapped = doc.splitTextToSize(value || '—', CONTENT_W - 45) as string[];
  doc.text(wrapped, MARGIN + 45, y);
  doc.setFont('Roboto', 'normal');
  doc.setTextColor(0, 0, 0);
  return y + Math.max(1, wrapped.length) * LINE_H;
}

const AK_STATUS: Record<string, { l: string; c: [number, number, number] }> = {
  otvoren: { l: 'Otvoren', c: [114, 128, 168] },
  u_toku: { l: 'U toku', c: [59, 130, 246] },
  zavrsen: { l: 'Završen', c: [16, 185, 129] },
  kasni: { l: 'Kasni', c: [239, 68, 68] },
  odlozen: { l: 'Odložen', c: [107, 114, 128] },
  otkazan: { l: 'Otkazan', c: [55, 65, 81] },
};

export interface PdfAkcija {
  naslov: string;
  effectiveStatus?: string | null;
  status?: string | null;
  odgovoranLabel?: string | null;
  odgovoranText?: string | null;
  odgovoranEmail?: string | null;
  rok?: string | null;
  rokText?: string | null;
}
export interface PdfAkcijeGroup {
  code?: string;
  naziv: string;
  rows: PdfAkcija[];
}

function drawAkcijeGroup(
  doc: jsPDF,
  yIn: number,
  group: PdfAkcijeGroup,
  naslov: string,
  pageState: PageState,
): number {
  let y = yIn;
  const COL = { status: 24, odg: 34, rok: 20 };
  const zadW = CONTENT_W - COL.status - COL.odg - COL.rok;
  const xStatus = MARGIN;
  const xZad = xStatus + COL.status;
  const xOdg = xZad + zadW;
  const xRok = xOdg + COL.odg;
  const AK_LINE = 4.6;
  const PAD = 2.6;

  const drawGroupHead = (suffix: string) => {
    doc.setFillColor(238, 242, 248);
    doc.rect(MARGIN, y - 4, CONTENT_W, 8, 'F');
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(17, 24, 39);
    const head = (group.code ? group.code + ' — ' : '') + group.naziv + (suffix || '');
    doc.text((doc.splitTextToSize(head, CONTENT_W - 6) as string[])[0], MARGIN + 2, y + 1);
    y += 8;
  };
  const drawColHeader = () => {
    doc.setFillColor(247, 248, 250);
    doc.rect(MARGIN, y - 4, CONTENT_W, 6, 'F');
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(107, 114, 128);
    doc.text('STATUS', xStatus + 2, y);
    doc.text('ZADATAK', xZad + 2, y);
    doc.text('ODGOVORAN', xOdg + 2, y);
    doc.text('ROK', xRok + 2, y);
    y += 6;
  };

  y = checkPageBreak(doc, y, 22, naslov, pageState);
  drawGroupHead('');
  drawColHeader();

  if (!group.rows.length) {
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(150, 150, 150);
    doc.text('— nema zadataka —', xZad + 2, y);
    y += AK_LINE + 2;
    doc.setTextColor(0, 0, 0);
    return y + 4;
  }

  const FS_ZAD = 9;
  const FS_META = 8;
  group.rows.forEach((a, ri) => {
    const eff = a.effectiveStatus || a.status || 'otvoren';
    const st = AK_STATUS[eff] || { l: eff, c: [80, 80, 80] as [number, number, number] };
    const odgTxt = a.odgovoranLabel || a.odgovoranText || a.odgovoranEmail || '—';
    const rok = a.rokText || (a.rok ? String(a.rok).split('-').reverse().join('.') : '—');

    doc.setFont('Roboto', 'normal');
    doc.setFontSize(FS_ZAD);
    const zadLines = doc.splitTextToSize(String(a.naslov || '—'), zadW - 4) as string[];
    doc.setFontSize(FS_META);
    const odgLines = doc.splitTextToSize(String(odgTxt), COL.odg - 3) as string[];
    const rokLines = doc.splitTextToSize(String(rok), COL.rok - 2) as string[];
    const nLines = Math.max(zadLines.length, odgLines.length, rokLines.length, 1);
    const rowH = nLines * AK_LINE + PAD * 2;

    if (y + rowH > BODY_BOTTOM) {
      doc.addPage();
      pageState.pageNum++;
      drawPageHeader(doc, naslov);
      y = BODY_TOP;
      drawGroupHead(' (nastavak)');
      drawColHeader();
    }

    if (ri % 2 === 1) {
      doc.setFillColor(250, 251, 252);
      doc.rect(MARGIN, y - 4, CONTENT_W, rowH, 'F');
    }

    const topY = y + PAD - 1;
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(st.c[0], st.c[1], st.c[2]);
    doc.text(st.l, xStatus + 2, topY);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(FS_ZAD);
    doc.setTextColor(17, 24, 39);
    doc.text(zadLines, xZad + 2, topY);
    doc.setFontSize(FS_META);
    doc.setTextColor(55, 65, 81);
    doc.text(odgLines, xOdg + 2, topY);
    if (eff === 'kasni') doc.setTextColor(239, 68, 68);
    else doc.setTextColor(55, 65, 81);
    doc.text(rokLines, xRok + 2, topY);
    doc.setTextColor(0, 0, 0);

    y += rowH;
    doc.setDrawColor(236, 239, 242);
    doc.line(MARGIN, y - 2, PAGE_W - MARGIN, y - 2);
  });

  return y + 6;
}

// ── ulazni tipovi ──
export interface PdfUcesnik {
  email: string;
  label?: string | null;
  prisutan?: boolean;
  pozvan?: boolean;
}
export interface PdfAktivnost {
  naslov: string;
  sadrzajText?: string | null;
  napomena?: string | null;
  odgovoranLabel?: string | null;
  odgovoranText?: string | null;
  odgovoranEmail?: string | null;
  rok?: string | null;
  rokText?: string | null;
  status?: string | null;
}
export interface SastanakPdfInput {
  naslov: string;
  datum?: string | null;
  vreme?: string | null;
  mesto?: string | null;
  tip?: string | null;
  vodioLabel?: string | null;
  vodioEmail?: string | null;
  zakljucanByEmail?: string | null;
  ucesnici: PdfUcesnik[];
  aktivnosti: PdfAktivnost[];
  akcioniPlanGrouped?: PdfAkcijeGroup[];
  diffSummary?: { novo: number; zavrsenoOveNedelje: number; kasni: number; aktivnih: number } | null;
}

const SASTANAK_TIPOVI: Record<string, string> = {
  sedmicni: 'Sedmični sastanak',
  projektni: 'Projektni sastanak',
  tematski: 'Tematski sastanak',
  dnevni: 'Dnevni operativni sastanak',
  redovni: 'Redovni',
  vanredni: 'Vanredni',
  koordinacioni: 'Koordinacioni',
  prezentacija: 'Prezentacija',
  obuka: 'Obuka',
  operativni: 'Operativni',
};

/** Generiše zapisnik → PDF Blob (za upload + preuzimanje). Paritet generateSastanakPdf. */
export async function generateSastanakPdf(
  sast: SastanakPdfInput,
  options: { includeAkcije?: boolean } = {},
): Promise<Blob> {
  const { includeAkcije = true } = options;
  currentLogo = await loadServotehLogo();
  const doc = await initDoc();
  const naslov = sast.naslov || 'Zapisnik';
  const pageState: PageState = { pageNum: 1 };

  const ucesnici = sast.ucesnici || [];
  const oznaceniPrisutni = ucesnici.filter((u) => u.prisutan);
  const prisutni = oznaceniPrisutni.length ? oznaceniPrisutni : ucesnici.filter((u) => u.pozvan);
  const prisutniSet = new Set(prisutni.map((u) => String(u.email || '').toLowerCase()));
  const odsutni = ucesnici.filter((u) => !prisutniSet.has(String(u.email || '').toLowerCase()));
  const imeUcesnika = (u: PdfUcesnik) => u.label || u.email;
  const resolveName = (email?: string | null) => {
    const e = String(email || '').toLowerCase();
    if (!e) return '—';
    return ucesnici.find((u) => String(u.email || '').toLowerCase() === e)?.label || email || '—';
  };

  // ── STRANA 1: META ──
  drawPageHeader(doc, naslov);
  let y = BODY_TOP;

  doc.setFont('Roboto', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(17, 24, 39);
  const naslovWrapped = doc.splitTextToSize(naslov, CONTENT_W) as string[];
  doc.text(naslovWrapped, MARGIN, y);
  y += naslovWrapped.length * 8 + 4;
  doc.setDrawColor(229, 231, 235);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 6;

  y = drawSectionHeading(doc, y, 'Informacije o sastanku');
  const datumFmt = sast.datum ? String(sast.datum).slice(0, 10).split('-').reverse().join('.') : '—';
  const vremeFmt = sast.vreme ? String(sast.vreme).slice(11, 16) || String(sast.vreme).slice(0, 5) : '—';
  y = drawMetaRow(doc, y, 'Datum', datumFmt);
  y = drawMetaRow(doc, y, 'Vreme', vremeFmt);
  y = drawMetaRow(doc, y, 'Mesto', sast.mesto || '—');
  y = drawMetaRow(doc, y, 'Tip', SASTANAK_TIPOVI[sast.tip ?? ''] || sast.tip || '—');
  y = drawMetaRow(doc, y, 'Vodio', sast.vodioLabel || resolveName(sast.vodioEmail));
  y = drawMetaRow(doc, y, 'Zaključio', resolveName(sast.zakljucanByEmail));
  if (sast.diffSummary) {
    const d = sast.diffSummary;
    y = drawMetaRow(
      doc,
      y,
      'Od prošlog sastanka',
      `${d.novo} novo · ${d.zavrsenoOveNedelje} završeno · ${d.kasni} kasni · ${d.aktivnih} aktivnih`,
    );
  }
  y += 4;

  if (ucesnici.length) {
    y = checkPageBreak(doc, y, 20, naslov, pageState);
    y = drawSectionHeading(doc, y, 'Učesnici');
    y = drawMetaRow(
      doc,
      y,
      `Prisutni (${prisutni.length})`,
      prisutni.length ? prisutni.map(imeUcesnika).join(', ') : '—',
    );
    if (odsutni.length) {
      y = drawMetaRow(doc, y, `Odsutni (${odsutni.length})`, odsutni.map(imeUcesnika).join(', '));
    }
    y += 4;
  }

  // ── ZAPISNIK ──
  const isMeaningfulAkt = (a: PdfAktivnost) => {
    const t = String(a.naslov || '').trim();
    const placeholder = !t || /^nova\s+ta[cč]ka$/i.test(t);
    const body = String(a.sadrzajText || a.napomena || '').trim();
    const meta = a.odgovoranLabel || a.rok || a.rokText;
    return !placeholder || !!body || !!meta;
  };
  const zapisnikAkt = (sast.aktivnosti || []).filter(isMeaningfulAkt);

  if (zapisnikAkt.length) {
    y = checkPageBreak(doc, y, 20, naslov, pageState);
    y = drawSectionHeading(doc, y, 'Zapisnik');
    zapisnikAkt.forEach((a, idx) => {
      y = checkPageBreak(doc, y, 20, naslov, pageState);
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(17, 24, 39);
      const aktWrapped = doc.splitTextToSize(`${idx + 1}. ${a.naslov}`, CONTENT_W) as string[];
      doc.text(aktWrapped, MARGIN, y);
      y += aktWrapped.length * LINE_H + 1;

      // Meta red SAMO uz odgovornog ili rok (1.0 paritet) — status tačke je uvek
      // popunjen pa bi „Status: planiran" bio šum na svakoj tački (S-P0 nalaz).
      const odg = a.odgovoranLabel || a.odgovoranText || a.odgovoranEmail;
      if (odg || a.rok || a.rokText) {
        doc.setFont('Roboto', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(107, 114, 128);
        const metaParts: string[] = [];
        if (odg) metaParts.push(`Odgovoran: ${odg}`);
        if (a.rokText || a.rok) metaParts.push(`Rok: ${a.rokText || a.rok}`);
        doc.text(metaParts.join('   ·   '), MARGIN + 2, y);
        doc.setTextColor(0, 0, 0);
        y += LINE_H;
      }

      const tekst = (a.sadrzajText || a.napomena || '').trim();
      if (tekst) {
        doc.setFont('Roboto', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(31, 41, 55);
        const lines = doc.splitTextToSize(tekst, CONTENT_W - 4) as string[];
        lines.forEach((line) => {
          y = checkPageBreak(doc, y, LINE_H + 1, naslov, pageState);
          doc.text(line, MARGIN + 2, y);
          y += LINE_H;
        });
      }

      y += 3;
      doc.setDrawColor(229, 231, 235);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y);
      y += 4;
    });
  }

  // ── AKCIONI PLAN po projektima ──
  const groups = sast.akcioniPlanGrouped ?? [];
  if (includeAkcije && groups.length) {
    y = checkPageBreak(doc, y, 24, naslov, pageState);
    y = drawSectionHeading(doc, y, 'Akcioni plan po projektima');
    y += 2;
    for (const g of groups) {
      y = drawAkcijeGroup(doc, y, g, naslov, pageState);
    }
  }

  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    drawPageNumber(doc, i, totalPages);
  }

  return doc.output('blob');
}

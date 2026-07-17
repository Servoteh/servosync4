import { jsPDF } from 'jspdf';
import type { ReversiDocumentDetail, ReversiDocumentLine } from '@/api/reversi';

// Potpisnica (revers) PDF — bundlovan jsPDF + Roboto (UTF-8 srpski dijakritici) +
// Servoteh logo (RB-48). Fontovi i logo iz /public (isti origin → radi offline/LAN).
// Paritet 1.0 reversiPdf.js `generateReversalPdf` (zaglavlje sa logom, tabela sa
// kolonom Napomena/Pribor, klauzula o zaduženju, blok potpisa + POVRAĆAJ, footer).

async function fetchAsBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  } catch {
    return null;
  }
}

async function fetchFontBase64(url: string): Promise<string> {
  const b64 = await fetchAsBase64(url);
  if (!b64) throw new Error(`Font ${url} nedostupan`);
  return b64;
}

// Servoteh logo — kešira se između generisanja (module-scope, RB-48).
let logoCache: { dataUrl: string; ratio: number } | null | undefined;
async function loadServotehLogo(): Promise<{ dataUrl: string; ratio: number } | null> {
  if (logoCache !== undefined) return logoCache;
  const b64 = await fetchAsBase64('/logo-servoteh.jpg');
  if (!b64) {
    logoCache = null;
    return logoCache;
  }
  const dataUrl = `data:image/jpeg;base64,${b64}`;
  const ratio = await new Promise<number>((resolve) => {
    if (typeof Image === 'undefined') return resolve(971 / 207);
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 971 / 207);
    img.onerror = () => resolve(971 / 207);
    img.src = dataUrl;
  });
  logoCache = { dataUrl, ratio };
  return logoCache;
}

async function ensureFonts(doc: jsPDF): Promise<void> {
  const [reg, bold] = await Promise.all([
    fetchFontBase64('/fonts/Roboto-Regular.ttf'),
    fetchFontBase64('/fonts/Roboto-Bold.ttf'),
  ]);
  doc.addFileToVFS('Roboto-Regular.ttf', reg);
  doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
  doc.addFileToVFS('Roboto-Bold.ttf', bold);
  doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
}

const PAGE_W = 210;
const PAGE_H = 297;
const M = 15;
const CONTENT_W = PAGE_W - M * 2;
const FOOTER_H = 11;
const LINE_H = 5;
const BODY_TOP_FIRST = M + 33;
const BODY_BOTTOM = PAGE_H - M - FOOTER_H - 2;
const SIGNATURE_BLOCK_H = 78;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function formatSerbianDate(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}
function formatGeneratedAt(d = new Date()): string {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} u ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function revTitle(docType: string): string {
  if (docType === 'COOPERATION_GOODS') return 'REVERS — ROBA NA KOOPERACIJI';
  if (docType === 'CUTTING_TOOL') return 'REVERS O ZADUŽENJU REZNOG ALATA';
  return 'REVERS O ZADUŽENJU ALATA';
}

function drawLogo(doc: jsPDF, logo: { dataUrl: string; ratio: number } | null, x: number, y: number, targetH: number, maxW: number): boolean {
  if (!logo?.dataUrl) return false;
  const ratio = logo.ratio || 971 / 207;
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

function drawMainHeader(doc: jsPDF, d: ReversiDocumentDetail, logo: { dataUrl: string; ratio: number } | null, issueDateStr: string): void {
  if (drawLogo(doc, logo, M, M, 10, 46)) {
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(90, 90, 90);
    doc.text('Beograd', M, M + 14);
  } else {
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(17, 24, 39);
    doc.text('SERVOTEH d.o.o.', M, M + 6);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(90, 90, 90);
    doc.text('Beograd', M, M + 12);
  }

  doc.setFont('Roboto', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(17, 24, 39);
  doc.text(`Br. reversa: ${d.docNumber || '—'}`, PAGE_W - M, M + 6, { align: 'right' });
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9);
  doc.text(`Datum: ${issueDateStr}`, PAGE_W - M, M + 12, { align: 'right' });

  doc.setFont('Roboto', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(17, 24, 39);
  doc.text(revTitle(d.docType), PAGE_W / 2, M + 23, { align: 'center' });

  doc.setDrawColor(150, 150, 150);
  doc.line(M, M + 27, PAGE_W - M, M + 27);
  doc.setTextColor(0, 0, 0);
}

function drawContinuationHeader(doc: jsPDF, d: ReversiDocumentDetail): void {
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(9);
  doc.text(`${revTitle(d.docType)} — ${d.docNumber || ''}`, M, M + 6);
  doc.setDrawColor(200, 200, 200);
  doc.line(M, M + 9, PAGE_W - M, M + 9);
}

function drawFooter(doc: jsPDF, generatedAtStr: string, pageNum: number, totalPages: number): void {
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text(`Dokument generisan: ${generatedAtStr}`, M, PAGE_H - M + 4);
  doc.text(`Stranica ${pageNum} od ${totalPages}`, PAGE_W - M, PAGE_H - M + 4, { align: 'right' });
  doc.setTextColor(0, 0, 0);
}

function recipientText(d: ReversiDocumentDetail): string {
  if (d.recipientType === 'EMPLOYEE') return d.recipientEmployeeName ?? '—';
  if (d.recipientType === 'DEPARTMENT') return d.recipientDepartment ?? '—';
  if (d.recipientType === 'EXTERNAL_COMPANY') return d.recipientCompanyName ?? '—';
  return '—';
}

/** Generiše potpisnicu (revers) → PDF Blob (za upload + preuzimanje). Paritet 1.0. */
export async function generateReversiPdf(d: ReversiDocumentDetail): Promise<Blob> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  await ensureFonts(doc);
  const logo = await loadServotehLogo();
  doc.setFont('Roboto', 'normal');

  const issueDateStr = formatSerbianDate(d.issuedAt) || formatSerbianDate(new Date());
  const generatedAtStr = formatGeneratedAt(new Date());
  const coopDoc = d.docType === 'COOPERATION_GOODS';
  const pageNum = { n: 1 };

  const ensureSpace = (y: number, heightNeeded: number): number => {
    if (y + heightNeeded <= BODY_BOTTOM) return y;
    doc.addPage();
    pageNum.n += 1;
    return M + 14;
  };

  let y = BODY_TOP_FIRST;

  // Primalac
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(10);
  doc.text('PRIMALAC:', M, y);
  y += LINE_H + 1;
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9);
  doc.text(recipientText(d), M + 22, y);
  y += LINE_H + 2;
  if (d.recipientMachineCode) {
    doc.setTextColor(80, 80, 80);
    doc.text(`Mašina: ${d.recipientMachineCode}`, M + 22, y);
    doc.setTextColor(0, 0, 0);
    y += LINE_H;
  }
  y += 3;

  // Tabela stavki
  const colBr = 9;
  const colOz = coopDoc ? 22 : 18;
  const colKol = 14;
  const colNote = 38;
  const colName = CONTENT_W - colBr - colOz - colKol - colNote;
  const colXs = [M, M + colBr, M + colBr + colOz, M + colBr + colOz + colName, M + colBr + colOz + colName + colKol];
  const headers = coopDoc
    ? ['Br', 'Br. crteža', 'Naziv dela', 'Kol', 'Napomena']
    : ['Br', 'Oznaka', 'Naziv', 'Kol', 'Napomena / Pribor'];

  const sorted = [...(d.lines ?? [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const headerRowH = LINE_H + 3;
  y = ensureSpace(y, headerRowH + 8);
  doc.setFillColor(243, 244, 246);
  doc.rect(M, y - LINE_H + 1, CONTENT_W, headerRowH, 'F');
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(55, 65, 81);
  headers.forEach((h, i) => doc.text(h, colXs[i] + 1, y));
  y += headerRowH - 1;
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(17, 24, 39);

  const cellOf = (ln: ReversiDocumentLine): { oz: string; naz: string } => {
    if (coopDoc || ln.lineType === 'PRODUCTION_PART') {
      return { oz: ln.drawingNo || '—', naz: ln.partName || ln.drawingNo || '—' };
    }
    const t = ln.tool;
    let naz = t?.naziv ?? '—';
    if (t?.serijskiBroj) naz = `${naz} (${t.serijskiBroj})`;
    return { oz: t?.oznaka ?? '—', naz };
  };

  sorted.forEach((ln, idx) => {
    const { oz, naz } = cellOf(ln);
    const qtyStr = String(Number(ln.quantity ?? 1));
    const note = (ln.napomena || '').trim() || '—';
    const linesOz = doc.splitTextToSize(oz, colOz - 3) as string[];
    const linesNa = doc.splitTextToSize(naz, colName - 3) as string[];
    const linesNo = doc.splitTextToSize(note, colNote - 3) as string[];
    const linesBr = doc.splitTextToSize(String(idx + 1), colBr - 3) as string[];
    const linesQty = doc.splitTextToSize(qtyStr, colKol - 3) as string[];
    const maxLines = Math.max(linesOz.length, linesNa.length, linesNo.length, linesBr.length, linesQty.length, 1);
    const rowH = maxLines * LINE_H + 4;

    y = ensureSpace(y, rowH + 2);
    doc.setDrawColor(230, 230, 230);
    doc.rect(M, y - LINE_H + 2, CONTENT_W, rowH);
    const baseY = y;
    const drawCell = (textLines: string[], x: number) => {
      let yy = baseY;
      textLines.forEach((line) => {
        doc.text(line, x + 1, yy);
        yy += LINE_H;
      });
    };
    drawCell(linesBr, colXs[0]);
    drawCell(linesOz, colXs[1]);
    drawCell(linesNa, colXs[2]);
    drawCell(linesQty, colXs[3]);
    drawCell(linesNo, colXs[4]);
    y = baseY + maxLines * LINE_H + 4;
  });

  y += 4;

  if (d.expectedReturnDate) {
    y = ensureSpace(y, LINE_H + 4);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    doc.text(`Očekivani datum povraćaja:  ${formatSerbianDate(d.expectedReturnDate)}`, M, y);
    y += LINE_H + 4;
  }

  const napDoc = (d.napomena || '').trim();
  if (napDoc) {
    const wrapped = doc.splitTextToSize(`Napomena:  ${napDoc}`, CONTENT_W) as string[];
    y = ensureSpace(y, wrapped.length * LINE_H + 4);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    wrapped.forEach((line) => {
      doc.text(line, M, y);
      y += LINE_H;
    });
    y += 4;
  }

  if (!coopDoc) {
    const ppeLines = doc.splitTextToSize(
      'Ovim reversom SERVOTEH d.o.o. zadužuje gore navedenog primaoca alatom, opremom i pripadajućim priborom prema stavkama u tabeli. ' +
        'Primalac potpisom potvrđuje da je navedeni alat primio u ispravnom i funkcionalnom stanju i obavezuje se da ga čuva pažnjom dobrog domaćina, ' +
        'koristi isključivo u poslovne svrhe i u skladu sa namenom, te da ga vrati na zahtev poslodavca, po prestanku potrebe ili prestanku radnog angažovanja. ' +
        'Za gubitak, otuđenje ili oštećenje nastalo nepažnjom primalac odgovara materijalno. ' +
        'Svaki kvar, gubitak ili oštećenje primalac je dužan da odmah prijavi magacinu ili nadređenom.',
      CONTENT_W,
    ) as string[];
    y = ensureSpace(y, ppeLines.length * LINE_H + 6);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(75, 75, 75);
    ppeLines.forEach((line) => {
      doc.text(line, M, y);
      y += LINE_H;
    });
    doc.setTextColor(17, 24, 39);
    y += 4;
  }

  // Potpisi
  y = ensureSpace(y, SIGNATURE_BLOCK_H + 6);
  doc.setDrawColor(160, 160, 160);
  doc.line(M, y, PAGE_W - M, y);
  y += 8;

  const sigLine = (labelLeft: string, labelRight: string, y0: number, rightThird?: string): number => {
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9);
    doc.text(labelLeft, M, y0);
    doc.text(labelRight, PAGE_W / 2 + 5, y0);
    y0 += LINE_H + 2;
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    doc.text('Ime i prezime: ______________________', M, y0);
    doc.text('Ime i prezime: ______________________', PAGE_W / 2 + 5, y0);
    y0 += LINE_H + 3;
    doc.text('Potpis:        ______________________', M, y0);
    doc.text('Potpis:        ______________________', PAGE_W / 2 + 5, y0);
    y0 += LINE_H + 3;
    doc.text('Datum:         ______________________', M, y0);
    doc.text(rightThird ?? 'Datum:         ______________________', PAGE_W / 2 + 5, y0);
    return y0 + LINE_H + 4;
  };

  y = sigLine('Predao (Servoteh):', 'Primio:', y);
  y += 4;
  doc.line(M, y, PAGE_W - M, y);
  y += 8;
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(10);
  doc.text('POVRAĆAJ', M, y);
  y += LINE_H + 6;
  y = sigLine('Primio u magacin (Servoteh):', 'Predao:', y, 'Stanje alata:  ______________________');

  const totalPages = doc.internal.pages.length - 1;
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    if (i === 1) drawMainHeader(doc, d, logo, issueDateStr);
    else drawContinuationHeader(doc, d);
    drawFooter(doc, generatedAtStr, i, totalPages);
  }

  return doc.output('blob');
}

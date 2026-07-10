import { jsPDF } from 'jspdf';
import type { ReversiDocumentDetail } from '@/api/reversi';
import { formatDate } from './format';

// Potpisnica (revers) PDF — bundlovan jsPDF + Roboto (UTF-8 srpski dijakritici),
// fontovi iz /public/fonts (isti origin → radi i offline/LAN). Paritet 1.0 reversiPdf.js.

async function fetchFontBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font ${url} nedostupan (${res.status})`);
  const buf = await res.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
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

const DOC_TYPE_LABEL: Record<string, string> = {
  TOOL: 'Zaduženje alata',
  COOPERATION_GOODS: 'Kooperaciona roba',
  CUTTING_TOOL: 'Zaduženje reznog alata',
};

function recipient(d: ReversiDocumentDetail): string {
  if (d.recipientType === 'EMPLOYEE') return d.recipientEmployeeName ?? '—';
  if (d.recipientType === 'DEPARTMENT') return d.recipientDepartment ?? '—';
  return d.recipientCompanyName ?? '—';
}

/** Generiše potpisnicu za dokument → vraća PDF Blob (za upload + preuzimanje). */
export async function generateReversiPdf(d: ReversiDocumentDetail): Promise<Blob> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await ensureFonts(doc); // jsPDF instanca je nova svaki put → uvek registruj font
  doc.setFont('Roboto', 'normal');

  const M = 18;
  let y = M;

  doc.setFont('Roboto', 'bold');
  doc.setFontSize(15);
  doc.text('SERVOTEH', M, y);
  doc.setFontSize(12);
  doc.text(DOC_TYPE_LABEL[d.docType] ?? 'Revers', 210 - M, y, { align: 'right' });
  y += 7;
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(10);
  doc.text(`Broj: ${d.docNumber}`, 210 - M, y, { align: 'right' });
  y += 8;

  doc.setDrawColor(200);
  doc.line(M, y, 210 - M, y);
  y += 8;

  doc.setFontSize(10);
  const meta: [string, string][] = [
    ['Primalac:', recipient(d)],
    ['Izdato:', formatDate(d.issuedAt)],
    ['Rok vraćanja:', formatDate(d.expectedReturnDate)],
  ];
  for (const [k, v] of meta) {
    doc.setFont('Roboto', 'bold');
    doc.text(k, M, y);
    doc.setFont('Roboto', 'normal');
    doc.text(v || '—', M + 32, y);
    y += 6;
  }
  y += 4;

  // Tabela stavki
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(9);
  doc.text('Rb.', M, y);
  doc.text('Oznaka / naziv', M + 12, y);
  doc.text('Kol.', 210 - M - 24, y, { align: 'right' });
  doc.text('Jed.', 210 - M, y, { align: 'right' });
  y += 2;
  doc.line(M, y, 210 - M, y);
  y += 5;
  doc.setFont('Roboto', 'normal');
  d.lines.forEach((l, i) => {
    const name = l.tool ? `${l.tool.oznaka} — ${l.tool.naziv}` : (l.partName ?? l.drawingNo ?? '—');
    doc.text(String(i + 1), M, y);
    doc.text(doc.splitTextToSize(name, 120)[0] as string, M + 12, y);
    doc.text(String(Number(l.quantity)), 210 - M - 24, y, { align: 'right' });
    doc.text(l.unit, 210 - M, y, { align: 'right' });
    y += 6;
    if (y > 250) {
      doc.addPage();
      y = M;
    }
  });

  y = Math.max(y + 14, 250);
  doc.line(M, y, M + 60, y);
  doc.line(210 - M - 60, y, 210 - M, y);
  y += 5;
  doc.setFontSize(9);
  doc.text('Izdao', M + 25, y, { align: 'center' });
  doc.text('Primio', 210 - M - 30, y, { align: 'center' });

  return doc.output('blob');
}

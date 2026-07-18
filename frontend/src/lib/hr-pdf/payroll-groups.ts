// Mesečne PDF tabele zarada za knjigovođu — po payroll grupama. Port 1.0
// `src/lib/payrollGroupsPdf.js` na 2.0 pdf-core (bundlovan jsPDF + Roboto/UTF-8,
// logo iz /public). Kolone: rb | PREZIME | IME | NETO (prevoz: iznos) + UKUPNO.
// Grupa 'kes' se NE šalje knjigovođi (ni u prevoz).
// ⚠ Ime/prezime: pozivalac (accountant-modal) čita first_name/last_name kolone
// v_employees_safe; splitName je SAMO fallback (full_name = „Prezime Ime").

import { newPdf, drawLogo } from './pdf-core';
import { MONTHS_SR_LAT } from '@/app/kadrovska/_components/zarade/calc';

const MARGIN = 20;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BODY_BOTTOM = PAGE_H - 22;
const ROW_H = 7;

const COLS = [
  { w: 12, align: 'center' as const },
  { w: 63, align: 'left' as const },
  { w: 55, align: 'left' as const },
  { w: 40, align: 'right' as const },
];

const NETO_HEADERS = ['rb', 'PREZIME', 'IME', 'NETO'];
const PREVOZ_HEADERS = ['rb', 'Prezime', 'Ime', 'iznos'];

function fmtRsd0(x: number): string {
  return Math.round(Number(x || 0)).toLocaleString('sr-RS', { maximumFractionDigits: 0 });
}

/**
 * Fallback SAMO kad view red nema first_name/last_name kolone (živa baza: 0
 * takvih redova). `full_name` na sy15 je „Prezime Ime" (employees_sync_full_name
 * trigger: last||' '||first) → PRVI token = prezime, ostatak = ime (1.0
 * employeeNames.js fallbackSurname semantika).
 */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: '', lastName: parts[0] || '' };
  return { lastName: parts[0], firstName: parts.slice(1).join(' ') };
}

/** NETO za tabelu: snapshot neto_rsd → fallback amount (RSD/neto/ne-satnica). */
function netoForTable(s: Record<string, unknown>): number {
  if (Number(s?.neto_rsd) > 0) return Number(s.neto_rsd);
  if (
    (String(s?.currency ?? 'RSD') || 'RSD') === 'RSD' &&
    s?.salary_type !== 'satnica' &&
    (String(s?.amount_type ?? 'neto') || 'neto') === 'neto' &&
    Number(s?.amount) > 0
  ) return Number(s.amount);
  return 0;
}

export interface GroupJoined {
  lastName: string;
  firstName: string;
  sal: Record<string, unknown>;
}
interface TableRow { lastName: string; firstName: string; value: number }
interface TableSpec {
  title: string;
  subtitle?: string;
  footerNote?: string;
  headers: string[];
  rows: TableRow[];
  noTransportNames?: string[];
}

async function generateGroupTablePdfBlob(o: TableSpec): Promise<Blob> {
  const { title, subtitle = '', footerNote = '', headers, rows, noTransportNames = null } = o;
  const { doc, logo } = await newPdf('portrait');
  let y = MARGIN;

  const drew = drawLogo(doc, logo, MARGIN, y, 12, 46);
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text('SERVOTEH d.o.o.', PAGE_W - MARGIN, y + 4, { align: 'right' });
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(110, 110, 110);
  doc.text('Ugrinovačka 163, Dobanovci', PAGE_W - MARGIN, y + 8.5, { align: 'right' });
  y += drew ? 16 : 14;
  doc.setDrawColor(190, 190, 190);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 8;

  doc.setFont('Roboto', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(20, 20, 20);
  (doc.splitTextToSize(title, CONTENT_W) as string[]).forEach((line) => { doc.text(line, PAGE_W / 2, y, { align: 'center' }); y += 6; });
  if (subtitle) {
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(90, 90, 90);
    (doc.splitTextToSize(subtitle, CONTENT_W) as string[]).forEach((line) => { doc.text(line, PAGE_W / 2, y, { align: 'center' }); y += 4.6; });
  }
  y += 3;

  const colX: number[] = [];
  let acc = MARGIN;
  for (const c of COLS) { colX.push(acc); acc += c.w; }

  const cellText = (txt: string, ci: number, rowY: number, opt: { bold?: boolean; size?: number } = {}) => {
    doc.setFont('Roboto', opt.bold ? 'bold' : 'normal');
    doc.setFontSize(opt.size ?? 10);
    const c = COLS[ci];
    const baseline = rowY + ROW_H / 2 + 1.6;
    if (c.align === 'right') doc.text(String(txt), colX[ci] + c.w - 2, baseline, { align: 'right' });
    else if (c.align === 'center') doc.text(String(txt), colX[ci] + c.w / 2, baseline, { align: 'center' });
    else doc.text(String(txt), colX[ci] + 2, baseline);
  };
  const rowBorders = (rowY: number) => {
    doc.setDrawColor(200, 200, 200);
    let x = MARGIN;
    for (const c of COLS) { doc.rect(x, rowY, c.w, ROW_H); x += c.w; }
  };
  const tableHead = () => {
    doc.setFillColor(232, 236, 242);
    doc.rect(MARGIN, y, CONTENT_W, ROW_H, 'F');
    rowBorders(y);
    doc.setTextColor(20, 20, 20);
    headers.forEach((h, ci) => cellText(h, ci, y, { bold: true, size: 9.5 }));
    y += ROW_H;
  };
  const pageBreak = (need = ROW_H) => {
    if (y + need > BODY_BOTTOM) { doc.addPage(); y = MARGIN; tableHead(); }
  };

  tableHead();
  doc.setTextColor(20, 20, 20);
  rows.forEach((r, i) => {
    pageBreak();
    if (i % 2 === 1) { doc.setFillColor(248, 249, 251); doc.rect(MARGIN, y, CONTENT_W, ROW_H, 'F'); }
    rowBorders(y);
    cellText(String(i + 1), 0, y);
    cellText(r.lastName || '—', 1, y);
    cellText(r.firstName || '—', 2, y);
    cellText(fmtRsd0(r.value), 3, y);
    y += ROW_H;
  });

  pageBreak();
  const total = rows.reduce((sum, r) => sum + Math.round(Number(r.value || 0)), 0);
  doc.setFillColor(222, 228, 238);
  doc.rect(MARGIN, y, CONTENT_W, ROW_H, 'F');
  rowBorders(y);
  cellText('UKUPNO', 1, y, { bold: true });
  cellText(fmtRsd0(total), 3, y, { bold: true });
  y += ROW_H + 5;

  const para = (text: string, opt: { bold?: boolean; size?: number; color?: [number, number, number] } = {}) => {
    doc.setFont('Roboto', opt.bold ? 'bold' : 'normal');
    doc.setFontSize(opt.size ?? 9.5);
    const c = opt.color ?? [70, 70, 70];
    doc.setTextColor(c[0], c[1], c[2]);
    (doc.splitTextToSize(String(text), CONTENT_W) as string[]).forEach((line) => {
      if (y + 5 > BODY_BOTTOM) { doc.addPage(); y = MARGIN; }
      doc.text(line, MARGIN, y);
      y += 4.8;
    });
    y += 1.6;
  };
  if (footerNote) para(footerNote);
  if (Array.isArray(noTransportNames) && noTransportNames.length) {
    y += 2;
    para('NEMAJU PREVOZ:', { bold: true, size: 10.5, color: [20, 20, 20] });
    para(noTransportNames.join(', '), { size: 10, color: [20, 20, 20] });
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 140);
    doc.text(String(title).slice(0, 90), MARGIN, PAGE_H - 8);
    doc.text(`${i} / ${pages}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
  }
  return doc.output('blob');
}

export interface PayrollGroupPdf {
  key: string;
  filename: string;
  title: string;
  blob: Blob;
  count: number;
  totalRsd: number;
}

/**
 * Generiši mesečne PDF tabele zarada za knjigovođu.
 * @param joined  aktivni zaposleni sa aktuelnom zaradom (već spojeno ime + sal red).
 */
export async function buildPayrollGroupPdfs({
  month,
  year,
  joined,
}: {
  month: number;
  year: number;
  joined: GroupJoined[];
}): Promise<PayrollGroupPdf[]> {
  const m = Number(month);
  const yr = Number(year);
  if (!(m >= 1 && m <= 12) || !yr) throw new Error('Neispravan mesec/godina');
  const mLabel = MONTHS_SR_LAT[m - 1].toUpperCase();

  const cmp = (x: string, y: string) => x.localeCompare(y, 'sr', { sensitivity: 'base' });
  const list = joined
    .filter((j) => (String(j.sal.payroll_group ?? 'standard') || 'standard') !== 'kes')
    .sort((a, b) => cmp(a.lastName, b.lastName) || cmp(a.firstName, b.firstName));

  const toRow = (j: GroupJoined, value: number): TableRow => ({ lastName: j.lastName, firstName: j.firstName, value });

  const groupSpecs = [
    { key: 'standard', title: `ZAPOSLENI BEZ OLAKŠICA ${mLabel} ${yr}`, filename: `Zarade_bez_olaksica_${mLabel}_${yr}.pdf` },
    { key: 'olaksice', title: `SERVOTEH — ZAPOSLENI SA OLAKŠICAMA ${mLabel} ${yr}`, subtitle: 'Stare olakšice, u skladu sa članom 21v i 21d ZPDG — do 31.12.2025.', filename: `Zarade_sa_olaksicama_${mLabel}_${yr}.pdf` },
    { key: 'razvoj', title: `RAZVOJ ${mLabel} ${yr}`, subtitle: 'član 21i ZPDG i 45z ZDOSO', filename: `Zarade_razvoj_${mLabel}_${yr}.pdf` },
    { key: 'stranci', title: `STRANCI ${mLabel} ${yr}`, footerNote: 'Isplata ide 12 meseci sa posebnog računa na njihov račun za nerezidente.', filename: `Zarade_stranci_${mLabel}_${yr}.pdf` },
    { key: 'hapfluid', title: `PREGLED ZA ZARADE HAP FLUID DOO BEOGRAD — ${mLabel} ${yr}.`, filename: `Zarade_HAP_Fluid_${mLabel}_${yr}.pdf` },
  ];

  const out: PayrollGroupPdf[] = [];
  for (const spec of groupSpecs) {
    const rows = list
      .filter((j) => (String(j.sal.payroll_group ?? 'standard') || 'standard') === spec.key)
      .map((j) => toRow(j, netoForTable(j.sal)));
    if (!rows.length) continue;
    const blob = await generateGroupTablePdfBlob({ title: spec.title, subtitle: spec.subtitle, footerNote: spec.footerNote, headers: NETO_HEADERS, rows });
    out.push({ key: spec.key, filename: spec.filename, title: spec.title, blob, count: rows.length, totalRsd: rows.reduce((s, r) => s + Math.round(Number(r.value || 0)), 0) });
  }

  const prevozRows = list.filter((j) => Number(j.sal.transport_allowance_rsd) > 0).map((j) => toRow(j, Number(j.sal.transport_allowance_rsd)));
  if (prevozRows.length) {
    const noTransportNames = list
      .filter((j) => !(Number(j.sal.transport_allowance_rsd) > 0))
      .map((j) => [j.lastName, j.firstName].filter(Boolean).join(' '));
    const title = `PREVOZ ${mLabel} ${yr}`;
    const blob = await generateGroupTablePdfBlob({ title, headers: PREVOZ_HEADERS, rows: prevozRows, noTransportNames });
    out.push({ key: 'prevoz', filename: `Prevoz_${mLabel}_${yr}.pdf`, title, blob, count: prevozRows.length, totalRsd: prevozRows.reduce((s, r) => s + Math.round(Number(r.value || 0)), 0) });
  }
  return out;
}

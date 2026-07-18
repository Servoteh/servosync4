// Obračun zarade (payslip) — PDF preko pdf-core (bundlovan jsPDF + Roboto/UTF-8).
// Port sadržaja 1.0 salaryPayrollTab._buildPayslipBody na jsPDF. Jedan zaposleni
// po strani; bulk = više strana (page-break). Autoritativni K3.3 obračun je BE —
// FE prikazuje snimljene vrednosti iz v_salary_payroll_month reda.

import type { jsPDF } from 'jspdf';
import { newPdf, drawLogo } from './pdf-core';
import { MONTHS_SR_UPPER, fmtRsd, fmtNum, n, s } from '@/app/kadrovska/_components/zarade/calc';

const MARGIN = 20;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;

export interface PayslipRow {
  row: Record<string, unknown>;
  employeeName: string;
  jmbg?: string;
}

function statusLabel(st: string): string {
  switch (st) {
    case 'draft': return 'Draft';
    case 'advance_paid': return 'I deo isplaćen';
    case 'finalized': return 'Finalizovano';
    case 'paid': return 'Isplaćeno';
    default: return st || '—';
  }
}

/** Prikazni totali: K3.3 (ukupna_zarada) kad ima obračun, inače prosti total. */
export function payslipTotals(r: Record<string, unknown>): { totRsd: number; totEur: number; secRsd: number; useK33: boolean } {
  const useK33 = !!s(r, 'compensation_model') && n(r, 'ukupna_zarada') > 0;
  return {
    totRsd: useK33 ? n(r, 'ukupna_zarada') : n(r, 'total_rsd'),
    totEur: n(r, 'total_eur') || n(r, 'foreign_days') * n(r, 'per_diem_eur'),
    secRsd: useK33 ? n(r, 'preostalo_za_isplatu') : n(r, 'second_part_rsd'),
    useK33,
  };
}

function fmtD(ymd: string): string {
  if (!ymd) return '';
  const p = String(ymd).slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}.` : ymd;
}

/** Iscrtava jedan payslip počev od zadatog y; vraća novi y. */
function drawPayslip(doc: jsPDF, logo: Parameters<typeof drawLogo>[1], r: Record<string, unknown>, name: string, jmbg: string, todayStr: string): void {
  const period = `${MONTHS_SR_UPPER[n(r, 'period_month') - 1] || n(r, 'period_month')} ${n(r, 'period_year')}`;
  const protocol = `OZ-${n(r, 'period_year')}-${String(n(r, 'period_month')).padStart(2, '0')}-${String(s(r, 'employee_id')).slice(0, 8).toUpperCase()}`;
  const { totRsd, totEur, secRsd, useK33 } = payslipTotals(r);
  const isHourly = s(r, 'salary_type') === 'satnica';
  let y = MARGIN;

  const drew = drawLogo(doc, logo, MARGIN, y, 12, 46);
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 20);
  doc.text('SERVOTEH d.o.o.', MARGIN + (drew ? 50 : 0), y + 5);
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(110, 110, 110);
  doc.text(`Br. obračuna: ${protocol}`, PAGE_W - MARGIN, y + 3, { align: 'right' });
  doc.text(`Datum štampe: ${todayStr}`, PAGE_W - MARGIN, y + 7.5, { align: 'right' });
  doc.text(`Status: ${statusLabel(s(r, 'status'))}`, PAGE_W - MARGIN, y + 12, { align: 'right' });
  y += 18;
  doc.setDrawColor(190, 190, 190);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 8;

  doc.setFont('Roboto', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(20, 20, 20);
  doc.text('OBRAČUN ZARADE', PAGE_W / 2, y, { align: 'center' });
  y += 6;
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(70, 70, 70);
  doc.text(`za period: ${period}`, PAGE_W / 2, y, { align: 'center' });
  y += 8;

  // Meta blok
  const meta: [string, string][] = [
    ['Zaposleni:', name || '—'],
    ...(jmbg ? [['JMBG:', jmbg] as [string, string]] : []),
    ['Radno mesto:', s(r, 'employee_position') || '—'],
    ['Odeljenje:', s(r, 'employee_department') || '—'],
    ['Tip ugovora:', s(r, 'salary_type') || '—'],
  ];
  doc.setFillColor(245, 245, 245);
  const metaH = Math.ceil(meta.length / 2) * 6 + 6;
  doc.rect(MARGIN, y, CONTENT_W, metaH, 'F');
  doc.setFontSize(9.5);
  meta.forEach((m, i) => {
    const col = i % 2;
    const rowIdx = Math.floor(i / 2);
    const x = MARGIN + 4 + col * (CONTENT_W / 2);
    const yy = y + 5 + rowIdx * 6;
    doc.setFont('Roboto', 'normal');
    doc.setTextColor(90, 90, 90);
    doc.text(m[0], x, yy);
    doc.setFont('Roboto', 'bold');
    doc.setTextColor(20, 20, 20);
    doc.text(m[1], x + 34, yy);
  });
  y += metaH + 8;

  // K3.3 razlaganje sati
  if (useK33) {
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(50, 50, 50);
    doc.text('RAZLAGANJE SATI', MARGIN, y);
    y += 5;
    const hourRows: [string, number][] = [
      ['Fond sati u mesecu', n(r, 'fond_sati_meseca')],
      ['Redovan rad', n(r, 'redovan_rad_sati')],
      ['Prekovremeni sati', n(r, 'prekovremeni_sati')],
      ['Praznik — rad', n(r, 'praznik_rad_sati')],
      ['Praznik — plaćen (slobodan)', n(r, 'praznik_placeni_sati')],
      ['Godišnji odmor', n(r, 'godisnji_sati')],
      ['Slobodni dani', n(r, 'slobodni_dani_sati')],
      ['Bolovanje 65%', n(r, 'bolovanje_65_sati')],
      ['Bolovanje 100% (povreda / trudnoća)', n(r, 'bolovanje_100_sati')],
      ['Rad na 2 mašine', n(r, 'dve_masine_sati')],
    ];
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(30, 30, 30);
    hourRows.forEach(([label, val], i) => {
      if (i > 1 && !val) return; // skrij prazne (osim fond/redovan)
      doc.text(label, MARGIN + 2, y);
      doc.text(fmtNum(val), PAGE_W - MARGIN - 2, y, { align: 'right' });
      y += 4.8;
    });
    doc.setFont('Roboto', 'bold');
    doc.setDrawColor(120, 120, 120);
    doc.line(MARGIN, y - 1.5, PAGE_W - MARGIN, y - 1.5);
    doc.text('Σ plaćenih sati', MARGIN + 2, y + 2.5);
    doc.text(fmtNum(n(r, 'payable_hours')), PAGE_W - MARGIN - 2, y + 2.5, { align: 'right' });
    y += 9;
  }

  // Stavke obračuna
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(50, 50, 50);
  doc.text('STAVKE OBRAČUNA', MARGIN, y);
  y += 5;
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(30, 30, 30);
  const items: [string, string][] = [];
  if (isHourly) items.push(['Satnica × Sati', `${fmtNum(n(r, 'hourly_rate'))} × ${fmtNum(n(r, 'hours_worked'))} = ${fmtRsd(n(r, 'hourly_rate') * n(r, 'hours_worked'))}`]);
  else items.push(['Fiksna plata', fmtRsd(n(r, 'fixed_salary'))]);
  if (n(r, 'transport_rsd')) items.push(['Prevoz', fmtRsd(n(r, 'transport_rsd'))]);
  if (n(r, 'domestic_days')) items.push([`Dinarske dnevnice (${n(r, 'domestic_days')} × ${fmtRsd(n(r, 'per_diem_rsd'))})`, fmtRsd(n(r, 'domestic_days') * n(r, 'per_diem_rsd'))]);
  if (n(r, 'foreign_days')) items.push([`Devizne dnevnice (${n(r, 'foreign_days')} × ${fmtNum(n(r, 'per_diem_eur'))} EUR)`, `${fmtNum(n(r, 'foreign_days') * n(r, 'per_diem_eur'))} EUR`]);
  items.forEach(([label, val]) => {
    doc.text(label, MARGIN + 2, y);
    doc.text(val, PAGE_W - MARGIN - 2, y, { align: 'right' });
    y += 4.8;
  });
  y += 4;

  // Totals kartice
  const cardW = (CONTENT_W - 8) / 3;
  const cards: [string, string, boolean][] = [
    ['UKUPNO RSD', fmtRsd(totRsd), true],
    ['UKUPNO EUR (devizno)', totEur ? `${fmtNum(totEur)} EUR` : '—', false],
    ['II deo (konačno)', fmtRsd(secRsd), false],
  ];
  cards.forEach(([lbl, val, primary], i) => {
    const x = MARGIN + i * (cardW + 4);
    if (primary) doc.setFillColor(224, 242, 254);
    else doc.setFillColor(250, 250, 250);
    doc.rect(x, y, cardW, 16, 'F');
    doc.setDrawColor(200, 200, 200);
    doc.rect(x, y, cardW, 16);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(90, 90, 90);
    doc.text(lbl, x + cardW / 2, y + 5, { align: 'center' });
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(20, 20, 20);
    doc.text(val, x + cardW / 2, y + 12, { align: 'center' });
  });
  y += 22;

  // I / II deo sa datumima
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(30, 30, 30);
  const iDeo = fmtD(s(r, 'advance_paid_on'));
  const iiDeo = fmtD(s(r, 'final_paid_on'));
  doc.text('I deo — akontacija', MARGIN + 2, y);
  doc.text(fmtRsd(n(r, 'advance_amount')), MARGIN + 90, y, { align: 'right' });
  doc.setTextColor(110, 110, 110);
  doc.text(iDeo ? `isplaćeno ${iDeo}` : 'datum: —', MARGIN + 100, y);
  y += 5;
  doc.setTextColor(30, 30, 30);
  doc.text('II deo — konačni iznos', MARGIN + 2, y);
  doc.text(fmtRsd(secRsd), MARGIN + 90, y, { align: 'right' });
  doc.setTextColor(110, 110, 110);
  doc.text(iiDeo ? `isplaćeno ${iiDeo}` : 'datum: —', MARGIN + 100, y);
  y += 8;

  if (s(r, 'note')) {
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(60, 60, 60);
    (doc.splitTextToSize(`Napomena: ${s(r, 'note')}`, CONTENT_W) as string[]).forEach((line) => { doc.text(line, MARGIN, y); y += 4.4; });
    y += 3;
  }

  const warns = Array.isArray(r.warnings) ? (r.warnings as unknown[]) : [];
  if (useK33 && warns.length) {
    doc.setTextColor(124, 45, 18);
    doc.setFontSize(9);
    doc.setFont('Roboto', 'bold');
    doc.text('⚠ Upozorenja iz obračuna:', MARGIN, y);
    y += 4.6;
    doc.setFont('Roboto', 'normal');
    warns.forEach((w) => {
      const msg = typeof w === 'object' && w ? String((w as { message?: unknown }).message ?? '') : String(w);
      (doc.splitTextToSize(`• ${msg}`, CONTENT_W - 4) as string[]).forEach((line) => { doc.text(line, MARGIN + 2, y); y += 4.2; });
    });
    y += 3;
  }

  // Potpisi
  y = Math.max(y, PAGE_H - 45);
  doc.setDrawColor(40, 40, 40);
  doc.line(MARGIN + 8, y, MARGIN + 60, y);
  doc.line(PAGE_W - MARGIN - 60, y, PAGE_W - MARGIN - 8, y);
  doc.setFontSize(8.5);
  doc.setTextColor(90, 90, 90);
  doc.text('Zaposleni — potpis', MARGIN + 34, y + 4, { align: 'center' });
  doc.text('Obračun pripremio', PAGE_W - MARGIN - 34, y + 4, { align: 'center' });
  doc.setFontSize(7.5);
  doc.setTextColor(140, 140, 140);
  const foot = 'Ovaj obračun je informativnog karaktera. Konačni iznosi se obračunavaju u skladu sa Zakonom o radu, Zakonom o porezu na dohodak građana i Zakonom o doprinosima za obavezno socijalno osiguranje.';
  (doc.splitTextToSize(foot, CONTENT_W) as string[]).forEach((line, i) => doc.text(line, MARGIN, PAGE_H - 14 + i * 3.4));
}

/** Jedan payslip → Blob. */
export async function generatePayslipPdf(input: PayslipRow): Promise<{ blob: Blob; fileName: string }> {
  const { doc, logo } = await newPdf('portrait');
  const todayStr = fmtD(new Date().toISOString().slice(0, 10));
  drawPayslip(doc, logo, input.row, input.employeeName, input.jmbg || '', todayStr);
  const period = `${MONTHS_SR_UPPER[n(input.row, 'period_month') - 1]}_${n(input.row, 'period_year')}`;
  return { blob: doc.output('blob'), fileName: `Obracun_${input.employeeName.replace(/\s+/g, '_')}_${period}.pdf` };
}

/** Više payslip-ova u jednom dokumentu (svaki na svojoj strani). */
export async function generateBulkPayslipsPdf(inputs: PayslipRow[]): Promise<{ blob: Blob; fileName: string }> {
  const { doc, logo } = await newPdf('portrait');
  const todayStr = fmtD(new Date().toISOString().slice(0, 10));
  inputs.forEach((inp, i) => {
    if (i > 0) doc.addPage();
    drawPayslip(doc, logo, inp.row, inp.employeeName, inp.jmbg || '', todayStr);
  });
  const first = inputs[0]?.row;
  const period = first ? `${MONTHS_SR_UPPER[n(first, 'period_month') - 1]}_${n(first, 'period_year')}` : '';
  return { blob: doc.output('blob'), fileName: `Obracuni_zarada_${period}.pdf` };
}

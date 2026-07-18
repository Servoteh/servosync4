// Plan montaže — PDF izveštaja montera/servisera (port 1.0 montazaIzvestajPdf.js).
// 2.0: latinica (Roboto latin-ext pokriva čćšžđ) umesto 1.0 ćirilice — na-brend sa app
// jezikom. jsPDF bundlovan; font iz /public/fonts (isti origin, radi i na LAN-u). A4.

import { jsPDF } from 'jspdf';
import { ensureRoboto } from './pdf-font';

const MARGIN = 20;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BODY_BOTTOM = PAGE_H - MARGIN;
const LINE_H = 5.2;

export interface IzvestajPdfInput {
  broj?: string;
  datum?: string;
  predmet?: string;
  naziv_projekta?: string;
  klijent?: string;
  lokacija?: string;
  monter?: string;
  dodatni_clanovi?: string[];
  pocetak?: string;
  kraj?: string;
  opis?: string;
  problemi?: string;
  otvorene?: string;
  statusLabel?: string;
  fotke: { dataUrl: string; w: number; h: number; opis?: string; redni_broj: number }[];
}

const clean = (s: string | undefined | null): string => String(s ?? '').trim();

function safePart(s: string | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(0, 40);
}

function isoDatePart(datum: string | undefined): string {
  const m = String(datum || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const iso = String(datum || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return '';
}

function buildFileName(d: IzvestajPdfInput): string {
  return (
    [
      isoDatePart(d.datum) || 'izvestaj',
      'SERVOTEH',
      safePart(d.predmet || d.naziv_projekta || 'predmet'),
      safePart(d.lokacija || 'lokacija'),
      safePart(d.monter || 'monter'),
    ]
      .filter(Boolean)
      .join('_') + '.pdf'
  );
}

/** Generiše PDF izveštaja → {blob, fileName} (za upload + preuzimanje). */
export async function generateIzvestajPdf(d: IzvestajPdfInput): Promise<{ blob: Blob; fileName: string }> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  await ensureRoboto(doc);

  const st = { y: MARGIN };
  const pageBreak = (need: number) => {
    if (st.y + need > BODY_BOTTOM) {
      doc.addPage();
      st.y = MARGIN;
    }
  };

  // Zaglavlje
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(20, 20, 20);
  doc.text('SERVOTEH d.o.o.', MARGIN, st.y + 3);
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(110, 110, 110);
  doc.text('Complete Automation', PAGE_W - MARGIN, st.y + 3, { align: 'right' });
  st.y += 12;

  // Naslov
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(15, 15, 15);
  doc.text('IZVEŠTAJ MONTERA / SERVISERA', PAGE_W / 2, st.y, { align: 'center' });
  st.y += 5;
  if (d.broj) {
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(120, 120, 120);
    doc.text(String(d.broj), PAGE_W / 2, st.y, { align: 'center' });
    st.y += 4;
  }
  doc.setDrawColor(210, 210, 210);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, st.y, PAGE_W - MARGIN, st.y);
  st.y += 6;

  // Meta blok
  const LBL_W = 44;
  const metaRow = (label: string, value: string | undefined) => {
    const val = clean(value);
    doc.setFontSize(10);
    doc.setFont('Roboto', 'normal');
    const valLines = doc.splitTextToSize(val || '—', CONTENT_W - LBL_W);
    pageBreak(Math.max(LINE_H, valLines.length * LINE_H) + 0.5);
    doc.setFont('Roboto', 'bold');
    doc.setTextColor(60, 60, 60);
    doc.text(label, MARGIN, st.y);
    doc.setFont('Roboto', 'normal');
    doc.setTextColor(20, 20, 20);
    valLines.forEach((ln: string, i: number) => doc.text(ln, MARGIN + LBL_W, st.y + i * LINE_H));
    st.y += Math.max(LINE_H, valLines.length * LINE_H) + 0.5;
  };

  metaRow('Datum:', d.datum);
  metaRow('Predmet / projekat:', [d.predmet, d.naziv_projekta].filter(Boolean).join(' — '));
  metaRow('Klijent:', d.klijent);
  metaRow('Lokacija rada:', d.lokacija);
  metaRow('Monter / Serviser:', d.monter);
  if (d.dodatni_clanovi && d.dodatni_clanovi.length) {
    metaRow('Dodatni članovi tima:', d.dodatni_clanovi.join(', '));
  }
  metaRow('Početak rada:', d.pocetak);
  metaRow('Kraj rada:', d.kraj);
  st.y += 2;

  // Sekcije
  const section = (title: string, body: string | undefined) => {
    const txt = clean(body);
    if (!txt) return;
    pageBreak(LINE_H * 2);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 15, 15);
    doc.text(title, MARGIN, st.y);
    st.y += LINE_H + 0.5;
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(25, 25, 25);
    const lines = doc.splitTextToSize(txt, CONTENT_W);
    lines.forEach((ln: string) => {
      pageBreak(LINE_H + 1);
      doc.text(ln, MARGIN, st.y);
      st.y += LINE_H;
    });
    st.y += 3;
  };

  section('Opis izvedenih radova', d.opis);
  section('Problemi / odstupanja', d.problemi);
  section('Otvorene stavke / napomena', d.otvorene);

  // Foto-dokumentacija
  const fotke = (d.fotke || []).filter((f) => f?.dataUrl);
  if (fotke.length) {
    pageBreak(LINE_H * 2);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 15, 15);
    doc.text('Foto-dokumentacija', MARGIN, st.y);
    st.y += LINE_H + 1;

    fotke.forEach((f, i) => {
      const ratio = f.w && f.h ? f.w / f.h : 1.5;
      let dispW = CONTENT_W;
      let dispH = dispW / ratio;
      const MAX_H = 105;
      if (dispH > MAX_H) {
        dispH = MAX_H;
        dispW = dispH * ratio;
      }
      const capLines = doc.splitTextToSize(`${i + 1}. ${clean(f.opis)}`.trim(), CONTENT_W);
      pageBreak(dispH + 2 + capLines.length * LINE_H + 4);
      const x = MARGIN + (CONTENT_W - dispW) / 2;
      try {
        doc.addImage(f.dataUrl, 'JPEG', x, st.y, dispW, dispH);
      } catch {
        /* preskoči neispravnu sliku */
      }
      st.y += dispH + 2;
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(90, 90, 90);
      capLines.forEach((ln: string) => {
        doc.text(ln, MARGIN, st.y);
        st.y += LINE_H;
      });
      st.y += 3;
    });
  }

  // Status
  pageBreak(LINE_H * 2);
  st.y += 1;
  doc.setDrawColor(210, 210, 210);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, st.y, PAGE_W - MARGIN, st.y);
  st.y += 6;
  doc.setFont('Roboto', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 15, 15);
  doc.text('Status: ', MARGIN, st.y);
  const statW = doc.getTextWidth('Status: ');
  doc.setFont('Roboto', 'normal');
  doc.setTextColor(20, 20, 20);
  doc.text(clean(d.statusLabel), MARGIN + statW, st.y);

  // Footer
  const total = doc.internal.pages.length - 1;
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(`SERVOTEH · ${d.broj || ''}`, MARGIN, PAGE_H - 8);
    doc.text(`${i} / ${total}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
  }

  return { blob: doc.output('blob'), fileName: buildFileName(d) };
}

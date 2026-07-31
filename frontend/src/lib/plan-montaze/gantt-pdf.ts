// Plan montaže — Gantt PDF (jsPDF-native, BEZ html2canvas). Crta dan-mrežu + trake
// direktno (vektorski, oštro — bolje od 1.0 rasterizovanog screenshot-a). Podrazumevano A4
// landscape, multi-page: dan-chunkovi (horizontalno) × red-chunkovi (vertikalno).
// Uz `opts.singlePage` (Ukupan gant) — jedna strana custom formata po meri sadržaja.
// Boje = lokacija faze.

import { jsPDF } from 'jspdf';
import type { GanttRow } from '@/app/montaza/_components/gantt-chart';
import { ensureRoboto, hexToRgb } from './pdf-font';
import { buildMonthsHeader } from './gantt';
import { parseDateLocal } from './date';
import { locationColor, phaseStatusBadge } from './phase';
import { STATUSES } from './constants';

const A4_W = 297;
const A4_H = 210;
const M = 10;
const BASE_LABEL_W = 60;
const BASE_DAY_W = 4;
const BASE_ROW_H = 6;
const BASE_HEAD_H = 12;
const FOOTER_H = 8;
/** jsPDF/PDF praktičan gornji limit dimenzije stranice (mm). */
const MAX_MM = 3000;
/** Ispod ovoga tekst postaje nečitljiv — dalje se ne smanjuje. */
const MIN_FONT_PT = 3.5;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function todayMs(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Generiši Gantt PDF (download preko doc.save).
 * `opts.singlePage` — cela mreža na JEDNU stranu: format se računa po sadržaju
 * (custom mm format), a ako bi prešao MAX_MM primenjuje se uniformno skaliranje.
 */
export async function generateGanttPdf(
  title: string,
  days: Date[],
  rows: GanttRow[],
  opts?: { singlePage?: boolean },
): Promise<void> {
  const singlePage = opts?.singlePage === true;

  // Skaliranje: 1 za A4 režim; kod single-page samo ako sadržaj probija MAX_MM.
  let scale = 1;
  if (singlePage) {
    const wNeed = BASE_LABEL_W + Math.max(days.length, 1) * BASE_DAY_W;
    const hNeed = BASE_HEAD_H + Math.max(rows.length, 1) * BASE_ROW_H + FOOTER_H;
    scale = Math.min(1, (MAX_MM - M * 2) / wNeed, (MAX_MM - M * 2) / hNeed);
  }
  const LABEL_W = BASE_LABEL_W * scale;
  const DAY_W = BASE_DAY_W * scale;
  const ROW_H = BASE_ROW_H * scale;
  const HEAD_H = BASE_HEAD_H * scale;
  /** Font uz skaliranje, ali nikad ispod granice čitljivosti. */
  const fs = (pt: number) => Math.max(MIN_FONT_PT, pt * scale);

  let pageW = A4_W;
  let pageH = A4_H;
  if (singlePage) {
    pageW = M * 2 + LABEL_W + Math.max(days.length, 1) * DAY_W;
    pageH = M * 2 + HEAD_H + Math.max(rows.length, 1) * ROW_H + FOOTER_H;
  }

  const doc = singlePage
    ? new jsPDF({ orientation: pageW >= pageH ? 'landscape' : 'portrait', unit: 'mm', format: [pageW, pageH] })
    : new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  await ensureRoboto(doc);

  const DAYS_PER_PAGE = singlePage
    ? Math.max(days.length, 1)
    : Math.floor((A4_W - M * 2 - LABEL_W) / DAY_W);
  const ROWS_PER_PAGE = singlePage
    ? Math.max(rows.length, 1)
    : Math.floor((A4_H - M * 2 - HEAD_H) / ROW_H);

  const tMs = todayMs();
  const dayChunks = chunk(days, DAYS_PER_PAGE);
  const rowChunks = chunk(rows, ROWS_PER_PAGE);
  let first = true;

  for (let dc = 0; dc < dayChunks.length; dc++) {
    const chDays = dayChunks[dc];
    const dayBaseIdx = dc * DAYS_PER_PAGE;
    const months = buildMonthsHeader(chDays);

    for (let rc = 0; rc < rowChunks.length; rc++) {
      if (!first) doc.addPage();
      first = false;
      const chRows = rowChunks[rc];

      // ── Naslov (samo prva vertikalna stranica u chunk-u) ──
      const daysX = M + LABEL_W;

      // Label header + „Faza"
      doc.setFillColor(240, 243, 243);
      doc.rect(M, M, LABEL_W, HEAD_H, 'F');
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(fs(7));
      doc.setTextColor(90, 90, 90);
      doc.text(title, M + 2 * scale, M + HEAD_H * 0.58);

      // Mesečni red
      const bandH = HEAD_H / 2;
      let mx = daysX;
      doc.setFontSize(fs(6.5));
      for (const mSpan of months) {
        const w = mSpan.count * DAY_W;
        doc.setFillColor(240, 243, 243);
        doc.rect(mx, M, w, bandH, 'F');
        doc.setDrawColor(220, 224, 224);
        doc.rect(mx, M, w, bandH, 'S');
        doc.setTextColor(90, 90, 90);
        doc.text(mSpan.label, mx + w / 2, M + bandH * 0.67, { align: 'center' });
        mx += w;
      }

      // Dnevni red (broj + vikend + danas)
      doc.setFontSize(fs(5.5));
      chDays.forEach((d, i) => {
        const x = daysX + i * DAY_W;
        const isW = d.getDay() === 0 || d.getDay() === 6;
        const isT = d.getTime() === tMs;
        if (isW) {
          doc.setFillColor(238, 241, 242);
          doc.rect(x, M + bandH, DAY_W, bandH, 'F');
        }
        if (isT) {
          doc.setDrawColor(13, 148, 136);
          doc.setLineWidth(0.6 * scale);
          doc.line(x, M + bandH, x, M + HEAD_H + chRows.length * ROW_H);
          doc.setLineWidth(0.2);
        }
        doc.setTextColor(120, 120, 120);
        doc.text(String(d.getDate()), x + DAY_W / 2, M + HEAD_H * 0.875, { align: 'center' });
      });

      // ── Redovi ──
      let y = M + HEAD_H;
      for (const row of chRows) {
        if (row.kind === 'group') {
          doc.setFillColor(235, 238, 238);
          doc.rect(M, y, LABEL_W + chDays.length * DAY_W, ROW_H, 'F');
          doc.setFont('Roboto', 'bold');
          doc.setFontSize(fs(6.5));
          doc.setTextColor(40, 40, 40);
          const gl = doc.splitTextToSize(`${row.label}${row.sub ? ' · ' + row.sub : ''}`, LABEL_W + chDays.length * DAY_W - 4 * scale);
          doc.text(gl[0], M + 2 * scale, y + ROW_H * 0.67);
        } else {
          const p = row.phase;
          const color = hexToRgb(locationColor(p.location));
          // Label
          doc.setDrawColor(color[0], color[1], color[2]);
          doc.setLineWidth(0.8 * scale);
          doc.line(M, y + 0.1 * ROW_H, M, y + ROW_H * 0.9);
          doc.setLineWidth(0.2);
          doc.setFont('Roboto', 'normal');
          doc.setFontSize(fs(6));
          doc.setTextColor(30, 30, 30);
          const nm = doc.splitTextToSize(p.phaseName || '—', LABEL_W - 4 * scale);
          doc.text(nm[0], M + 2 * scale, y + ROW_H * 0.5);
          doc.setFontSize(fs(5));
          doc.setTextColor(120, 120, 120);
          const badge = phaseStatusBadge(p.status);
          doc.text(`${p.location || '—'} · ${STATUSES[p.status] ?? badge.label} ${p.pct}%`, M + 2 * scale, y + ROW_H * 0.9);

          // Trake
          const sMs = parseDateLocal(p.startDate)?.getTime() ?? null;
          const eMs = parseDateLocal(p.endDate)?.getTime() ?? null;
          if (sMs !== null && eMs !== null) {
            chDays.forEach((d, i) => {
              const dm = d.getTime();
              if (dm >= sMs && dm <= eMs) {
                const x = daysX + i * DAY_W;
                doc.setFillColor(color[0], color[1], color[2]);
                doc.rect(x + 0.2 * scale, y + ROW_H / 6, DAY_W - 0.4 * scale, ROW_H * (2 / 3), 'F');
              }
            });
          }
        }
        // grid linija
        doc.setDrawColor(232, 236, 236);
        doc.line(M, y + ROW_H, M + LABEL_W + chDays.length * DAY_W, y + ROW_H);
        y += ROW_H;
      }

      // Footer
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(fs(6));
      doc.setTextColor(150, 150, 150);
      doc.text(`SERVOTEH · ${title}`, M, pageH - 4);
      if (!singlePage) {
        doc.text(`str. ${dc * rowChunks.length + rc + 1}`, pageW - M, pageH - 4, { align: 'right' });
      }
    }
  }

  const slug = title.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40);
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  doc.save(`gantt_${slug}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.pdf`);
}

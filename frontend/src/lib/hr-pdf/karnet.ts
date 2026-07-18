import { newPdf, drawLogo, safeName } from './pdf-core';

// Karnet (mesečni radni list) — PDF, landscape A4, ćirilica + logo.
// Port 1.0 `src/lib/karnetPdf.js`: jedan zaposleni po strani, dnevna tabela
// (redovni / prekovremeni / teren / 2-mašine / odsustvo) + zbirni blok.
// Zbir po kategorijama dolazi iz pozivaoca (`totals`) — 2.0 engine je BE R2;
// FE prosleđuje agregate iz grida.

export interface KarnetDay {
  ymd: string; // YYYY-MM-DD
  day: number;
  letter?: string; // ćir. oznaka dana (П, У, С, Ч, П, С, Н)
}

export interface KarnetRow {
  hours?: number | string | null;
  overtimeHours?: number | string | null;
  fieldHours?: number | string | null;
  twoMachineHours?: number | string | null;
  absenceCode?: string | null;
  absenceSubtype?: string | null;
}

export interface KarnetTotals {
  redovanRadSati?: number;
  prekovremeniSati?: number;
  praznikRadSati?: number;
  praznikPlaceniSati?: number;
  dveMasineSati?: number;
  godisnjiSati?: number;
  slobodniDaniSati?: number;
  bolovanje65Sati?: number;
  bolovanje100Sati?: number;
  neplacenoDays?: number;
}

export interface KarnetEmployee {
  name: string;
  position?: string;
  workTypeLabel?: string;
  rows: Map<string, KarnetRow>;
  totals?: KarnetTotals;
  fieldHours?: number;
}

export interface KarnetInput {
  title: string; // npr. "КАРНЕТ — јун 2026."
  monthLabel: string; // ćir. mesec + godina
  days: KarnetDay[];
  holidayYmdSet?: Set<string>;
  employees: KarnetEmployee[];
}

/** grid absence_code (+subtype) → kratka ćir. oznaka za Karnet. */
function absLabel(code?: string | null, subtype?: string | null): string {
  const c = String(code || '').toLowerCase();
  const s = String(subtype || '').toLowerCase();
  switch (c) {
    case 'go': return 'ГО (год. одмор)';
    case 'bo':
      if (s === 'povreda_na_radu') return 'БО 100% (повреда)';
      if (s === 'odrzavanje_trudnoce') return 'БО 100% (трудноћа)';
      return 'БО 65%';
    case 'sp': return 'СП (служб. пут)';
    case 'pl': return 'ПО (плаћено)';
    case 'sv': return 'Слава';
    case 'sl': return 'Слободан дан';
    case 'nop': return 'НОП (неплаћено)';
    case 'np': return 'НП (неоправдано)';
    case 'pr': return 'Празан дан';
    default: return '';
  }
}

function num(n: number | string | undefined | null): number { return Number(n || 0); }
function h1(n: number | string | undefined | null): string { const v = num(n); return v ? (Math.round(v * 100) / 100).toString() : ''; }

const MARGIN = 12;
const PAGE_W = 297;
const PAGE_H = 210;

export async function generateKarnetPdf(args: KarnetInput): Promise<{ blob: Blob; fileName: string }> {
  const { title, monthLabel, days, employees } = args;
  const hol = args.holidayYmdSet instanceof Set ? args.holidayYmdSet : new Set<string>();
  const { doc, logo } = await newPdf('landscape');

  const COLS = [
    { key: 'dan', label: 'Дан', w: 18, align: 'left' as const },
    { key: 'reg', label: 'Редовни', w: 20, align: 'right' as const },
    { key: 'ot', label: 'Прековр.', w: 20, align: 'right' as const },
    { key: 'field', label: 'Терен', w: 18, align: 'right' as const },
    { key: 'tm', label: '2-маш.', w: 16, align: 'right' as const },
    { key: 'abs', label: 'Одсуство', w: 42, align: 'left' as const },
  ];
  const TABLE_W = COLS.reduce((a, c) => a + c.w, 0);
  const ROW_H = 4.7;

  function cellValue(key: string, e: KarnetRow): string {
    switch (key) {
      case 'reg': return h1(e.hours);
      case 'ot': return h1(e.overtimeHours);
      case 'field': return h1(e.fieldHours);
      case 'tm': return h1(e.twoMachineHours);
      default: return '';
    }
  }

  function drawEmployeePage(emp: KarnetEmployee, isFirst: boolean) {
    if (!isFirst) doc.addPage();
    let y = MARGIN;

    drawLogo(doc, logo, MARGIN, y, 11, 42);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(20, 20, 20);
    doc.text(title || 'КАРНЕТ', PAGE_W - MARGIN, y + 5, { align: 'right' });
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(110, 110, 110);
    doc.text('СЕРВОТЕХ д.о.о. · Угриновачка 163, Добановци', PAGE_W - MARGIN, y + 9.5, { align: 'right' });
    y += 15;

    doc.setFont('Roboto', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(20, 20, 20);
    doc.text(emp.name || '', MARGIN, y);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(90, 90, 90);
    const sub = [emp.position, emp.workTypeLabel, monthLabel].filter(Boolean).join('  ·  ');
    doc.text(sub, MARGIN, y + 5);
    y += 10;

    const tableX = MARGIN;
    const drawHeaderRow = (yy: number) => {
      doc.setFillColor(237, 242, 247);
      doc.rect(tableX, yy, TABLE_W, ROW_H + 1, 'F');
      doc.setFont('Roboto', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(40, 40, 40);
      let x = tableX;
      COLS.forEach((c) => {
        const tx = c.align === 'right' ? x + c.w - 1.5 : x + 1.5;
        doc.text(c.label, tx, yy + ROW_H - 0.6, { align: c.align === 'right' ? 'right' : 'left' });
        x += c.w;
      });
      return yy + ROW_H + 1;
    };
    y = drawHeaderRow(y);

    doc.setFontSize(8);
    days.forEach((d) => {
      const [yy, mm, dd] = d.ymd.split('-').map(Number);
      const dt = new Date(yy, mm - 1, dd);
      const dow = dt.getDay();
      const weekend = dow === 0 || dow === 6;
      const isHol = hol.has(d.ymd);
      const e = emp.rows.get(d.ymd) || {};
      const code = e.absenceCode || null;

      if (weekend || isHol) {
        doc.setFillColor(isHol ? 252 : 247, isHol ? 243 : 249, isHol ? 243 : 251);
        doc.rect(tableX, y, TABLE_W, ROW_H, 'F');
      }

      let x = tableX;
      const cells: Record<string, string> = {
        dan: `${d.day}. ${d.letter || ''}${isHol ? ' ★' : ''}`,
        abs: code ? absLabel(code, e.absenceSubtype) : '',
      };
      doc.setFont('Roboto', 'normal');
      doc.setTextColor(code ? 120 : 30, code ? 90 : 30, 30);
      COLS.forEach((c) => {
        const tx = c.align === 'right' ? x + c.w - 1.5 : x + 1.5;
        const val = c.key === 'dan' || c.key === 'abs' ? cells[c.key] : cellValue(c.key, e);
        if (val) doc.text(String(val), tx, y + ROW_H - 0.8, { align: c.align === 'right' ? 'right' : 'left' });
        x += c.w;
      });
      doc.setDrawColor(225, 228, 232);
      doc.line(tableX, y + ROW_H, tableX + TABLE_W, y + ROW_H);
      y += ROW_H;
    });

    doc.setDrawColor(150, 150, 150);
    doc.rect(tableX, MARGIN + 25, TABLE_W, y - (MARGIN + 25));

    const t = emp.totals || {};
    const sumX = tableX + TABLE_W + 10;
    let sy = MARGIN + 25;
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(20, 20, 20);
    doc.text('Месечни зброј (часови)', sumX, sy);
    sy += 6;
    const rows: [string, number | undefined][] = [
      ['Редован рад', t.redovanRadSati],
      ['Прековремени', t.prekovremeniSati],
      ['Рад на празник', t.praznikRadSati],
      ['Плаћени празник', t.praznikPlaceniSati],
      ['Теренски рад', emp.fieldHours],
      ['Две машине', t.dveMasineSati],
      ['Годишњи одмор', t.godisnjiSati],
      ['Слободни/плаћено', t.slobodniDaniSati],
      ['Боловање 65%', t.bolovanje65Sati],
      ['Боловање 100%', t.bolovanje100Sati],
    ];
    doc.setFontSize(9);
    rows.forEach(([label, val]) => {
      doc.setFont('Roboto', 'normal');
      doc.setTextColor(70, 70, 70);
      doc.text(label, sumX, sy);
      doc.setFont('Roboto', 'bold');
      doc.setTextColor(20, 20, 20);
      doc.text(`${h1(val) || '0'} h`, sumX + 70, sy, { align: 'right' });
      sy += 5.4;
    });
    sy += 1;
    doc.setDrawColor(150, 150, 150);
    doc.line(sumX, sy, sumX + 70, sy);
    sy += 5;
    const totalRad = num(t.redovanRadSati) + num(t.prekovremeniSati) + num(t.praznikRadSati);
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(20, 20, 20);
    doc.text('Укупно рад (ред+прек+празн.)', sumX, sy);
    doc.text(`${h1(totalRad) || '0'} h`, sumX + 70, sy, { align: 'right' });
    sy += 6;
    if (num(t.neplacenoDays)) {
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(180, 60, 60);
      doc.text(`Неплаћени дани: ${num(t.neplacenoDays)}`, sumX, sy);
      sy += 6;
    }

    let py = Math.max(y, sy) + 12;
    if (py > PAGE_H - 24) py = PAGE_H - 24;
    const colL = sumX;
    const colR = sumX + 60;
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(40, 40, 40);
    doc.line(colL, py, colL + 45, py);
    doc.line(colR, py, colR + 45, py);
    doc.text('Запослени', colL, py + 4);
    doc.text('Овлашћено лице', colR, py + 4);
  }

  employees.forEach((emp, i) => drawEmployeePage(emp, i === 0));

  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(150, 150, 150);
    doc.text(title || 'Карнет', MARGIN, PAGE_H - 5);
    doc.text(`${i} / ${total}`, PAGE_W - MARGIN, PAGE_H - 5, { align: 'right' });
  }

  return { blob: doc.output('blob'), fileName: `Karnet_${safeName(monthLabel, 'mesec')}.pdf` };
}

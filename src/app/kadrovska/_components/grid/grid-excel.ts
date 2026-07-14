import * as XLSX from 'xlsx';
import { gridFormatNum, gridAbsCellLabel, type GridDay } from '@/lib/grid-utils';
import { gridRedovniUnitsOneDay } from '@/lib/grid-payroll';
import type { GridEffective } from './use-grid-editor';

const SR_MONTHS_UPPER = ['JANUAR', 'FEBRUAR', 'MART', 'APRIL', 'MAJ', 'JUN', 'JUL', 'AVGUST', 'SEPTEMBAR', 'OKTOBAR', 'NOVEMBAR', 'DECEMBAR'];

interface XlsxEmp {
  id: string;
  name: string;
  deptSub: string;
  position: string;
  workType: string;
}

/** Pun mesečni obrazac .xlsx (4 reda/radnik + UKUPNO + teren/2-maš breakdown). Port _exportToXlsx. */
export function exportGridXlsx(args: {
  year: number;
  month: number;
  employees: XlsxEmp[];
  days: GridDay[];
  holidaySet: Set<string>;
  getEff: (empId: string, ymd: string) => GridEffective;
}): void {
  const { year, month, employees, days, holidaySet, getEff } = args;
  const monthLabel = `${SR_MONTHS_UPPER[month - 1]} ${year}`;
  const aoa: (string | number)[][] = [];

  aoa.push([monthLabel]);
  aoa.push([]);
  aoa.push(['#', 'Ime i prezime', 'Odeljenje — pododeljenje', 'Pozicija', 'Tip', ...days.map((d) => d.day), 'Σ']);
  aoa.push(['', '', '', '', '', ...days.map((d) => d.letter), '']);

  const colTotals = days.map(() => ({ reg: 0, ot: 0, field: 0, tm: 0 }));
  const grand = { reg: 0, ot: 0, field: 0, tm: 0, fdom: 0, ffor: 0, fdomDays: 0, fforDays: 0, tmDays: 0 };

  employees.forEach((emp, idx) => {
    const regRow: (string | number)[] = [idx + 1, emp.name, emp.deptSub, emp.position, 'Redovni'];
    const otRow: (string | number)[] = ['', '', '', '', 'Prekov.'];
    const fieldRow: (string | number)[] = ['', '', '', '', 'Teren'];
    const tmRow: (string | number)[] = ['', '', '', '', '2 maš.'];
    let sR = 0;
    let sO = 0;
    let sF = 0;
    let sTm = 0;

    days.forEach((d, di) => {
      const eff = getEff(emp.id, d.ymd);
      const regUnits = gridRedovniUnitsOneDay(d.ymd, eff, holidaySet, { workType: emp.workType });
      sR += regUnits;
      const ot = Number(eff.overtime_hours || 0);
      sO += ot;
      const fh = Number(eff.field_hours || 0);
      sF += fh;
      const tm = Number(eff.two_machine_hours || 0);
      sTm += tm;

      regRow.push(eff.absence_code ? gridAbsCellLabel(eff.absence_code, eff.absence_subtype) : eff.hours || '');
      otRow.push(ot || '');
      fieldRow.push(fh > 0 ? gridFormatNum(fh) + (eff.field_subtype === 'foreign' ? ' I' : '') : '');
      tmRow.push(tm || '');

      colTotals[di].reg += regUnits;
      colTotals[di].ot += ot;
      colTotals[di].field += fh;
      colTotals[di].tm += tm;
      grand.reg += regUnits;
      grand.ot += ot;
      grand.field += fh;
      grand.tm += tm;
      if (fh > 0) {
        if (eff.field_subtype === 'foreign') {
          grand.ffor += fh;
          grand.fforDays += 1;
        } else {
          grand.fdom += fh;
          grand.fdomDays += 1;
        }
      }
      if (tm > 0) grand.tmDays += 1;
    });

    regRow.push(round2(sR));
    otRow.push(round2(sO));
    fieldRow.push(round2(sF));
    tmRow.push(round2(sTm));
    aoa.push(regRow, otRow, fieldRow, tmRow);
  });

  aoa.push([]);
  const mkTotal = (label: string, key: 'reg' | 'ot' | 'field' | 'tm'): (string | number)[] => [
    '',
    'UKUPNO',
    '',
    '',
    label,
    ...colTotals.map((c) => round2(c[key]) || ''),
    round2(grand[key]),
  ];
  aoa.push(mkTotal('Redovni', 'reg'), mkTotal('Prekov.', 'ot'), mkTotal('Teren', 'field'), mkTotal('2 maš.', 'tm'));

  aoa.push([]);
  aoa.push(['', 'TEREN BREAKDOWN', 'Domaći (h)', round2(grand.fdom), '', '', 'Domaći (dani)', grand.fdomDays]);
  aoa.push(['', '', 'Inostrani (h)', round2(grand.ffor), '', '', 'Inostrani (dani)', grand.fforDays]);
  aoa.push(['', 'RAD NA 2 MAŠINE', 'Sati', round2(grand.tm), '', '', 'Dani', grand.tmDays]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 5 }, { wch: 26 }, { wch: 28 }, { wch: 22 }, { wch: 9 }, ...days.map(() => ({ wch: 4 })), { wch: 7 }];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: days.length + 6 } }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, monthLabel.slice(0, 31));
  XLSX.writeFile(wb, `Sati_${year}-${String(month).padStart(2, '0')}.xlsx`);
}

function round2(v: number): number {
  return Math.round(Number(v || 0) * 100) / 100;
}

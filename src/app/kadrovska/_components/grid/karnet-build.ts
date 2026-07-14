import { generateKarnetPdf, openBlob, downloadBlob, type KarnetEmployee } from '@/lib/hr-pdf';
import { aggregateWorkHoursForMonth, type RowLike } from '@/lib/grid-payroll';
import { gridWorkTypeLabel, type GridDay } from '@/lib/grid-utils';
import { cyrMonthLabel, dayLetterCyr } from '../common';
import type { GridEffective } from './use-grid-editor';

interface KarnetEmpInput {
  id: string;
  name: string;
  position: string;
  workType: string;
  hireDate: string | null;
}

/** Build KarnetEmployee[] (dirty-merged) sa PUNIM payrollCalc agregatom. Port buildKarnetEmployees. */
export function buildKarnetEmployees(args: {
  year: number;
  month: number;
  employees: KarnetEmpInput[];
  days: GridDay[];
  holidaySet: Set<string>;
  getEff: (empId: string, ymd: string) => GridEffective;
}): KarnetEmployee[] {
  const { year, month, employees, days, holidaySet, getEff } = args;
  return employees.map((emp) => {
    const rows = new Map<string, RowLike>();
    let fieldHours = 0;
    for (const d of days) {
      const eff = getEff(emp.id, d.ymd);
      // camelCase KarnetRow za PDF (renderer čita camelCase)
      rows.set(d.ymd, {
        hours: eff.hours,
        overtimeHours: eff.overtime_hours,
        fieldHours: eff.field_hours,
        twoMachineHours: eff.two_machine_hours,
        absenceCode: eff.absence_code,
        absenceSubtype: eff.absence_subtype,
      });
      fieldHours += Number(eff.field_hours || 0);
    }
    const totals = aggregateWorkHoursForMonth(year, month, rows, holidaySet, { workType: emp.workType, hireDate: emp.hireDate });
    return {
      name: emp.name,
      position: emp.position,
      workTypeLabel: gridWorkTypeLabel(emp.workType),
      rows: rows as unknown as KarnetEmployee['rows'],
      totals,
      fieldHours,
    };
  });
}

/** Karnet PDF za prikazane radnike (dirty-merged) → otvori + preuzmi. */
export async function exportKarnetPdf(args: {
  year: number;
  month: number;
  employees: KarnetEmpInput[];
  days: GridDay[];
  holidaySet: Set<string>;
  getEff: (empId: string, ymd: string) => GridEffective;
}): Promise<void> {
  const monthLabel = cyrMonthLabel(args.year, args.month);
  const days = args.days.map((d) => ({ ymd: d.ymd, day: d.day, letter: dayLetterCyr(d.ymd) }));
  const employees = buildKarnetEmployees(args);
  const { blob, fileName } = await generateKarnetPdf({
    title: `КАРНЕТ — ${monthLabel}`,
    monthLabel,
    days,
    holidayYmdSet: args.holidaySet,
    employees,
  });
  openBlob(blob);
  downloadBlob(blob, fileName);
}

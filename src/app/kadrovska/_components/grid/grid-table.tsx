'use client';

import { memo, useMemo, type MouseEvent } from 'react';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import type { GridDay } from '@/lib/grid-utils';
import { gridFormatSum, gridWorkTypeLabel } from '@/lib/grid-utils';
import { gridPayableHoursForEmployee, gridRedovniUnitsOneDay, type RowLike } from '@/lib/grid-payroll';
import type { WorkHours } from '@/api/kadrovska';
import type { CellKind, GridEditor, GridEffective } from './use-grid-editor';

export interface GridEmployee {
  id: string;
  name: string;
  position: string;
  deptSub: string;
  workType: string;
}

export interface DayTotals {
  reg: number;
  ot: number;
  field: number;
  tm: number;
}

interface GridTableProps {
  days: GridDay[];
  pageEmployees: GridEmployee[];
  holidaySet: Set<string>;
  todayYmd: string;
  editor: GridEditor;
  serialStart: number;
  payableMap: Map<string, number>;
  getDbRow: (empId: string, ymd: string) => WorkHours | undefined;
  dayTotals: DayTotals[];
  grandTotals: DayTotals;
  onCellContext: (empId: string, ymd: string, kind: CellKind, name: string, ev: MouseEvent) => void;
  onRowAction: (empId: string, action: string) => void;
}

/** Boje šifri odsustva (tokeni). */
function absTone(code: string | null, subtype: string | null): string {
  switch (code) {
    case 'go':
      return 'bg-status-info-bg text-status-info';
    case 'bo':
      return subtype === 'povreda_na_radu' || subtype === 'odrzavanje_trudnoce'
        ? 'bg-status-warn-bg text-status-warn font-semibold'
        : 'bg-status-warn-bg text-status-warn';
    case 'sp':
      return 'bg-surface-2 text-ink-secondary';
    case 'sl':
    case 'sv':
    case 'pl':
      return 'bg-status-success-bg text-status-success';
    case 'np':
    case 'pr':
      return 'bg-status-neutral-bg text-ink-secondary';
    case 'nop':
      return 'bg-status-danger-bg text-status-danger';
    default:
      return '';
  }
}

const cellBase =
  'h-7 w-11 shrink-0 border-r border-line-soft bg-transparent px-1 text-center text-xs tabular-nums text-ink outline-none focus:bg-accent-subtle disabled:cursor-default disabled:text-ink-secondary';

export const GridTable = memo(function GridTable(props: GridTableProps) {
  const { days, pageEmployees, dayTotals, grandTotals } = props;

  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="border-collapse text-xs" style={{ minWidth: 'max-content' }}>
        <thead className="sticky top-0 z-10">
          <tr className="bg-surface-2">
            <th className="sticky left-0 z-20 h-8 w-8 border-b border-r border-line bg-surface-2 text-2xs text-ink-secondary">#</th>
            <th className="sticky left-8 z-20 h-8 w-52 border-b border-r border-line bg-surface-2 px-2 text-left text-2xs text-ink-secondary">
              Ime i prezime
            </th>
            <th className="h-8 w-16 border-b border-r border-line bg-surface-2 px-1 text-left text-2xs text-ink-secondary">Vrsta</th>
            {days.map((d) => (
              <th
                key={d.ymd}
                className={cn(
                  'h-8 w-11 border-b border-r border-line-soft text-2xs font-semibold text-ink-secondary',
                  d.isWeekend && 'bg-surface-2',
                  props.holidaySet.has(d.ymd) && 'bg-status-danger-bg text-status-danger',
                  d.ymd === props.todayYmd && 'ring-1 ring-inset ring-accent',
                )}
                title={props.holidaySet.has(d.ymd) ? 'Državni praznik' : ''}
              >
                <div>{d.day}</div>
                <div className="font-normal opacity-70">{d.letter}</div>
              </th>
            ))}
            <th className="h-8 w-14 border-b border-line bg-surface-2 px-1 text-2xs text-ink-secondary">Σ</th>
          </tr>
        </thead>
        <tbody>
          {pageEmployees.map((emp, i) => (
            <EmployeeBlock
              key={emp.id}
              emp={emp}
              serial={props.serialStart + i + 1}
              days={days}
              holidaySet={props.holidaySet}
              todayYmd={props.todayYmd}
              editor={props.editor}
              editorRev={props.editor.revs[emp.id] || 0}
              structRev={props.editor.structRev}
              payableBase={props.payableMap.get(emp.id)}
              getDbRow={props.getDbRow}
              onCellContext={props.onCellContext}
              onRowAction={props.onRowAction}
            />
          ))}
        </tbody>
        <tfoot className="sticky bottom-0 z-10">
          {(['reg', 'ot', 'field', 'tm'] as const).map((kind) => (
            <tr key={kind} className="bg-surface-2 font-semibold">
              <td className="sticky left-0 z-20 border-t border-r border-line bg-surface-2" />
              <td className="sticky left-8 z-20 border-t border-r border-line bg-surface-2 px-2 text-2xs uppercase text-ink-secondary" colSpan={2}>
                {kind === 'reg' ? 'UKUPNO Redovni' : kind === 'ot' ? 'UKUPNO Prekov.' : kind === 'field' ? 'UKUPNO Teren' : 'UKUPNO 2 maš.'}
              </td>
              {days.map((d, di) => (
                <td key={d.ymd} className={cn('border-t border-r border-line-soft text-center text-2xs tabular-nums text-ink', d.isWeekend && 'bg-surface-2')}>
                  {dayTotals[di] && dayTotals[di][kind] ? gridFormatSum(dayTotals[di][kind]) : ''}
                </td>
              ))}
              <td className="border-t border-line bg-surface-2 text-center text-2xs tabular-nums text-ink">{gridFormatSum(grandTotals[kind])}</td>
            </tr>
          ))}
        </tfoot>
      </table>
    </div>
  );
});

interface EmployeeBlockProps {
  emp: GridEmployee;
  serial: number;
  days: GridDay[];
  holidaySet: Set<string>;
  todayYmd: string;
  editor: GridEditor;
  editorRev: number;
  structRev: number;
  payableBase: number | undefined;
  getDbRow: (empId: string, ymd: string) => WorkHours | undefined;
  onCellContext: (empId: string, ymd: string, kind: CellKind, name: string, ev: MouseEvent) => void;
  onRowAction: (empId: string, action: string) => void;
}

const EmployeeBlock = memo(
  function EmployeeBlock(props: EmployeeBlockProps) {
    const { emp, days, editor, holidaySet } = props;
    const wtLabel = gridWorkTypeLabel(emp.workType);
    const editable = editor.editable;

    // Efektivni redovi (dirty-merged) — za Σ isplata i row Σ.
    const effRows = useMemo(() => {
      const m = new Map<string, GridEffective>();
      for (const d of days) m.set(d.ymd, editor.effective(emp.id, d.ymd));
      return m;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [emp.id, days, editor.effective, props.editorRev, props.structRev]);

    // Row Σ po vrsti
    let sReg = 0;
    let sOt = 0;
    let sField = 0;
    let sTm = 0;
    let fdom = 0;
    let ffor = 0;
    for (const d of days) {
      const e = effRows.get(d.ymd)!;
      sReg += gridRedovniUnitsOneDay(d.ymd, e, holidaySet, { workType: emp.workType });
      sOt += Number(e.overtime_hours || 0);
      const fh = Number(e.field_hours || 0);
      sField += fh;
      if (e.field_subtype === 'foreign') ffor += fh;
      else if (fh > 0) fdom += fh;
      sTm += Number(e.two_machine_hours || 0);
    }

    const y = Number(days[0]?.ymd.slice(0, 4));
    const mo = Number(days[0]?.ymd.slice(5, 7));
    const rowsForPayroll = effRows as unknown as Map<string, RowLike>;
    const hasDirty = props.editorRev > 0;
    const payable = hasDirty
      ? gridPayableHoursForEmployee(y, mo, rowsForPayroll, holidaySet, emp.workType, null)
      : props.payableBase ?? gridPayableHoursForEmployee(y, mo, rowsForPayroll, holidaySet, emp.workType, null);

    const lastTitle = (ymd: string) => {
      const db = props.getDbRow(emp.id, ymd);
      if (db?.lastEditedBy) return `Poslednja izmena: ${db.lastEditedBy} · ${formatDateTime(db.updatedAt)}`;
      return undefined;
    };

    const stripeBg = props.serial % 2 === 0 ? 'bg-surface' : 'bg-surface-2/40';

    return (
      <>
        {/* Redovni */}
        <tr className={cn('border-t border-line', stripeBg)}>
          <td rowSpan={5} className={cn('sticky left-0 z-10 w-8 border-r border-line text-center text-2xs text-ink-secondary tabular-nums', stripeBg)}>
            {props.serial}
          </td>
          <td rowSpan={5} className={cn('sticky left-8 z-10 w-52 border-r border-line px-2 align-top', stripeBg)}>
            <div className="flex items-center gap-1">
              <span className="font-medium text-ink">{emp.name}</span>
              {emp.workType !== 'ugovor' && (
                <span className="rounded bg-status-warn-bg px-1 text-[9px] font-semibold uppercase text-status-warn">{wtLabel}</span>
              )}
            </div>
            {emp.deptSub && <div className="text-[10px] text-ink-secondary">{emp.deptSub}</div>}
            {emp.position && <div className="text-[10px] text-ink-disabled">{emp.position}</div>}
            {editable && (
              <div className="mt-0.5 flex gap-1 opacity-60 transition-opacity hover:opacity-100">
                <RowActBtn label="8h" title="Popuni 8h radne dane" empId={emp.id} action="fill8" onAct={props.onRowAction} />
                <RowActBtn label="↶" title="Kopiraj prethodni mesec" empId={emp.id} action="copyPrev" onAct={props.onRowAction} />
                <RowActBtn label="🚐" title="Grupni teren" empId={emp.id} action="teren" onAct={props.onRowAction} />
                <RowActBtn label="✕" title="Isprazni mesec" empId={emp.id} action="clearRow" onAct={props.onRowAction} danger />
              </div>
            )}
          </td>
          <RowLabel>Redovni</RowLabel>
          {days.map((d) => {
            const eff = effRows.get(d.ymd)!;
            const dirty = editor.isDirty(emp.id, d.ymd);
            const err = editor.cellError(emp.id, d.ymd, 'reg');
            const noPay = eff.absence_code && emp.workType !== 'ugovor' && ['go', 'bo', 'sp', 'sl', 'sv', 'pl'].includes(eff.absence_code);
            return (
              <td
                key={d.ymd}
                className={cn('border-r border-line-soft p-0', dayBg(d, props.holidaySet, props.todayYmd))}
                onContextMenu={(ev) => props.onCellContext(emp.id, d.ymd, 'reg', emp.name, ev)}
              >
                <input
                  className={cn(
                    cellBase,
                    eff.absence_code && absTone(eff.absence_code, eff.absence_subtype),
                    noPay && 'italic underline decoration-dotted',
                    dirty && 'ring-1 ring-inset ring-accent',
                    err && 'bg-status-danger-bg text-status-danger ring-1 ring-inset ring-status-danger',
                  )}
                  value={editor.displayValue(emp.id, d.ymd, 'reg')}
                  disabled={!editable}
                  maxLength={6}
                  title={noPay ? `„${eff.absence_code}" se ne plaća (tip rada: ${wtLabel})` : lastTitle(d.ymd)}
                  onChange={(e) => editor.onCellChange(emp.id, d.ymd, 'reg', e.target.value)}
                  onBlur={() => editor.onCellBlur(emp.id, d.ymd, 'reg')}
                  onFocus={(e) => e.currentTarget.select()}
                  data-emp={emp.id}
                  data-ymd={d.ymd}
                  data-kind="reg"
                />
              </td>
            );
          })}
          <RowSum>{gridFormatSum(sReg)}</RowSum>
        </tr>

        {/* Prekov. */}
        <tr className={stripeBg}>
          <RowLabel>Prekov.</RowLabel>
          {days.map((d) => (
            <CellInput
              key={d.ymd}
              empId={emp.id}
              ymd={d.ymd}
              kind="ot"
              name={emp.name}
              day={d}
              editor={editor}
              holidaySet={props.holidaySet}
              todayYmd={props.todayYmd}
              editable={editable}
              onCellContext={props.onCellContext}
              title={lastTitle(d.ymd)}
            />
          ))}
          <RowSum>{gridFormatSum(sOt)}</RowSum>
        </tr>

        {/* Teren */}
        <tr className={stripeBg}>
          <RowLabel>Teren</RowLabel>
          {days.map((d) => {
            const eff = effRows.get(d.ymd)!;
            const fh = eff.field_hours;
            const dirty = editor.isDirty(emp.id, d.ymd);
            const err = editor.cellError(emp.id, d.ymd, 'field');
            return (
              <td
                key={d.ymd}
                className={cn('relative border-r border-line-soft p-0', dayBg(d, props.holidaySet, props.todayYmd))}
                onContextMenu={(ev) => props.onCellContext(emp.id, d.ymd, 'field', emp.name, ev)}
              >
                {fh > 0 && (
                  <span
                    className={cn(
                      'pointer-events-none absolute left-0 top-0 h-0 w-0 border-l-[6px] border-t-[6px] border-t-transparent',
                      eff.field_predmet_broj ? 'border-l-status-success' : 'border-l-status-warn',
                    )}
                    title={eff.field_predmet_broj ? `Predmet: ${eff.field_predmet_broj} — ${eff.field_predmet_naziv || ''}` : 'Teren bez predmeta (desni klik → Veži predmet)'}
                  />
                )}
                <div className="flex items-center">
                  <input
                    className={cn(
                      cellBase,
                      'w-8',
                      fh > 0 && (eff.field_subtype === 'foreign' ? 'text-status-info' : 'text-ink'),
                      dirty && 'ring-1 ring-inset ring-accent',
                      err && 'bg-status-danger-bg text-status-danger ring-1 ring-inset ring-status-danger',
                    )}
                    value={editor.displayValue(emp.id, d.ymd, 'field')}
                    disabled={!editable}
                    maxLength={6}
                    title={lastTitle(d.ymd)}
                    onChange={(e) => editor.onCellChange(emp.id, d.ymd, 'field', e.target.value)}
                    onBlur={() => editor.onCellBlur(emp.id, d.ymd, 'field')}
                    onFocus={(e) => e.currentTarget.select()}
                    data-emp={emp.id}
                    data-ymd={d.ymd}
                    data-kind="field"
                  />
                  {fh > 0 && (
                    <button
                      type="button"
                      tabIndex={-1}
                      disabled={!editable}
                      onClick={() => editor.toggleFieldSub(emp.id, d.ymd)}
                      className={cn('w-3 text-[9px] font-bold', eff.field_subtype === 'foreign' ? 'text-status-info' : 'text-ink-secondary')}
                      title="Domaći / Inostrani teren"
                    >
                      {eff.field_subtype === 'foreign' ? 'I' : 'D'}
                    </button>
                  )}
                </div>
              </td>
            );
          })}
          <RowSum title={`DOM ${gridFormatSum(fdom)}h / INO ${gridFormatSum(ffor)}h`}>{gridFormatSum(sField)}</RowSum>
        </tr>

        {/* 2 maš. */}
        <tr className={stripeBg}>
          <RowLabel>2 maš.</RowLabel>
          {days.map((d) => (
            <CellInput
              key={d.ymd}
              empId={emp.id}
              ymd={d.ymd}
              kind="twomach"
              name={emp.name}
              day={d}
              editor={editor}
              holidaySet={props.holidaySet}
              todayYmd={props.todayYmd}
              editable={editable}
              onCellContext={props.onCellContext}
              title={lastTitle(d.ymd)}
            />
          ))}
          <RowSum>{gridFormatSum(sTm)}</RowSum>
        </tr>

        {/* Σ isplata */}
        <tr className={cn('border-b border-line', stripeBg)}>
          <td className="border-r border-line-soft bg-accent-subtle/40 px-1 text-right text-[10px] font-medium uppercase text-ink-secondary">Σ isplata</td>
          {days.map((d) => (
            <td key={d.ymd} className={cn('border-r border-line-soft', dayBg(d, props.holidaySet, props.todayYmd))} />
          ))}
          <td className="bg-accent-subtle text-center text-2xs font-semibold tabular-nums text-accent">{gridFormatSum(payable)}</td>
        </tr>
      </>
    );
  },
  (a, b) =>
    a.emp === b.emp &&
    a.serial === b.serial &&
    a.days === b.days &&
    a.holidaySet === b.holidaySet &&
    a.todayYmd === b.todayYmd &&
    a.editorRev === b.editorRev &&
    a.structRev === b.structRev &&
    a.payableBase === b.payableBase &&
    a.editor.editable === b.editor.editable,
);

function dayBg(d: GridDay, hol: Set<string>, today: string): string {
  if (hol.has(d.ymd)) return 'bg-status-danger-bg/40';
  if (d.ymd === today) return 'bg-accent-subtle/60';
  if (d.isWeekend) return 'bg-surface-2';
  return '';
}

function RowLabel({ children }: { children: React.ReactNode }) {
  return <td className="w-16 border-r border-line-soft px-1 text-[10px] font-medium uppercase text-ink-secondary">{children}</td>;
}
function RowSum({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <td className="border-l border-line text-center text-2xs font-semibold tabular-nums text-ink" title={title}>
      {children}
    </td>
  );
}
function RowActBtn({
  label,
  title,
  empId,
  action,
  onAct,
  danger,
}: {
  label: string;
  title: string;
  empId: string;
  action: string;
  onAct: (empId: string, action: string) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onAct(empId, action)}
      className={cn('rounded border border-line px-1 text-[10px] leading-4 hover:bg-surface-2', danger && 'text-status-danger')}
    >
      {label}
    </button>
  );
}

interface CellInputProps {
  empId: string;
  ymd: string;
  kind: CellKind;
  name: string;
  day: GridDay;
  editor: GridEditor;
  holidaySet: Set<string>;
  todayYmd: string;
  editable: boolean;
  onCellContext: (empId: string, ymd: string, kind: CellKind, name: string, ev: MouseEvent) => void;
  title?: string;
}
function CellInput({ empId, ymd, kind, name, day, editor, holidaySet, todayYmd, editable, onCellContext, title }: CellInputProps) {
  const dirty = editor.isDirty(empId, ymd);
  const err = editor.cellError(empId, ymd, kind);
  const val = editor.displayValue(empId, ymd, kind);
  return (
    <td className={cn('border-r border-line-soft p-0', dayBg(day, holidaySet, todayYmd))} onContextMenu={(ev) => onCellContext(empId, ymd, kind, name, ev)}>
      <input
        className={cn(
          cellBase,
          kind === 'twomach' && val && 'text-status-warn',
          dirty && 'ring-1 ring-inset ring-accent',
          err && 'bg-status-danger-bg text-status-danger ring-1 ring-inset ring-status-danger',
        )}
        value={val}
        disabled={!editable}
        maxLength={6}
        title={title}
        onChange={(e) => editor.onCellChange(empId, ymd, kind, e.target.value)}
        onBlur={() => editor.onCellBlur(empId, ymd, kind)}
        onFocus={(e) => e.currentTarget.select()}
        data-emp={empId}
        data-ymd={ymd}
        data-kind={kind}
      />
    </td>
  );
}

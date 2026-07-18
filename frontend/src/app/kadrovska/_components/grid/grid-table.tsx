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
  /** Datum zaposlenja (YYYY-MM-DD) — gejtuje auto-priznat državni praznik pre zaposlenja. */
  hireDate: string | null;
  /** false = odjavljen; prikazuje se samo za mesece u kojima ima unos (poslednji radni mesec). */
  isActive?: boolean;
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

/** Boje šifri odsustva (paritet 1.0 — kg-abs-* u globals.css). */
function absTone(code: string | null, subtype: string | null): string {
  switch (code) {
    case 'go':
      return 'kg-abs kg-abs-go';
    case 'bo':
      return subtype === 'povreda_na_radu' || subtype === 'odrzavanje_trudnoce' ? 'kg-abs kg-abs-bo font-semibold' : 'kg-abs kg-abs-bo';
    case 'sp':
      return 'kg-abs kg-abs-sp';
    case 'sl':
    case 'sv':
    case 'pl':
      return 'kg-abs kg-abs-sl';
    case 'np':
      return 'kg-abs kg-abs-np';
    case 'pr':
      return 'kg-abs kg-abs-pr';
    case 'nop':
      return 'kg-abs kg-abs-nop';
    default:
      return '';
  }
}

/** Šrafura kolone (praznik > vikend) + akcentni okvir za danas — na th i td. */
function dayCls(d: GridDay, hol: Set<string>, today: string): string {
  return cn(
    hol.has(d.ymd) ? 'kg-hol' : d.dow === 6 ? 'kg-sat' : d.dow === 0 ? 'kg-sun' : '',
    d.ymd === today && 'kg-today',
  );
}

const DAY_W = 'w-[34px] min-w-[34px] max-w-[34px]';

export const GridTable = memo(function GridTable(props: GridTableProps) {
  const { days, pageEmployees, dayTotals, grandTotals } = props;

  return (
    <div className="max-h-[calc(100vh-320px)] overflow-auto rounded-panel border border-line bg-surface">
      <table className="border-separate border-spacing-0 text-xs" style={{ minWidth: 'max-content' }}>
        <thead className="sticky top-0 z-10">
          <tr className="bg-surface-2">
            <th className="sticky left-0 z-20 h-10 w-8 border-b border-r border-line bg-surface-2 text-2xs text-ink-secondary">#</th>
            <th className="sticky left-8 z-20 h-10 w-[200px] min-w-[200px] border-b border-r border-line bg-surface-2 px-2 text-left text-2xs text-ink-secondary">
              Ime i prezime
            </th>
            <th className="h-10 w-16 border-b border-r-2 border-line bg-surface-2 px-1 text-left text-2xs text-ink-secondary">Vrsta</th>
            {days.map((d) => (
              <th
                key={d.ymd}
                className={cn(
                  'h-10 border-b border-r border-line-soft bg-surface-2 text-2xs font-semibold text-ink',
                  DAY_W,
                  props.holidaySet.has(d.ymd) && 'text-status-danger',
                  dayCls(d, props.holidaySet, props.todayYmd),
                )}
                title={props.holidaySet.has(d.ymd) ? 'Državni praznik' : ''}
              >
                <div>{d.day}</div>
                <div className="font-normal uppercase opacity-70">{d.letter}</div>
              </th>
            ))}
            <th className="h-10 w-[56px] min-w-[56px] border-b border-l border-line bg-surface-2 px-1 text-2xs font-semibold text-accent">Σ</th>
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
          {(['reg', 'ot', 'field', 'tm'] as const).map((kind, ki) => (
            <tr key={kind} className="bg-surface-2 font-semibold">
              <td className={cn('sticky left-0 z-20 border-r border-line bg-surface-2', ki === 0 && 'border-t-2 border-t-accent')} />
              <td
                className={cn('sticky left-8 z-20 border-r border-line bg-surface-2 px-2 text-2xs uppercase text-ink-secondary', ki === 0 && 'border-t-2 border-t-accent')}
                colSpan={2}
              >
                {kind === 'reg' ? 'UKUPNO Redovni' : kind === 'ot' ? 'UKUPNO Prekov.' : kind === 'field' ? 'UKUPNO Teren' : 'UKUPNO 2 maš.'}
              </td>
              {days.map((d, di) => (
                <td
                  key={d.ymd}
                  className={cn(
                    'h-6 border-r border-line-soft bg-surface-2 text-center text-2xs tabular-nums text-ink',
                    ki === 0 && 'border-t-2 border-t-accent',
                    dayCls(d, props.holidaySet, props.todayYmd),
                  )}
                >
                  {dayTotals[di] && dayTotals[di][kind] ? gridFormatSum(dayTotals[di][kind]) : ''}
                </td>
              ))}
              <td className={cn('border-l border-line bg-surface-2 text-center text-2xs font-bold tabular-nums text-accent', ki === 0 && 'border-t-2 border-t-accent')}>
                {gridFormatSum(grandTotals[kind])}
              </td>
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
      sReg += gridRedovniUnitsOneDay(d.ymd, e, holidaySet, { workType: emp.workType, hireDate: emp.hireDate });
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
      ? gridPayableHoursForEmployee(y, mo, rowsForPayroll, holidaySet, emp.workType, emp.hireDate)
      : props.payableBase ?? gridPayableHoursForEmployee(y, mo, rowsForPayroll, holidaySet, emp.workType, emp.hireDate);

    const lastTitle = (ymd: string) => {
      const db = props.getDbRow(emp.id, ymd);
      if (db?.lastEditedBy) return `Poslednja izmena: ${db.lastEditedBy} · ${formatDateTime(db.updatedAt)}`;
      return undefined;
    };

    return (
      <>
        {/* Redovni */}
        <tr>
          <td rowSpan={5} className="sticky left-0 z-10 w-8 border-r border-t-2 border-line bg-surface-2 text-center text-2xs text-ink-secondary tabular-nums">
            {props.serial}
          </td>
          <td rowSpan={5} className="sticky left-8 z-10 w-[200px] border-r border-t-2 border-line bg-surface px-2 align-middle">
            <div className="flex items-center gap-1">
              <span className="font-semibold text-ink">{emp.name}</span>
              {emp.isActive === false && (
                <span className="rounded bg-status-danger-bg px-1 text-[9px] font-semibold uppercase text-status-danger" title="Odjavljen — prikazan jer ima unos u ovom mesecu (poslednji radni mesec)">odjavljen</span>
              )}
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
          <RowLabel first>Redovni</RowLabel>
          {days.map((d) => {
            const eff = effRows.get(d.ymd)!;
            const dirty = editor.isDirty(emp.id, d.ymd);
            const err = editor.cellError(emp.id, d.ymd, 'reg');
            const noPay = eff.absence_code && emp.workType !== 'ugovor' && ['go', 'bo', 'sp', 'sl', 'sv', 'pl'].includes(eff.absence_code);
            return (
              <td
                key={d.ymd}
                className={cn('border-r border-t-2 border-r-line-soft border-t-line p-[1px]', DAY_W, dayCls(d, props.holidaySet, props.todayYmd))}
                onContextMenu={(ev) => props.onCellContext(emp.id, d.ymd, 'reg', emp.name, ev)}
              >
                <input
                  className={cn(
                    'kg-cell',
                    eff.absence_code && absTone(eff.absence_code, eff.absence_subtype),
                    noPay && 'italic underline decoration-dotted',
                    dirty && 'kg-dirty',
                    err && 'kg-err',
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
          <RowSum first>{gridFormatSum(sReg)}</RowSum>
        </tr>

        {/* Prekov. */}
        <tr>
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
        <tr>
          <RowLabel>Teren</RowLabel>
          {days.map((d) => {
            const eff = effRows.get(d.ymd)!;
            const fh = eff.field_hours;
            const dirty = editor.isDirty(emp.id, d.ymd);
            const err = editor.cellError(emp.id, d.ymd, 'field');
            return (
              <td
                key={d.ymd}
                className={cn('relative border-r border-line-soft p-[1px]', DAY_W, dayCls(d, props.holidaySet, props.todayYmd))}
                onContextMenu={(ev) => props.onCellContext(emp.id, d.ymd, 'field', emp.name, ev)}
              >
                {fh > 0 && (
                  <span
                    className={cn(
                      'pointer-events-none absolute left-0 top-0 z-[1] h-0 w-0 border-l-[6px] border-t-[6px] border-t-transparent',
                      eff.field_predmet_broj ? 'border-l-status-success' : 'border-l-status-warn',
                    )}
                    title={eff.field_predmet_broj ? `Predmet: ${eff.field_predmet_broj} — ${eff.field_predmet_naziv || ''}` : 'Teren bez predmeta (desni klik → Veži predmet)'}
                  />
                )}
                <div className="relative">
                  <input
                    className={cn(
                      'kg-cell',
                      fh > 0 && 'pr-[13px]',
                      fh > 0 && (eff.field_subtype === 'foreign' ? 'kg-ff' : 'kg-fd'),
                      dirty && 'kg-dirty',
                      err && 'kg-err',
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
                      className={cn(
                        'absolute right-[2px] top-1/2 w-[11px] -translate-y-1/2 text-[9px] font-bold leading-none',
                        eff.field_subtype === 'foreign' ? 'text-status-info' : 'text-ink-secondary',
                      )}
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
        <tr>
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
        <tr>
          <td className="border-b border-r-2 border-b-line border-r-line px-1 text-right text-[10px] font-medium italic uppercase text-ink-secondary">Σ isplata</td>
          {days.map((d) => (
            <td key={d.ymd} className={cn('h-4 border-b border-r border-b-line border-r-line-soft bg-surface-2/60', DAY_W, dayCls(d, props.holidaySet, props.todayYmd))} />
          ))}
          <td className="border-b border-l border-b-line border-l-line bg-accent-subtle text-center text-2xs font-bold tabular-nums text-accent">{gridFormatSum(payable)}</td>
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

function RowLabel({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <td className={cn('w-16 border-r-2 border-line px-1 text-[10px] font-medium uppercase text-ink-secondary', first && 'border-t-2 border-t-line')}>
      {children}
    </td>
  );
}
function RowSum({ children, title, first }: { children: React.ReactNode; title?: string; first?: boolean }) {
  return (
    <td
      className={cn('border-l border-line bg-surface-2 text-center text-2xs font-semibold tabular-nums text-accent', first && 'border-t-2 border-t-line')}
      title={title}
    >
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
    <td
      className={cn('border-r border-line-soft p-[1px]', DAY_W, dayCls(day, holidaySet, todayYmd))}
      onContextMenu={(ev) => onCellContext(empId, ymd, kind, name, ev)}
    >
      <input
        className={cn('kg-cell', kind === 'twomach' && val && 'kg-tm', dirty && 'kg-dirty', err && 'kg-err')}
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

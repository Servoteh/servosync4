'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { WorkHours } from '@/api/kadrovska';
import {
  gridDirtyKey,
  gridParseCellText,
  gridFormatNum,
  gridAbsCellLabel,
  GRID_FIELD_SUBTYPE_DEFAULT,
  type GridDay,
} from '@/lib/grid-utils';
import { dbRowToSnapshot, type GridDelta } from '@/lib/grid-audit';

export type CellKind = 'reg' | 'ot' | 'field' | 'twomach';

/** Efektivno stanje ćelije = dirty ?? sy15 red (full snapshot, snake_case). */
export type GridEffective = GridDelta;

export interface ProgrammaticField {
  kind: 'field';
  value: number;
  sub: 'domestic' | 'foreign';
  predmetBroj?: string | null;
  predmetNaziv?: string | null;
}

const EMPTY_EFF: GridEffective = {
  hours: 0,
  overtime_hours: 0,
  field_hours: 0,
  field_subtype: null,
  field_predmet_broj: null,
  field_predmet_naziv: null,
  two_machine_hours: 0,
  absence_code: null,
  absence_subtype: null,
};

interface UseGridEditorArgs {
  days: GridDay[];
  getDbRow: (empId: string, ymd: string) => WorkHours | undefined;
  editable: boolean;
  isAdmin: boolean;
  onNopAttempt?: (empId: string, ymd: string) => void;
}

export interface GridEditor {
  editable: boolean;
  version: number;
  structRev: number;
  revs: Record<string, number>;
  dirty: Map<string, GridDelta>;
  effective: (empId: string, ymd: string) => GridEffective;
  isDirty: (empId: string, ymd: string) => boolean;
  cellError: (empId: string, ymd: string, kind: CellKind) => boolean;
  displayValue: (empId: string, ymd: string, kind: CellKind) => string;
  onCellChange: (empId: string, ymd: string, kind: CellKind, raw: string) => void;
  onCellBlur: (empId: string, ymd: string, kind: CellKind) => void;
  setPredmet: (empId: string, ymd: string, broj: string | null, naziv: string | null) => boolean;
  toggleFieldSub: (empId: string, ymd: string) => void;
  fill8: (empId: string, holidaySet: Set<string>) => number;
  clearRow: (empId: string) => void;
  applyTerenEntries: (
    entries: { empId: string; ymd: string; hours: number; sub: 'domestic' | 'foreign'; predmetBroj: string | null; predmetNaziv: string | null }[],
  ) => { applied: number; skipped: number };
  /** Auto-unos iz kapije: upiše `hours` SAMO za potpuno prazne dane (dirty + AUTO
   *  marker), preskoči dan sa bilo kojim postojećim unosom. Nikola verifikuje pa snima. */
  applyAutoFill: (
    entries: { empId: string; ymd: string; hours: number }[],
  ) => { applied: number; skipped: number };
  /** Da li je (empId,ymd) predložen auto-unosom (žuta AUTO oznaka dok se ne izmeni/snimi). */
  isAuto: (empId: string, ymd: string) => boolean;
  applyCopyPrev: (empId: string, prevRowsByYmd: Map<string, WorkHours>) => void;
  applyPaste: (startEmpId: string, startYmd: string, startKind: CellKind, matrix: string[][], visibleEmpIds: string[]) => number;
  restore: (empId: string, ymd: string, vals: GridDelta) => void;
  hasErrors: () => boolean;
  refresh: () => void;
  dirtyCount: () => number;
  dirtyEmployeeCount: () => number;
  buildBatchRows: () => import('@/api/kadrovska').GridBatchRow[];
  collectNopSync: () => { empId: string; ymd: string; isNop: boolean; wasNop: boolean }[];
  clearDirty: () => void;
}

export function useGridEditor({ days, getDbRow, editable, isAdmin, onNopAttempt }: UseGridEditorArgs): GridEditor {
  const dirtyRef = useRef(new Map<string, GridDelta>());
  const rawRef = useRef(new Map<string, string>()); // `${empId}|${ymd}|${kind}` → tekst u toku unosa
  const errRef = useRef(new Set<string>()); // cellKey sa greškom
  const autoRef = useRef(new Set<string>()); // gridDirtyKey → predloženo auto-unosom iz kapije
  const [version, setVersion] = useState(0);
  const [structRev, setStructRev] = useState(0);
  const revsRef = useRef<Record<string, number>>({});
  const [revs, setRevs] = useState<Record<string, number>>({});

  const bump = useCallback((empId: string) => {
    revsRef.current[empId] = (revsRef.current[empId] || 0) + 1;
    setRevs({ ...revsRef.current });
    setVersion((v) => v + 1);
  }, []);

  const bumpStruct = useCallback(() => {
    setStructRev((s) => s + 1);
    setVersion((v) => v + 1);
  }, []);

  const effective = useCallback(
    (empId: string, ymd: string): GridEffective => {
      const d = dirtyRef.current.get(gridDirtyKey(empId, ymd));
      if (d) return d;
      return dbRowToSnapshot(getDbRow(empId, ymd)) as unknown as GridEffective;
    },
    [getDbRow],
  );

  const inheritPredmet = useCallback(
    (empId: string, ymd: string): { broj: string | null; naziv: string | null } => {
      for (let i = days.length - 1; i >= 0; i--) {
        const d = days[i];
        if (d.ymd >= ymd) continue;
        const eff = effective(empId, d.ymd);
        if (eff.field_hours > 0 && eff.field_predmet_broj) {
          return { broj: eff.field_predmet_broj, naziv: eff.field_predmet_naziv };
        }
      }
      return { broj: null, naziv: null };
    },
    [days, effective],
  );

  const applyEdit = useCallback(
    (empId: string, ymd: string, kind: CellKind, parsed: ReturnType<typeof gridParseCellText> | ProgrammaticField) => {
      const key = gridDirtyKey(empId, ymd);
      const next: GridEffective = { ...effective(empId, ymd) };

      if (kind === 'reg') {
        const p = parsed as ReturnType<typeof gridParseCellText>;
        if (p.kind === 'abs') {
          next.absence_code = p.code;
          next.absence_subtype = p.code === 'bo' ? p.subtype || 'obicno' : null;
          next.hours = 0;
        } else if (p.kind === 'num') {
          next.absence_code = null;
          next.absence_subtype = null;
          next.hours = p.value;
        } else {
          next.absence_code = null;
          next.absence_subtype = null;
          next.hours = 0;
        }
      } else if (kind === 'ot') {
        const p = parsed as ReturnType<typeof gridParseCellText>;
        next.overtime_hours = p.kind === 'num' ? p.value : 0;
      } else if (kind === 'twomach') {
        const p = parsed as ReturnType<typeof gridParseCellText>;
        next.two_machine_hours = p.kind === 'num' ? p.value : 0;
      } else if (kind === 'field') {
        if ('kind' in parsed && parsed.kind === 'field') {
          const pf = parsed as ProgrammaticField;
          next.field_hours = pf.value;
          next.field_subtype = pf.value > 0 ? pf.sub : null;
          if ('predmetBroj' in pf) {
            next.field_predmet_broj = pf.value > 0 ? pf.predmetBroj ?? null : null;
            next.field_predmet_naziv = pf.value > 0 ? pf.predmetNaziv ?? null : null;
          }
        } else {
          const p = parsed as ReturnType<typeof gridParseCellText>;
          if (p.kind === 'num') {
            next.field_hours = p.value;
            if (p.value > 0) {
              if (!next.field_subtype) next.field_subtype = GRID_FIELD_SUBTYPE_DEFAULT as 'domestic';
              if (!next.field_predmet_broj) {
                const inh = inheritPredmet(empId, ymd);
                next.field_predmet_broj = inh.broj;
                next.field_predmet_naziv = inh.naziv;
              }
            } else {
              next.field_subtype = null;
            }
          } else {
            next.field_hours = 0;
            next.field_subtype = null;
          }
        }
      }

      if (!(next.field_hours > 0)) {
        next.field_predmet_broj = null;
        next.field_predmet_naziv = null;
      }

      dirtyRef.current.set(key, next);
    },
    [effective, inheritPredmet],
  );

  // ── Kontrolisani unos: raw tekst dok kucaš, dirty live ──────────────

  const displayValue = useCallback(
    (empId: string, ymd: string, kind: CellKind): string => {
      const ck = `${empId}|${ymd}|${kind}`;
      if (rawRef.current.has(ck)) return rawRef.current.get(ck) as string;
      const eff = effective(empId, ymd);
      if (kind === 'reg') {
        if (eff.absence_code) return gridAbsCellLabel(eff.absence_code, eff.absence_subtype);
        return gridFormatNum(eff.hours);
      }
      if (kind === 'ot') return gridFormatNum(eff.overtime_hours);
      if (kind === 'field') return gridFormatNum(eff.field_hours);
      return gridFormatNum(eff.two_machine_hours);
    },
    [effective],
  );

  const onCellChange = useCallback(
    (empId: string, ymd: string, kind: CellKind, raw: string) => {
      const ck = `${empId}|${ymd}|${kind}`;
      rawRef.current.set(ck, raw);
      // Ručna izmena skida AUTO oznaku — od tog trenutka je urednikov unos, ne predlog.
      autoRef.current.delete(gridDirtyKey(empId, ymd));
      const parsed = gridParseCellText(raw);
      // nop guard za non-admin (reg ćelija)
      if (kind === 'reg' && parsed.kind === 'abs' && parsed.code === 'nop' && !isAdmin) {
        rawRef.current.delete(ck);
        errRef.current.delete(ck);
        onNopAttempt?.(empId, ymd);
        bump(empId);
        return;
      }
      const valid =
        parsed.kind === 'empty' ||
        parsed.kind === 'num' ||
        (kind === 'reg' && parsed.kind === 'abs');
      if (valid) {
        errRef.current.delete(ck);
        applyEdit(empId, ymd, kind, parsed);
      } else {
        errRef.current.add(ck); // nevažeći tekst — blokira save
      }
      bump(empId);
    },
    [applyEdit, bump, isAdmin, onNopAttempt],
  );

  const onCellBlur = useCallback(
    (empId: string, ymd: string, kind: CellKind) => {
      const ck = `${empId}|${ymd}|${kind}`;
      if (!errRef.current.has(ck)) rawRef.current.delete(ck); // normalizuj prikaz
      bump(empId);
    },
    [bump],
  );

  // ── Predmet / D-I ───────────────────────────────────────────────────

  const setPredmet = useCallback(
    (empId: string, ymd: string, broj: string | null, naziv: string | null): boolean => {
      const eff = effective(empId, ymd);
      if (!(eff.field_hours > 0)) return false;
      applyEdit(empId, ymd, 'field', {
        kind: 'field',
        value: eff.field_hours,
        sub: (eff.field_subtype as 'domestic' | 'foreign') || 'domestic',
        predmetBroj: broj,
        predmetNaziv: naziv,
      });
      bumpStruct();
      return true;
    },
    [effective, applyEdit, bumpStruct],
  );

  const toggleFieldSub = useCallback(
    (empId: string, ymd: string) => {
      const eff = effective(empId, ymd);
      if (!(eff.field_hours > 0)) return;
      const nextSub = eff.field_subtype === 'foreign' ? 'domestic' : 'foreign';
      applyEdit(empId, ymd, 'field', { kind: 'field', value: eff.field_hours, sub: nextSub });
      bump(empId);
    },
    [effective, applyEdit, bump],
  );

  // ── Red-akcije ──────────────────────────────────────────────────────

  const fill8 = useCallback(
    (empId: string, holidaySet: Set<string>): number => {
      let n = 0;
      for (const d of days) {
        if (d.isWeekend || holidaySet.has(d.ymd)) continue;
        if (effective(empId, d.ymd).absence_code) continue;
        applyEdit(empId, d.ymd, 'reg', { kind: 'num', value: 8 });
        n++;
      }
      bumpStruct();
      return n;
    },
    [days, effective, applyEdit, bumpStruct],
  );

  const clearRow = useCallback(
    (empId: string) => {
      for (const d of days) {
        dirtyRef.current.set(gridDirtyKey(empId, d.ymd), { ...EMPTY_EFF });
      }
      bumpStruct();
    },
    [days, bumpStruct],
  );

  const applyTerenEntries = useCallback(
    (entries: { empId: string; ymd: string; hours: number; sub: 'domestic' | 'foreign'; predmetBroj: string | null; predmetNaziv: string | null }[]) => {
      let applied = 0;
      let skipped = 0;
      for (const en of entries) {
        if (effective(en.empId, en.ymd).absence_code) {
          skipped++;
          continue;
        }
        applyEdit(en.empId, en.ymd, 'field', {
          kind: 'field',
          value: en.hours,
          sub: en.sub,
          predmetBroj: en.predmetBroj,
          predmetNaziv: en.predmetNaziv,
        });
        applied++;
      }
      bumpStruct();
      return { applied, skipped };
    },
    [effective, applyEdit, bumpStruct],
  );

  const applyAutoFill = useCallback(
    (entries: { empId: string; ymd: string; hours: number }[]) => {
      let applied = 0;
      let skipped = 0;
      for (const en of entries) {
        // „Samo prazni dani" (odluka): preskoči ako dan ima BILO šta — redovne/
        // prekovremene/teren/2-mašine sate, odsustvo, ili već izmenjenu (dirty)
        // ćeliju. Auto NIKAD ne gazi ručni rad ni raniji predlog.
        const eff = effective(en.empId, en.ymd);
        const nonEmpty =
          eff.hours > 0 ||
          eff.overtime_hours > 0 ||
          eff.field_hours > 0 ||
          eff.two_machine_hours > 0 ||
          !!eff.absence_code;
        // Preskoči i ako je urednik već dirao ćeliju (dirty red postoji) — čitamo
        // ref direktno (isDirty je deklarisan niže; ista provera).
        if (nonEmpty || dirtyRef.current.has(gridDirtyKey(en.empId, en.ymd))) {
          skipped++;
          continue;
        }
        applyEdit(en.empId, en.ymd, 'reg', { kind: 'num', value: en.hours });
        autoRef.current.add(gridDirtyKey(en.empId, en.ymd));
        applied++;
      }
      bumpStruct();
      return { applied, skipped };
    },
    [effective, applyEdit, bumpStruct],
  );

  const applyCopyPrev = useCallback(
    (empId: string, prevRowsByYmd: Map<string, WorkHours>) => {
      for (const d of days) {
        const [y, m] = d.ymd.split('-');
        void y;
        void m;
        const prevYmd = prevMonthSameDay(d.ymd);
        const src = prevRowsByYmd.get(prevYmd);
        if (!src) {
          dirtyRef.current.set(gridDirtyKey(empId, d.ymd), { ...EMPTY_EFF });
          continue;
        }
        dirtyRef.current.set(gridDirtyKey(empId, d.ymd), {
          hours: Number(src.hours || 0),
          overtime_hours: Number(src.overtimeHours || 0),
          field_hours: Number(src.fieldHours || 0),
          field_subtype: src.fieldSubtype || null,
          field_predmet_broj: src.fieldPredmetBroj || null,
          field_predmet_naziv: src.fieldPredmetNaziv || null,
          two_machine_hours: Number(src.twoMachineHours || 0),
          absence_code: src.absenceCode || null,
          absence_subtype: src.absenceSubtype || null,
        });
      }
      bumpStruct();
    },
    [days, bumpStruct],
  );

  const applyPaste = useCallback(
    (startEmpId: string, startYmd: string, startKind: CellKind, matrix: string[][], visibleEmpIds: string[]): number => {
      // Redovi paste-a šire se preko DANA (kolone), a redovi preko VRSTE KIND-a
      // se u 2.0 mapiraju na isti radnik/istu vrstu po danima (paritet 1.0 col-walk).
      const dayIdx = days.findIndex((d) => d.ymd === startYmd);
      if (dayIdx < 0) return 0;
      let count = 0;
      for (let r = 0; r < matrix.length; r++) {
        const cols = matrix[r];
        for (let c = 0; c < cols.length; c++) {
          const d = days[dayIdx + c];
          if (!d) break;
          onCellChange(startEmpId, d.ymd, startKind, String(cols[c] || '').trim());
          onCellBlur(startEmpId, d.ymd, startKind);
          count++;
        }
      }
      void visibleEmpIds;
      bumpStruct();
      return count;
    },
    [days, onCellChange, onCellBlur, bumpStruct],
  );

  const restore = useCallback(
    (empId: string, ymd: string, vals: GridDelta) => {
      dirtyRef.current.set(gridDirtyKey(empId, ymd), { ...vals });
      bumpStruct();
    },
    [bumpStruct],
  );

  // ── Statusi / save priprema ─────────────────────────────────────────

  // Prisili re-render blokova posle spoljnog refetch-a (30s polling / Osveži).
  const refresh = useCallback(() => bumpStruct(), [bumpStruct]);

  const isDirty = useCallback((empId: string, ymd: string) => dirtyRef.current.has(gridDirtyKey(empId, ymd)), []);
  const isAuto = useCallback((empId: string, ymd: string) => autoRef.current.has(gridDirtyKey(empId, ymd)), []);
  const cellError = useCallback((empId: string, ymd: string, kind: CellKind) => errRef.current.has(`${empId}|${ymd}|${kind}`), []);
  const hasErrors = useCallback(() => errRef.current.size > 0, []);
  const dirtyCount = useCallback(() => dirtyRef.current.size, []);
  const dirtyEmployeeCount = useCallback(() => {
    const s = new Set<string>();
    for (const k of dirtyRef.current.keys()) s.add(k.slice(0, k.indexOf('|')));
    return s.size;
  }, []);

  const buildBatchRows = useCallback((): import('@/api/kadrovska').GridBatchRow[] => {
    const rows: import('@/api/kadrovska').GridBatchRow[] = [];
    for (const [key, d] of dirtyRef.current) {
      const sep = key.indexOf('|');
      const employeeId = key.slice(0, sep);
      const workDate = key.slice(sep + 1);
      const fH = Number(d.field_hours || 0);
      rows.push({
        employeeId,
        workDate,
        hours: Number(d.hours || 0),
        overtimeHours: Number(d.overtime_hours || 0),
        fieldHours: fH,
        fieldSubtype: fH > 0 ? (d.field_subtype as 'domestic' | 'foreign' | null) : null,
        fieldPredmetBroj: fH > 0 ? d.field_predmet_broj : null,
        fieldPredmetNaziv: fH > 0 ? d.field_predmet_naziv : null,
        twoMachineHours: Number(d.two_machine_hours || 0),
        absenceCode: d.absence_code,
        absenceSubtype: d.absence_subtype,
      });
    }
    return rows;
  }, []);

  const collectNopSync = useCallback(() => {
    const out: { empId: string; ymd: string; isNop: boolean; wasNop: boolean }[] = [];
    for (const [key, d] of dirtyRef.current) {
      const sep = key.indexOf('|');
      const empId = key.slice(0, sep);
      const ymd = key.slice(sep + 1);
      const isNop = d.absence_code === 'nop';
      const wasNop = getDbRow(empId, ymd)?.absenceCode === 'nop';
      if (isNop !== wasNop) out.push({ empId, ymd, isNop, wasNop });
    }
    return out;
  }, [getDbRow]);

  const clearDirty = useCallback(() => {
    dirtyRef.current.clear();
    rawRef.current.clear();
    errRef.current.clear();
    autoRef.current.clear();
    revsRef.current = {};
    setRevs({});
    bumpStruct();
  }, [bumpStruct]);

  return useMemo(
    () => ({
      editable,
      version,
      structRev,
      revs,
      dirty: dirtyRef.current,
      effective,
      isDirty,
      isAuto,
      cellError,
      displayValue,
      onCellChange,
      onCellBlur,
      setPredmet,
      toggleFieldSub,
      fill8,
      clearRow,
      applyTerenEntries,
      applyAutoFill,
      applyCopyPrev,
      applyPaste,
      restore,
      hasErrors,
      dirtyCount,
      dirtyEmployeeCount,
      buildBatchRows,
      collectNopSync,
      clearDirty,
      refresh,
    }),
    [
      editable,
      version,
      structRev,
      revs,
      effective,
      isDirty,
      isAuto,
      cellError,
      displayValue,
      onCellChange,
      onCellBlur,
      setPredmet,
      toggleFieldSub,
      fill8,
      clearRow,
      applyTerenEntries,
      applyAutoFill,
      applyCopyPrev,
      applyPaste,
      restore,
      hasErrors,
      dirtyCount,
      dirtyEmployeeCount,
      buildBatchRows,
      collectNopSync,
      clearDirty,
      refresh,
    ],
  );
}

/** Isti dan prethodnog meseca (copyPrev). */
function prevMonthSameDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(y, m - 2, d);
  const py = dt.getFullYear();
  const pm = String(dt.getMonth() + 1).padStart(2, '0');
  const pd = String(dt.getDate()).padStart(2, '0');
  return `${py}-${pm}-${pd}`;
}

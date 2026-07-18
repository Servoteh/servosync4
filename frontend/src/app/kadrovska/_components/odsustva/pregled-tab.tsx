'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCw, FileSpreadsheet, X } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import {
  useAbsences,
  useDirectory,
  useGridMonths,
  useVacationBalance,
  useVacationEntitlements,
  monthsInRange,
  type Absence,
  type WorkHours,
} from '@/api/kadrovska';
import { cn } from '@/lib/cn';
import {
  SS_KEYS,
  ssGet,
  ssSet,
  clampDays,
  compareByName,
  gridCodeToAbsenceType,
  normEmp,
  todayYmd,
  ymd as ymdOf,
  type EmpRow,
} from './shared';

// ============================================================================
// Pregled odsustava — pivot: 1 red = 1 aktivni zaposleni, 15 zbirnih kolona za
// period (port 1.0 odsustvaPregledTab.js). Izvori: absences + work_hours (grid)
// + entitlements + balances + praznici.
// ⚠️ Odstupanje od bit-pariteta (namerno): 1.0 je GO/Bo/Slob./Nepl. brojao SAMO
// iz tabele absences — ali od 2026-06-13 ti tipovi se upisuju u GRID, pa bi
// kolone bile sistematski 0. Ovde se griduje dualizam kao u Kalendaru/Odsutnima:
// grid absence_code dani se DODAJU (uz per-dan dedup protiv absences opsega).
// ============================================================================

interface PregledRow {
  empId: string;
  name: string;
  dept: string;
  workType: string;
  radnihDana: number;
  goDays: number;
  goSaldo: number | null;
  bo65: number;
  bo100: number;
  slobodni: number;
  slava: number;
  neplaceno: number;
  terrDom: number;
  terrIno: number;
  praznici: number;
  ukupnoOdsutan: number;
}

const COLS: { key: keyof PregledRow; label: string; title: string; numeric: boolean }[] = [
  { key: 'name', label: 'Zaposleni', title: 'Ime i prezime', numeric: false },
  { key: 'dept', label: 'Odeljenje', title: 'Odeljenje / firma', numeric: false },
  { key: 'workType', label: 'Tip rada', title: 'Tip rada (ugovor/praksa/…)', numeric: false },
  { key: 'radnihDana', label: 'RD', title: 'Radnih dana (dani sa odrađenim satima)', numeric: true },
  { key: 'goDays', label: 'GO', title: 'Godišnji odmor — iskorišćeno (dani)', numeric: true },
  { key: 'goSaldo', label: 'GO saldo', title: 'Saldo godišnjeg odmora za godinu perioda', numeric: true },
  { key: 'bo65', label: 'Bo 65%', title: 'Bolovanje 65% (obično)', numeric: true },
  { key: 'bo100', label: 'Bo 100%', title: 'Bolovanje 100% (povreda/trudnoća)', numeric: true },
  { key: 'slobodni', label: 'Slobodni', title: 'Slobodni plaćeni dani (svi razlozi)', numeric: true },
  { key: 'slava', label: 'Slava', title: 'Krsna slava (subset slobodnih)', numeric: true },
  { key: 'neplaceno', label: 'Nepl.', title: 'Neplaćeno odsustvo', numeric: true },
  { key: 'terrDom', label: 'Ter.D', title: 'Tereni domaći (dani)', numeric: true },
  { key: 'terrIno', label: 'Ter.I', title: 'Tereni inostrani (dani)', numeric: true },
  { key: 'praznici', label: 'Pr.rad', title: 'Praznici sa radom (dani)', numeric: true },
  { key: 'ukupnoOdsutan', label: 'Ukupno ods.', title: 'Ukupno odsutan = GO+Bo+Slob.+Nepl.', numeric: true },
];

interface Period {
  from: string;
  to: string;
  preset: string;
}
function defaultPeriod(): Period {
  const today = todayYmd();
  return { from: `${today.slice(0, 4)}-01-01`, to: today, preset: 'tekuca-godina' };
}
function loadPeriod(): Period {
  const raw = ssGet(SS_KEYS.period, '');
  if (raw) {
    try {
      const p = JSON.parse(raw) as Period;
      if (p.from && p.to) return p;
    } catch {
      /* fallthrough */
    }
  }
  return defaultPeriod();
}
function presetToPeriod(preset: string): { from: string; to: string } | null {
  const today = todayYmd();
  const y = new Date().getFullYear();
  const m = new Date().getMonth() + 1;
  if (preset === 'tekuca-godina') return { from: `${y}-01-01`, to: today };
  if (preset === 'prethodna-godina') return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  if (preset === 'tekuci-mesec') return { from: ymdOf(y, m, 1), to: today };
  if (preset === 'prethodni-mesec') {
    const pm = m === 1 ? 12 : m - 1;
    const py = m === 1 ? y - 1 : y;
    return { from: ymdOf(py, pm, 1), to: ymdOf(py, pm, new Date(py, pm, 0).getDate()) };
  }
  return null;
}

const PRESETS: { key: string; label: string }[] = [
  { key: 'tekuca-godina', label: 'Tekuća god.' },
  { key: 'prethodna-godina', label: 'Preth. god.' },
  { key: 'tekuci-mesec', label: 'Tekući mes.' },
  { key: 'prethodni-mesec', label: 'Preth. mes.' },
  { key: 'custom', label: 'Custom' },
];

type Sort = { col: keyof PregledRow; dir: 'asc' | 'desc' };
function loadSort(): Sort {
  const raw = ssGet(SS_KEYS.sort, '');
  if (raw) {
    try {
      const s = JSON.parse(raw) as Sort;
      if (s.col && s.dir) return s;
    } catch {
      /* fallthrough */
    }
  }
  return { col: 'name', dir: 'asc' };
}

const dateCls = 'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink';

export function PregledTab({ onNavigateGrid }: { onNavigateGrid?: (empName: string, yyyymm: string) => void }) {
  const qc = useQueryClient();
  const [period, setPeriod] = useState<Period>(loadPeriod);
  const [sort, setSort] = useState<Sort>(loadSort);
  const [search, setSearch] = useState(() => ssGet(SS_KEYS.search, ''));
  const [q, setQ] = useState(search); // debounced vrednost
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // draft od/do (auto-swap na blur/enter, kao 1.0 debounce ponašanje)
  const [fromDraft, setFromDraft] = useState(period.from);
  const [toDraft, setToDraft] = useState(period.to);
  const [swapNote, setSwapNote] = useState('');

  useEffect(() => {
    ssSet(SS_KEYS.period, JSON.stringify(period));
    setFromDraft(period.from);
    setToDraft(period.to);
  }, [period]);
  useEffect(() => ssSet(SS_KEYS.sort, JSON.stringify(sort)), [sort]);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      ssSet(SS_KEYS.search, search);
      setQ(search);
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  function applyDates(fromV: string, toV: string) {
    let from = fromV;
    let to = toV;
    if (!from || !to) return;
    if (from > to) {
      [from, to] = [to, from];
      setSwapNote('Datumi su zamenjeni jer je „Od" bio posle „Do"');
      setTimeout(() => setSwapNote(''), 4000);
    }
    setPeriod({ from, to, preset: 'custom' });
  }

  // ── data ──
  const dirQ = useDirectory();
  const absQ = useAbsences();
  const months = useMemo(() => monthsInRange(period.from, period.to), [period.from, period.to]);
  const grid = useGridMonths(months);
  const toYear = parseInt(period.to.slice(0, 4), 10);
  const entQ = useVacationEntitlements({ year: toYear });
  const balQ = useVacationBalance({ year: toYear });

  const emps: EmpRow[] = useMemo(
    () => (dirQ.data?.data ?? []).map(normEmp).filter((e) => e.isActive).sort(compareByName),
    [dirQ.data],
  );

  const computed: PregledRow[] = useMemo(
    () =>
      computeRows({
        emps,
        absences: absQ.data?.data ?? [],
        gridRows: grid.rows,
        holidaySet: grid.holidaySet,
        entitlements: entQ.data?.data ?? [],
        balances: (balQ.data?.data ?? []) as Record<string, unknown>[],
        from: period.from,
        to: period.to,
        toYear,
      }),
    [emps, absQ.data, grid.rows, grid.holidaySet, entQ.data, balQ.data, period.from, period.to, toYear],
  );

  const visible = useMemo(() => {
    const lq = q.trim().toLowerCase();
    const filtered = lq
      ? computed.filter((r) => r.name.toLowerCase().includes(lq) || r.dept.toLowerCase().includes(lq))
      : computed;
    const { col, dir } = sort;
    return filtered.slice().sort((a, b) => {
      let va: string | number | null = a[col] as string | number | null;
      let vb: string | number | null = b[col] as string | number | null;
      if (va == null) va = dir === 'asc' ? Infinity : -Infinity;
      if (vb == null) vb = dir === 'asc' ? Infinity : -Infinity;
      if (typeof va === 'string' && typeof vb === 'string') {
        const c = va.localeCompare(vb, 'sr');
        return dir === 'asc' ? c : -c;
      }
      const c = Number(va) - Number(vb);
      return dir === 'asc' ? c : -c;
    });
  }, [computed, q, sort]);

  const loading = dirQ.isLoading || absQ.isLoading || grid.isLoading;

  function toggleSort(col: keyof PregledRow) {
    setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  }

  function exportXlsx() {
    const header = [
      'Zaposleni', 'Odeljenje', 'Tip rada', 'Radnih dana',
      'GO isk.', 'GO saldo', 'Bo 65%', 'Bo 100%',
      'Slobodni', 'Slava', 'Neplaćeno',
      'Tereni D', 'Tereni I', 'Praznici rad', 'Ukupno ods.',
    ];
    const dataRows = visible.map((r) => [
      r.name, r.dept, r.workType, r.radnihDana,
      r.goDays, r.goSaldo ?? '', r.bo65, r.bo100,
      r.slobodni, r.slava, r.neplaceno,
      r.terrDom, r.terrIno, r.praznici, r.ukupnoOdsutan,
    ]);
    const sum = (k: keyof PregledRow) => visible.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const sumRow = [
      'Ukupno', '', '', sum('radnihDana'), sum('goDays'),
      visible.filter((r) => r.goSaldo != null).reduce((s, r) => s + (r.goSaldo ?? 0), 0),
      sum('bo65'), sum('bo100'), sum('slobodni'), sum('slava'), sum('neplaceno'),
      sum('terrDom'), sum('terrIno'), sum('praznici'), sum('ukupnoOdsutan'),
    ];
    const aoa: (string | number)[][] = [
      [`Period: ${period.from} do ${period.to}`, `Generisano: ${todayYmd()}`],
      [],
      header,
      ...dataRows,
      sumRow,
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 30 }, { wch: 18 }, { wch: 10 }, { wch: 8 },
      { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 8 },
      { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 8 },
      { wch: 8 }, { wch: 12 }, { wch: 12 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pregled odsustava');
    XLSX.writeFile(wb, `Pregled_odsustava_${period.from}_${period.to}.xlsx`);
  }

  function rowClick(r: PregledRow) {
    ssSet(SS_KEYS.gridSearch, r.name);
    onNavigateGrid?.(r.name, period.to.slice(0, 7));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap gap-1 rounded-panel border border-line bg-surface p-1" role="group" aria-label="Brzi period izbor">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                if (p.key === 'custom') {
                  setPeriod((cur) => ({ ...cur, preset: 'custom' }));
                  return;
                }
                const np = presetToPeriod(p.key);
                if (np) setPeriod({ ...np, preset: p.key });
              }}
              className={cn(
                'rounded-control px-2.5 py-1 text-xs font-medium transition-colors',
                period.preset === p.key ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          Od
          <input
            type="date"
            className={dateCls}
            value={fromDraft}
            onChange={(e) => setFromDraft(e.target.value)}
            onBlur={() => applyDates(fromDraft, toDraft)}
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          Do
          <input
            type="date"
            className={dateCls}
            value={toDraft}
            onChange={(e) => setToDraft(e.target.value)}
            onBlur={() => applyDates(fromDraft, toDraft)}
          />
        </label>
        <Button
          variant="ghost"
          className="h-9 px-2"
          title="Osveži podatke"
          onClick={() => void qc.invalidateQueries({ queryKey: ['kadrovska'] })}
        >
          <RotateCw className={cn('h-4 w-4', grid.isFetching && 'animate-spin')} aria-hidden /> Osveži
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={search} onChange={setSearch} placeholder="Pretraga po imenu…" />
        {search && (
          <Button variant="ghost" className="h-8 px-2" title="Očisti" onClick={() => setSearch('')}>
            <X className="h-4 w-4" aria-hidden />
          </Button>
        )}
        {swapNote && <span className="text-xs text-status-warn">{swapNote}</span>}
        <Button variant="ghost" className="ml-auto h-8" onClick={exportXlsx} disabled={!visible.length}>
          <FileSpreadsheet className="h-4 w-4" aria-hidden /> Excel
        </Button>
      </div>

      {loading ? (
        <p className="px-1 py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : !visible.length ? (
        <EmptyState title="Nema aktivnih zaposlenih za prikaz." />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left">
                <th className="h-9 px-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">#</th>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    title={c.title}
                    onClick={() => toggleSort(c.key)}
                    className={cn(
                      'h-9 cursor-pointer select-none px-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary hover:text-ink',
                      c.numeric && 'text-right',
                    )}
                  >
                    {c.label}
                    {sort.col === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr
                  key={r.empId}
                  onClick={() => rowClick(r)}
                  title={`Klikni za Mesečni grid → ${r.name}`}
                  className="h-[var(--table-row-height)] cursor-pointer border-b border-line-soft hover:bg-surface-2"
                >
                  <td className="tnums px-2 text-right text-ink-secondary">{i + 1}</td>
                  {COLS.map((c) => {
                    const v = r[c.key];
                    return (
                      <td key={c.key} className={cn('px-2 text-ink', c.numeric && 'tnums text-right')}>
                        {c.numeric ? (v == null ? <span className="text-ink-disabled">—</span> : String(v)) : String(v || '—')}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line bg-surface-2 font-semibold">
                <td className="px-2">Σ</td>
                {COLS.map((c) => (
                  <td key={c.key} className={cn('px-2', c.numeric && 'tnums text-right')}>
                    {c.numeric ? visible.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ── computation (port _computeRows + grid dualizam) ──────────────────────────

function computeRows(args: {
  emps: EmpRow[];
  absences: Absence[];
  gridRows: WorkHours[];
  holidaySet: Set<string>;
  entitlements: { employeeId: string; year: number; daysTotal: number; daysCarriedOver: number | null }[];
  balances: Record<string, unknown>[];
  from: string;
  to: string;
  toYear: number;
}): PregledRow[] {
  const { emps, absences, gridRows, holidaySet, entitlements, balances, from, to, toYear } = args;

  // absences u periodu (bez arhiviranih); clamp po redu
  const absList = absences.filter((a) => {
    if (a.archivedAt) return false;
    const df = (a.dateFrom || '').slice(0, 10);
    const dt = (a.dateTo || '').slice(0, 10);
    return !!df && !!dt && dt >= from && df <= to;
  });
  const absByEmp = new Map<string, Absence[]>();
  for (const a of absList) {
    const l = absByEmp.get(a.employeeId);
    if (l) l.push(a);
    else absByEmp.set(a.employeeId, [a]);
  }

  const whByEmp = new Map<string, WorkHours[]>();
  for (const w of gridRows) {
    const ymdW = String(w.workDate).slice(0, 10);
    if (ymdW < from || ymdW > to) continue;
    const l = whByEmp.get(w.employeeId);
    if (l) l.push(w);
    else whByEmp.set(w.employeeId, [w]);
  }

  const rows: PregledRow[] = [];
  for (const emp of emps) {
    const empAbs = absByEmp.get(emp.id) ?? [];
    const empWH = whByEmp.get(emp.id) ?? [];

    const hoursOf = (w: WorkHours) =>
      Number(w.hours || 0) + Number(w.overtimeHours || 0) + Number(w.fieldHours || 0) + Number(w.twoMachineHours || 0);

    const radnihDana = empWH.filter((w) => hoursOf(w) > 0).length;

    // 1.0 paritet: clamped kalendarski dani iz tabele absences
    const sumDays = (fn: (a: Absence) => boolean) =>
      empAbs
        .filter(fn)
        .reduce((s, a) => s + clampDays((a.dateFrom || '').slice(0, 10), (a.dateTo || '').slice(0, 10), from, to), 0);

    let goDays = sumDays((a) => a.type === 'godisnji');
    let bo65 = sumDays((a) => a.type === 'bolovanje' && (a.absenceSubtype === 'obicno' || a.absenceSubtype == null));
    let bo100 = sumDays(
      (a) => a.type === 'bolovanje' && (a.absenceSubtype === 'povreda_na_radu' || a.absenceSubtype === 'odrzavanje_trudnoce'),
    );
    let slobodni = sumDays((a) => a.type === 'slobodan');
    let slava = sumDays((a) => a.type === 'slobodan' && a.slobodanReason === 'slava');
    let neplaceno = sumDays((a) => a.type === 'neplaceno');

    // + grid dani (dualizam) uz per-dan dedup protiv absences opsega
    const coveredByAbs = (ymdW: string) =>
      empAbs.some((a) => (a.dateFrom || '').slice(0, 10) <= ymdW && ymdW <= (a.dateTo || '').slice(0, 10));
    for (const w of empWH) {
      const type = gridCodeToAbsenceType(w.absenceCode);
      if (!type) continue;
      const ymdW = String(w.workDate).slice(0, 10);
      if (coveredByAbs(ymdW)) continue;
      if (type === 'godisnji') goDays++;
      else if (type === 'bolovanje') {
        if (w.absenceSubtype === 'povreda_na_radu' || w.absenceSubtype === 'odrzavanje_trudnoce') bo100++;
        else bo65++;
      } else if (type === 'slobodan') slobodni++;
      else if (type === 'slava') {
        slobodni++;
        slava++;
      } else if (type === 'neplaceno') neplaceno++;
      // placeno / sluzbeno: nemaju kolonu u pivotu (paritet 1.0)
    }

    // Tereni: Set<ymd> po podtipu
    const terrDomSet = new Set<string>();
    const terrInoSet = new Set<string>();
    for (const w of empWH) {
      if (Number(w.fieldHours || 0) > 0) {
        const ymdW = String(w.workDate).slice(0, 10);
        if (w.fieldSubtype === 'foreign') terrInoSet.add(ymdW);
        else terrDomSet.add(ymdW);
      }
    }

    // Praznici sa radom
    let praznici = 0;
    for (const w of empWH) {
      if (holidaySet.has(String(w.workDate).slice(0, 10)) && hoursOf(w) > 0) praznici++;
    }

    // GO saldo (akrual kanon; v_vacation_balance snake_case)
    const ent = entitlements.find((e) => String(e.employeeId) === String(emp.id) && Number(e.year) === toYear);
    const bal = balances.find((b) => String(b.employee_id ?? b.employeeId ?? '') === String(emp.id));
    const balAccrued = bal?.days_remaining_accrued ?? bal?.daysRemainingAccrued;
    const balUsed = bal?.days_used ?? bal?.daysUsed;
    const goSaldo =
      ent != null
        ? balAccrued != null
          ? Number(balAccrued)
          : Number(ent.daysTotal || 0) + Number(ent.daysCarriedOver || 0) - Number(balUsed || 0)
        : null;

    rows.push({
      empId: emp.id,
      name: emp.name,
      dept: emp.department,
      workType: emp.workType,
      radnihDana,
      goDays,
      goSaldo,
      bo65,
      bo100,
      slobodni,
      slava,
      neplaceno,
      terrDom: terrDomSet.size,
      terrIno: terrInoSet.size,
      praznici,
      ukupnoOdsutan: goDays + bo65 + bo100 + slobodni + neplaceno,
    });
  }
  return rows;
}

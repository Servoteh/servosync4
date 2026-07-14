'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { FileText, FileSpreadsheet, History, RefreshCw, MessageSquare, FileSignature, Save, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  useGridLive,
  useGridPayable,
  useDirectory,
  useGridBatchFull,
  fetchGridMonth,
  newClientEventId,
  type WorkHours,
} from '@/api/kadrovska';
import {
  gridDaysInMonth,
  gridIsoToday,
  gridWorkType,
  GRID_ABS_CODES,
  GRID_CODE_LEGEND,
  type GridDay,
} from '@/lib/grid-utils';
import { gridRedovniUnitsOneDay } from '@/lib/grid-payroll';
import { gridChangeLines, fmtYmd } from '@/lib/grid-audit';
import { SummaryChips, sv, cyrMonthLabel } from './common';
import { useGridEditor, type CellKind } from './grid/use-grid-editor';
import { GridTable, type GridEmployee, type DayTotals } from './grid/grid-table';
import { SaveConfirmDialog, type SaveChange } from './grid/save-confirm-dialog';
import { CellHistoryDialog, MonthHistoryDialog } from './grid/history-dialogs';
import { PredmetPickerDialog, type PredmetPick } from './grid/predmet-picker';
import { TerenGroupDialog, type TerenEntry } from './grid/teren-group-dialog';
import { CellContextMenu, type CellMenuState } from './grid/cell-context-menu';
import { RemarksDialog } from './grid/remarks-dialog';
import { NopApprovalsDialog, NopRequestDialog } from './grid/nop-dialogs';
import { WorkHoursTab } from './grid/work-hours-tab';
import { exportGridXlsx } from './grid/grid-excel';
import { exportKarnetPdf } from './grid/karnet-build';

interface CompanyEmp extends GridEmployee {
  department: string;
}

const PAGE = 25;
const SEARCH_KEY = 'ss2_kadr_grid_search_v1';
const DEPT_KEY = 'ss2_kadr_grid_dept_v1';

export function GridTab() {
  const { can } = useAuth();
  const editable = can(PERMISSIONS.KADROVSKA_GRID_EDIT);
  const isAdmin = can(PERMISSIONS.KADROVSKA_ADMIN);
  const canManageNop = can(PERMISSIONS.KADROVSKA_VACREQ_MANAGE) || isAdmin;

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [subtab, setSubtab] = useState<'grid' | 'entries'>('grid');
  const [page, setPage] = useState(0);
  const [dept, setDept] = useState('');
  const [search, setSearch] = useState('');
  const [dsearch, setDsearch] = useState('');
  const [legendOpen, setLegendOpen] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout((showToast as { _t?: number })._t);
    (showToast as { _t?: number })._t = window.setTimeout(() => setToast(''), 3500);
  }, []);

  // sessionStorage init (deep-link iz P8 Pregled + persist)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const s = sessionStorage.getItem(SEARCH_KEY);
    if (s) setSearch(s);
    const d = sessionStorage.getItem(DEPT_KEY);
    if (d) setDept(d);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDsearch(search.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [search]);

  const days = useMemo(() => gridDaysInMonth(year, month), [year, month]);
  const todayYmd = gridIsoToday();

  const dirQ = useDirectory();
  const payableQ = useGridPayable({ year, month }, editable);

  // ── Editor mora postojati pre grid query-ja (refetch pauza dok je dirty) ──
  const rowsRef = useRef<Map<string, Map<string, WorkHours>>>(new Map());
  const getDbRow = useCallback((empId: string, ymd: string) => rowsRef.current.get(empId)?.get(ymd), []);
  const empNameRef = useRef(new Map<string, string>());

  const [nopReq, setNopReq] = useState<{ empId: string; ymd: string; name: string } | null>(null);
  const onNopAttempt = useCallback((empId: string, ymd: string) => {
    const name = empNameRef.current.get(empId) || '';
    setNopReq({ empId, ymd, name });
  }, []);

  const editor = useGridEditor({ days, getDbRow, editable, isAdmin, onNopAttempt });

  const gridQ = useGridLive({ year, month }, { refetchMs: editor.dirtyCount() > 0 ? 0 : 30000 });
  const grid = gridQ.data?.data;
  const locked = !!grid?.locked;

  // rowsByEmpDate (za effective/getDbRow)
  useEffect(() => {
    const m = new Map<string, Map<string, WorkHours>>();
    for (const r of grid?.rows ?? []) {
      let e = m.get(r.employeeId);
      if (!e) {
        e = new Map();
        m.set(r.employeeId, e);
      }
      e.set(String(r.workDate).slice(0, 10), r);
    }
    rowsRef.current = m;
    editor.refresh(); // prisili re-render blokova sa novim db vrednostima
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid?.rows]);

  const holidaySet = useMemo(() => {
    const s = new Set<string>();
    for (const h of grid?.holidays ?? []) if (!h.isWorkday) s.add(String(h.holidayDate).slice(0, 10));
    return s;
  }, [grid?.holidays]);

  const companyAll = useMemo<CompanyEmp[]>(() => {
    const rows = dirQ.data?.data ?? [];
    const nm = new Map<string, string>();
    const out: CompanyEmp[] = rows.map((r) => {
      const id = sv(r, 'id');
      const name = sv(r, 'full_name');
      nm.set(id, name);
      const department = sv(r, 'department');
      const team = sv(r, 'team');
      return {
        id,
        name,
        position: sv(r, 'position'),
        deptSub: [department, team].filter(Boolean).join(' — '),
        department,
        workType: gridWorkType(r),
      };
    });
    empNameRef.current = nm;
    return out.sort((a, b) => a.name.localeCompare(b.name, 'sr'));
  }, [dirQ.data]);

  const empById = useMemo(() => new Map(companyAll.map((e) => [e.id, e])), [companyAll]);
  const nameById = useCallback((id: string) => empNameRef.current.get(id) || id.slice(0, 8), []);

  const departments = useMemo(() => [...new Set(companyAll.map((e) => e.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'sr')), [companyAll]);

  const companyFiltered = useMemo(() => (dept ? companyAll.filter((e) => e.department === dept) : companyAll), [companyAll, dept]);
  const visible = useMemo(() => (dsearch ? companyFiltered.filter((e) => e.name.toLowerCase().includes(dsearch)) : companyFiltered), [companyFiltered, dsearch]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE));
  const pageEmployees = useMemo(() => visible.slice(page * PAGE, page * PAGE + PAGE), [visible, page]);

  const payableMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of payableQ.data?.data.perEmployee ?? []) m.set(r.employeeId, r.payableHours);
    return m;
  }, [payableQ.data]);

  // ── Footer + chips (nad DEPT-filtriranim, search-nezavisno) ──────────
  const { dayTotals, grandTotals, chips } = useMemo(() => {
    const dt: DayTotals[] = days.map(() => ({ reg: 0, ot: 0, field: 0, tm: 0 }));
    const g = { reg: 0, ot: 0, field: 0, tm: 0, fdom: 0, ffor: 0, fdomDays: 0, fforDays: 0, tmDays: 0, fPredDays: 0 };
    for (const emp of companyFiltered) {
      for (let di = 0; di < days.length; di++) {
        const d = days[di];
        const eff = editor.effective(emp.id, d.ymd);
        const regUnits = gridRedovniUnitsOneDay(d.ymd, eff, holidaySet, { workType: emp.workType });
        const ot = Number(eff.overtime_hours || 0);
        const fh = Number(eff.field_hours || 0);
        const tm = Number(eff.two_machine_hours || 0);
        dt[di].reg += regUnits;
        dt[di].ot += ot;
        dt[di].field += fh;
        dt[di].tm += tm;
        g.reg += regUnits;
        g.ot += ot;
        g.field += fh;
        g.tm += tm;
        if (fh > 0) {
          if (eff.field_subtype === 'foreign') {
            g.ffor += fh;
            g.fforDays += 1;
          } else {
            g.fdom += fh;
            g.fdomDays += 1;
          }
          if (eff.field_predmet_broj) g.fPredDays += 1;
        }
        if (tm > 0) g.tmDays += 1;
      }
    }
    const fNoPred = Math.max(0, g.fdomDays + g.fforDays - g.fPredDays);
    const dirtyN = editor.dirtyCount();
    const chips = [
      { label: 'Aktivnih radnika', value: companyFiltered.length, tone: 'accent' as const },
      { label: 'Σ Redovni (obr.)', value: fmt(g.reg), tone: 'accent' as const },
      { label: 'Σ Prekov.', value: fmt(g.ot), tone: g.ot ? ('warn' as const) : ('default' as const) },
      { label: 'Σ Teren', value: fmt(g.field) },
      { label: 'Teren DOM', value: `${fmt(g.fdom)}h · ${g.fdomDays}d` },
      { label: 'Teren INO', value: `${fmt(g.ffor)}h · ${g.fforDays}d`, tone: g.ffor ? ('accent' as const) : ('default' as const) },
      { label: 'Teren bez predmeta', value: `${fNoPred}d`, tone: fNoPred ? ('warn' as const) : ('default' as const) },
      { label: 'Σ 2 mašine', value: `${fmt(g.tm)}h · ${g.tmDays}d`, tone: g.tm ? ('warn' as const) : ('default' as const) },
      { label: 'Izmena za snimanje', value: dirtyN, tone: dirtyN ? ('warn' as const) : ('default' as const) },
    ];
    return { dayTotals: dt, grandTotals: g as DayTotals, chips };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyFiltered, days, holidaySet, editor.version, editor.structRev, editor.effective]);

  // ── Modali ──────────────────────────────────────────────────────────
  const [saveConfirm, setSaveConfirm] = useState<{ changes: SaveChange[]; warnings: string[]; unchangedCount: number; totalCells: number } | null>(null);
  const [cellHist, setCellHist] = useState<{ empId: string; ymd: string; name: string } | null>(null);
  const [monthHist, setMonthHist] = useState(false);
  const [predmet, setPredmet] = useState<{ empId: string; ymd: string; current: PredmetPick | null } | null>(null);
  const [teren, setTeren] = useState<{ preselect: string | null } | null>(null);
  const [remarks, setRemarks] = useState(false);
  const [nopApprovals, setNopApprovals] = useState(false);
  const [menu, setMenu] = useState<CellMenuState | null>(null);

  const batch = useGridBatchFull();

  // ── Kontekst meni + red-akcije ──────────────────────────────────────
  const onCellContext = useCallback(
    (empId: string, ymd: string, kind: CellKind, name: string, ev: MouseEvent) => {
      ev.preventDefault();
      const eff = editor.effective(empId, ymd);
      const items: CellMenuState['items'] = [{ label: '🕘 Istorija ćelije', onClick: () => setCellHist({ empId, ymd, name }) }];
      if (kind === 'field' && eff.field_hours > 0 && editable) {
        const cur = eff.field_predmet_broj ? { broj: eff.field_predmet_broj, naziv: eff.field_predmet_naziv || '' } : null;
        items.push({ label: cur ? `✎ Promeni predmet (${cur.broj})` : '📁 Veži predmet…', onClick: () => setPredmet({ empId, ymd, current: cur }) });
        if (cur) items.push({ label: '✕ Ukloni predmet', danger: true, onClick: () => { editor.setPredmet(empId, ymd, null, null); showToast('Predmet uklonjen — sačuvaj izmene'); } });
      }
      if (editable) items.push({ label: '🚐 Grupni teren…', onClick: () => setTeren({ preselect: empId }) });
      setMenu({ x: ev.clientX, y: ev.clientY, header: `${name} · ${fmtYmd(ymd)}`, items });
    },
    [editor, editable, showToast],
  );

  const onRowAction = useCallback(
    async (empId: string, action: string) => {
      if (!editable) return;
      if (action === 'fill8') {
        const n = editor.fill8(empId, holidaySet);
        showToast(`Popunjeno ${n} radnih dana — sačuvaj izmene`);
      } else if (action === 'clearRow') {
        if (window.confirm('Isprazniti ceo mesec za ovog radnika? (snima se tek na Sačuvaj)')) {
          editor.clearRow(empId);
          showToast('Red ispražnjen — sačuvaj izmene');
        }
      } else if (action === 'teren') {
        setTeren({ preselect: empId });
      } else if (action === 'copyPrev') {
        showToast('⏳ Učitavam prethodni mesec…');
        const prev = new Date(year, month - 2, 1);
        try {
          const res = await fetchGridMonth({ year: prev.getFullYear(), month: prev.getMonth() + 1 });
          const map = new Map<string, WorkHours>();
          for (const r of res.data.rows) if (r.employeeId === empId) map.set(String(r.workDate).slice(0, 10), r);
          editor.applyCopyPrev(empId, map);
          showToast('Prethodni mesec preslikan — sačuvaj izmene');
        } catch {
          showToast('⚠ Greška pri učitavanju prethodnog meseca');
        }
      }
    },
    [editable, editor, holidaySet, showToast, year, month],
  );

  // ── Save ────────────────────────────────────────────────────────────
  function startSave() {
    if (!editable || editor.dirtyCount() === 0) return;
    if (editor.hasErrors()) {
      showToast('⚠ Ima nevažećih ćelija — ispravi pre snimanja');
      return;
    }
    const { errors, warnings } = validateDirty(editor.dirty, empById, days, holidaySet);
    if (errors.length) {
      showToast(`⚠ ${errors.length} grešaka — snimanje blokirano`);
      return;
    }
    const changes: SaveChange[] = [];
    let unchangedCount = 0;
    for (const [key, delta] of editor.dirty) {
      const sep = key.indexOf('|');
      const empId = key.slice(0, sep);
      const ymd = key.slice(sep + 1);
      const lines = gridChangeLines(getDbRow(empId, ymd), delta);
      if (lines.length === 0) unchangedCount++;
      else changes.push({ empName: nameById(empId), ymd, lines });
    }
    changes.sort((a, b) => a.empName.localeCompare(b.empName, 'sr') || a.ymd.localeCompare(b.ymd));
    setSaveConfirm({ changes, warnings: warnings.map((w) => w.message), unchangedCount, totalCells: editor.dirtyCount() });
  }

  function doSave() {
    const totalDirty = editor.dirtyCount();
    const empCount = editor.dirtyEmployeeCount();
    batch.mutate(
      { rows: editor.buildBatchRows(), clientEventId: newClientEventId() },
      {
        onSuccess: () => {
          editor.clearDirty();
          setSaveConfirm(null);
          showToast(`✅ Sačuvano ${totalDirty} izmena · ${empCount} radnika`);
        },
        onError: (e) => showToast(`⚠ ${(e as Error).message || 'Greška pri snimanju'}`),
      },
    );
  }

  function discard() {
    if (editor.dirtyCount() === 0) return;
    if (window.confirm('Odbaciti sve nesačuvane izmene?')) {
      editor.clearDirty();
      showToast('Izmene odbačene');
    }
  }

  // Ctrl+S + beforeunload
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        startSave();
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editor.dirtyCount() > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  function changeMonth(v: string) {
    const [y, m] = v.split('-').map(Number);
    if (!y || !m) return;
    if (editor.dirtyCount() > 0 && !window.confirm('Nesačuvane izmene će biti odbačene. Promeniti mesec?')) return;
    editor.clearDirty();
    setPage(0);
    setYear(y);
    setMonth(m);
  }

  function persistDept(v: string) {
    setDept(v);
    setPage(0);
    try {
      sessionStorage.setItem(DEPT_KEY, v);
    } catch {
      /* ignore */
    }
  }
  function persistSearch(v: string) {
    setSearch(v);
    setPage(0);
    try {
      sessionStorage.setItem(SEARCH_KEY, v);
    } catch {
      /* ignore */
    }
  }

  // ── Keyboard nav + paste (na wrapper-u) ─────────────────────────────
  const wrapRef = useRef<HTMLDivElement>(null);
  const KIND_ORDER: CellKind[] = ['reg', 'ot', 'field', 'twomach'];
  function focusCell(empId: string, ymd: string, kind: CellKind) {
    const el = wrapRef.current?.querySelector<HTMLInputElement>(`input[data-emp="${empId}"][data-ymd="${ymd}"][data-kind="${kind}"]`);
    el?.focus();
  }
  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (t.tagName !== 'INPUT' || !t.dataset.kind) return;
    const empId = t.dataset.emp!;
    const ymd = t.dataset.ymd!;
    const kind = t.dataset.kind as CellKind;
    const di = days.findIndex((d) => d.ymd === ymd);
    const ki = KIND_ORDER.indexOf(kind);
    if (e.key === 'Tab') return;
    if (e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (days[di + 1]) focusCell(empId, days[di + 1].ymd, kind);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (days[di - 1]) focusCell(empId, days[di - 1].ymd, kind);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (KIND_ORDER[ki + 1]) focusCell(empId, ymd, KIND_ORDER[ki + 1]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (KIND_ORDER[ki - 1]) focusCell(empId, ymd, KIND_ORDER[ki - 1]);
    }
  }
  function onGridPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (!editable) return;
    const t = document.activeElement as HTMLElement;
    if (!t || t.tagName !== 'INPUT' || !t.dataset.kind) return;
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t')) return;
    e.preventDefault();
    const matrix = text.replace(/\r\n?/g, '\n').split('\n').filter((r) => r.length).map((r) => r.split('\t'));
    const n = editor.applyPaste(t.dataset.emp!, t.dataset.ymd!, t.dataset.kind as CellKind, matrix, pageEmployees.map((x) => x.id));
    showToast(`Nalepljeno ${n} ćelija — sačuvaj izmene`);
  }

  const monthLabel = cyrMonthLabel(year, month);
  const remarksOpen = (grid?.remarks ?? []).filter((r) => r.status !== 'resolved').length;
  const dirtyN = editor.dirtyCount();

  const companyForActions = useMemo(() => visible.map((e) => ({ id: e.id, name: e.name, position: e.position, workType: e.workType })), [visible]);

  return (
    <div className="space-y-3">
      {/* Sub-tab */}
      <div className="flex gap-1 border-b border-line">
        {(['grid', 'entries'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setSubtab(k)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${subtab === k ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-secondary hover:text-ink'}`}
          >
            {k === 'grid' ? 'Mesečni grid' : 'Pojedinačni unosi'}
          </button>
        ))}
      </div>

      {subtab === 'entries' ? (
        <WorkHoursTab onToast={showToast} />
      ) : (
        <>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="month"
              value={`${year}-${String(month).padStart(2, '0')}`}
              onChange={(e) => changeMonth(e.target.value)}
              className="h-9 rounded-control border border-line bg-surface px-3 text-sm"
            />
            <span className="text-sm text-ink-secondary">{monthLabel}</span>
            <select value={dept} onChange={(e) => persistDept(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm">
              <option value="">Sva odeljenja</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <SearchBox value={search} onChange={persistSearch} placeholder="Pretraga radnika…" />
            {search && (
              <span className="text-2xs text-ink-secondary">
                Prikazano {visible.length} od {companyFiltered.length}
              </span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {editable && (
                <>
                  <Button variant="primary" disabled={dirtyN === 0} loading={batch.isPending} onClick={startSave}>
                    <Save className="h-4 w-4" aria-hidden /> Sačuvaj izmene{dirtyN ? ` (${dirtyN})` : ''}
                  </Button>
                  <Button variant="secondary" disabled={dirtyN === 0} onClick={discard}>
                    <Undo2 className="h-4 w-4" aria-hidden /> Odbaci
                  </Button>
                </>
              )}
              <Button variant={remarksOpen ? 'primary' : 'secondary'} onClick={() => setRemarks(true)}>
                <MessageSquare className="h-4 w-4" aria-hidden /> Primedbe{remarksOpen ? ` (${remarksOpen})` : ''}
              </Button>
              {canManageNop && (
                <Button variant="secondary" onClick={() => setNopApprovals(true)}>
                  <FileSignature className="h-4 w-4" aria-hidden /> Neplaćeno
                </Button>
              )}
              <Button variant="secondary" onClick={() => exportKarnetPdf({ year, month, employees: companyForActions, days, holidaySet, getEff: editor.effective })} disabled={visible.length === 0}>
                <FileText className="h-4 w-4" aria-hidden /> Karnet
              </Button>
              <Button variant="secondary" onClick={() => exportGridXlsx({ year, month, employees: companyFiltered, days, holidaySet, getEff: editor.effective })} disabled={companyFiltered.length === 0}>
                <FileSpreadsheet className="h-4 w-4" aria-hidden /> Excel
              </Button>
              <Button variant="secondary" onClick={() => setMonthHist(true)}>
                <History className="h-4 w-4" aria-hidden /> Istorija
              </Button>
              <Button variant="ghost" onClick={() => gridQ.refetch()} title="Osveži">
                <RefreshCw className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>

          {locked && (
            <div className="rounded-control border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-xs text-status-warn">
              ⚠ Mesec je zaključan — obračun zarada je isplaćen. Unos je i dalje moguć uz potvrdu.
            </div>
          )}

          <SummaryChips items={chips} />

          {gridQ.isLoading ? (
            <p className="py-10 text-center text-sm text-ink-disabled">Učitavanje…</p>
          ) : visible.length === 0 ? (
            <EmptyState title="Nema radnika za izabrani filter" />
          ) : (
            <div ref={wrapRef} onKeyDown={onGridKeyDown} onPaste={onGridPaste}>
              <GridTable
                days={days}
                pageEmployees={pageEmployees}
                holidaySet={holidaySet}
                todayYmd={todayYmd}
                editor={editor}
                serialStart={page * PAGE}
                payableMap={payableMap}
                getDbRow={getDbRow}
                dayTotals={dayTotals}
                grandTotals={grandTotals}
                onCellContext={onCellContext}
                onRowAction={onRowAction}
              />
            </div>
          )}

          {totalPages > 1 && <Pager page={page + 1} totalPages={totalPages} onPrev={() => setPage((p) => Math.max(0, p - 1))} onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))} />}

          {/* Legenda */}
          <div>
            <button onClick={() => setLegendOpen((o) => !o)} className="text-xs text-ink-secondary hover:text-ink">
              {legendOpen ? '▼' : '▶'} Legenda šifri i prečice
            </button>
            {legendOpen && (
              <div className="mt-1 rounded-control border border-line-soft bg-surface-2 p-3 text-xs text-ink-secondary">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {GRID_CODE_LEGEND.map((c) => (
                    <span key={c.code}>
                      <code className="rounded bg-surface px-1 text-ink">{c.code}</code> {c.label}
                    </span>
                  ))}
                </div>
                <p className="mt-2">
                  Prečice: <b>Ctrl+S</b> snimi · <b>Tab/Enter/strelice</b> kretanje · <b>Excel paste</b> (TSV) · <b>desni klik</b> = meni ćelije. „go" u ćeliju = GO u gridu.
                  Red <b>Σ isplata</b> = obračunske jedinice (payrollCalc).
                </p>
              </div>
            )}
          </div>

          {!editable && (
            <p className="text-xs text-ink-secondary">Pregled je informativan. Unos sati traži pravo uređivanja grida (allowlist / poslovni admin) — presuđuje sy15 RLS.</p>
          )}
        </>
      )}

      {/* Modali */}
      {saveConfirm && (
        <SaveConfirmDialog
          open
          monthLabel={monthLabel}
          monthLocked={locked}
          warnings={saveConfirm.warnings}
          changes={saveConfirm.changes}
          unchangedCount={saveConfirm.unchangedCount}
          totalCells={saveConfirm.totalCells}
          onConfirm={doSave}
          onClose={() => setSaveConfirm(null)}
        />
      )}
      {cellHist && (
        <CellHistoryDialog
          open
          employeeId={cellHist.empId}
          ymd={cellHist.ymd}
          employeeName={cellHist.name || nameById(cellHist.empId)}
          editable={editable}
          onRestore={(vals) => editor.restore(cellHist.empId, cellHist.ymd, vals)}
          onClose={() => setCellHist(null)}
        />
      )}
      <MonthHistoryDialog open={monthHist} year={year} month={month} monthLabel={monthLabel} nameById={nameById} onClose={() => setMonthHist(false)} />
      {predmet && (
        <PredmetPickerDialog
          open
          current={predmet.current}
          onPick={(p) => {
            editor.setPredmet(predmet.empId, predmet.ymd, p.broj, p.naziv);
            showToast(`📁 Predmet ${p.broj} vezan — sačuvaj izmene`);
          }}
          onClear={() => {
            editor.setPredmet(predmet.empId, predmet.ymd, null, null);
            showToast('Predmet uklonjen — sačuvaj izmene');
          }}
          onClose={() => setPredmet(null)}
        />
      )}
      {teren && (
        <TerenGroupDialog
          open
          monthLabel={monthLabel}
          days={days}
          holidaySet={holidaySet}
          employees={companyFiltered}
          preselectEmpId={teren.preselect}
          onApply={(entries: TerenEntry[]) => {
            const { applied, skipped } = editor.applyTerenEntries(entries);
            showToast(`🚐 Teren unet u ${applied} ćelija${skipped ? ` · ${skipped} preskočeno (odsustvo)` : ''} — sačuvaj izmene`);
          }}
          onClose={() => setTeren(null)}
        />
      )}
      <RemarksDialog open={remarks} remarks={grid?.remarks ?? []} monthLabel={monthLabel} nameById={nameById} canResolve={editable} onClose={() => setRemarks(false)} />
      <NopApprovalsDialog open={nopApprovals} monthLabel={monthLabel} nameById={nameById} canDecide={isAdmin} onClose={() => setNopApprovals(false)} />
      {nopReq && (
        <NopRequestDialog
          open
          employeeId={nopReq.empId}
          ymd={nopReq.ymd}
          employeeName={nopReq.name || nameById(nopReq.empId)}
          onDone={showToast}
          onClose={() => setNopReq(null)}
        />
      )}
      <CellContextMenu menu={menu} onClose={() => setMenu(null)} />

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-panel border border-line bg-surface px-4 py-2 text-sm text-ink shadow-xl">{toast}</div>
      )}
    </div>
  );
}

function fmt(n: number): string {
  if (!n) return '0';
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

// ── Validacija dirty pre snimanja (port gridValidation) ──────────────
function validateDirty(
  dirty: Map<string, import('@/lib/grid-audit').GridDelta>,
  empById: Map<string, CompanyEmp>,
  days: GridDay[],
  holidaySet: Set<string>,
): { errors: { key: string; message: string }[]; warnings: { key: string; message: string }[] } {
  const errors: { key: string; message: string }[] = [];
  const warnings: { key: string; message: string }[] = [];
  for (const [key, delta] of dirty) {
    const sep = key.indexOf('|');
    const empId = key.slice(0, sep);
    const ymd = key.slice(sep + 1);
    const emp = empById.get(empId);
    const workType = emp?.workType || 'ugovor';
    const name = emp?.name || empId;
    const dayMeta = days.find((d) => d.ymd === ymd);
    const abs = delta.absence_code;

    if (abs && !(GRID_ABS_CODES as readonly string[]).includes(abs)) {
      errors.push({ key, message: `${name} ${fmtYmd(ymd)}: nevažeća šifra „${abs}"` });
      continue;
    }
    for (const [label, val] of [
      ['sati', delta.hours],
      ['prekov.', delta.overtime_hours],
      ['teren', delta.field_hours],
      ['2 maš.', delta.two_machine_hours],
    ] as [string, number][]) {
      if (val < 0 || val > 24) errors.push({ key, message: `${name} ${fmtYmd(ymd)}: ${label} mora biti 0–24 (sada ${val})` });
    }
    if (abs === 'bo' && !delta.absence_subtype) warnings.push({ key, message: `${name} ${fmtYmd(ymd)}: bolovanje bez podtipa — tretira se kao 65%` });
    if (delta.field_hours > 0 && !delta.field_predmet_broj) warnings.push({ key, message: `${name} ${fmtYmd(ymd)}: teren bez predmeta` });
    if (abs && workType !== 'ugovor' && ['go', 'bo', 'sp', 'sl', 'sv', 'pl'].includes(abs)) warnings.push({ key, message: `${name} ${fmtYmd(ymd)}: „${abs}" se ne plaća (tip rada: ${workType})` });
    if (!abs && delta.hours > 8 && dayMeta && !dayMeta.isWeekend && !holidaySet.has(ymd)) warnings.push({ key, message: `${name} ${fmtYmd(ymd)}: ${delta.hours}h redovnih na radni dan — proveri prekovremene` });
  }
  return { errors, warnings };
}

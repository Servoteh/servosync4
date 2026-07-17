'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { generateVacationDecisionPdf, openBlob, downloadBlob } from '@/lib/hr-pdf';
import {
  useEmployees,
  useVacationBalance,
  useVacationEntitlements,
  useRequests,
  useWorkHours,
  useHolidays,
  useSaveEntitlement,
  fetchEmployeePii,
  newClientEventId,
} from '@/api/kadrovska';
import { SummaryChips, sv } from '../common';
import { computeBalanceRows } from './compute';
import { toRosterEmp, type BalanceRow, type RosterEmp } from './types';
import { deptColor, REVIEW_FLAG_BADGE, nextWorkingDay, holidaySetFromRows, mergeConsecutiveDays } from './helpers';
import type { GridSeg } from './gantt';
import { AccrualModal, AdvanceModal } from './entitlement-modals';
import { HistoryModal } from './history-modal';
import { VacationGantt } from './gantt';
import { useOdmoriUi } from './ui';

type ModalState =
  | { type: 'accrual'; row: BalanceRow }
  | { type: 'advance'; row: BalanceRow }
  | { type: 'history'; row: BalanceRow }
  | null;

export function SaldoTab() {
  const { can } = useAuth();
  const canEdit = can(PERMISSIONS.KADROVSKA_VACATION_EDIT);
  const canPii = can(PERMISSIONS.KADROVSKA_PII);
  const canResenje = canPii; // upload u employee_documents traži PII (= admin∨poslovni_admin)

  const { showToast } = useOdmoriUi();

  const [year, setYear] = useState(new Date().getFullYear());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'active' | 'all'>('active');
  const [hiddenDepts, setHiddenDepts] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'table' | 'gantt'>('table');
  const [modal, setModal] = useState<ModalState>(null);

  const empQ = useEmployees({ pageSize: 1000 });
  const balanceQ = useVacationBalance({ year });
  const entQ = useVacationEntitlements({ year });
  const reqQ = useRequests({}, canEdit || can(PERMISSIONS.KADROVSKA_VACREQ_MANAGE));
  const whQ = useWorkHours({ from: `${year}-01-01`, to: `${year}-12-31` });
  const holQ = useHolidays({ from: `${year}-01-01`, to: `${year + 1}-01-31` });
  const saveCarry = useSaveEntitlement();

  // Grid GO segmenti za Gantt (work_hours absence_code='go' → uzastopni dani po zaposlenom).
  const gridSegs = useMemo(() => {
    const byEmp = new Map<string, string[]>();
    for (const r of whQ.data?.data ?? []) {
      if (r.absenceCode !== 'go') continue;
      const d = String(r.workDate).slice(0, 10);
      if (!byEmp.has(r.employeeId)) byEmp.set(r.employeeId, []);
      byEmp.get(r.employeeId)!.push(d);
    }
    const map = new Map<string, GridSeg[]>();
    for (const [emp, days] of byEmp) map.set(emp, mergeConsecutiveDays(days));
    return map;
  }, [whQ.data]);

  const roster: RosterEmp[] = useMemo(
    () => (empQ.data?.data ?? []).map(toRosterEmp),
    [empQ.data],
  );

  const rows = useMemo(
    () =>
      computeBalanceRows({
        roster,
        balances: balanceQ.data?.data ?? [],
        entitlements: entQ.data?.data ?? [],
        year,
        statusFilter,
        hiddenDepts,
        search,
      }),
    [roster, balanceQ.data, entQ.data, year, statusFilter, hiddenDepts, search],
  );

  const allDepts = useMemo(() => {
    const s = new Set<string>();
    for (const e of roster) if (e.department) s.add(e.department);
    return [...s].sort((a, b) => a.localeCompare(b, 'sr'));
  }, [roster]);

  // Stat kartice (1.0 renderStatCards).
  const stats = useMemo(() => {
    const totalTotal = rows.reduce((s, r) => s + ((r.daysEarned != null ? r.daysEarned : r.daysTotal) + r.daysCarried), 0);
    const totalUsed = rows.reduce((s, r) => s + r.daysUsed, 0);
    const totalPlanned = rows.reduce((s, r) => s + r.daysPlanned, 0);
    const totalRemaining = rows.reduce((s, r) => s + Math.max(0, r.daysRemainingAccrued), 0);
    const overCount = rows.filter((r) => r.daysRemaining < 0).length;
    const advCount = rows.filter((r) => r.isAdvance).length;
    return { totalTotal, totalUsed, totalPlanned, totalRemaining, overCount, advCount };
  }, [rows]);

  function commitCarry(row: BalanceRow, value: number) {
    if (!canEdit) return;
    saveCarry.mutate(
      {
        clientEventId: newClientEventId(),
        employeeId: row.emp.id,
        year,
        daysTotal: row.daysTotal,
        daysCarriedOver: value,
      },
      {
        onSuccess: () => showToast('✅ Sačuvano'),
        onError: () => showToast('⚠ Čuvanje nije uspelo'),
      },
    );
  }

  async function openResenje(row: BalanceRow) {
    const vac = (reqQ.data?.data?.vacation ?? []).filter(
      (r) => r.employeeId === row.emp.id && r.year === year && r.status === 'approved',
    );
    vac.sort((a, b) => (a.dateTo < b.dateTo ? 1 : -1));
    let from = vac[0]?.dateFrom?.slice(0, 10) ?? '';
    let to = vac[0]?.dateTo?.slice(0, 10) ?? '';
    let days = vac[0]?.daysCount ?? 0;
    if (!from) {
      from = window.prompt(`Unesi datum početka GO (YYYY-MM-DD) za ${row.emp.name}:`, '') || '';
      if (!from) return;
      to = window.prompt('Unesi datum kraja GO (YYYY-MM-DD):', '') || '';
      if (!to) return;
      days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    }
    try {
      let jmbg = '________________';
      if (canPii) { try { const p = await fetchEmployeePii(row.emp.id); jmbg = sv(p.data, 'personal_id') || jmbg; } catch { /* nema PII */ } }
      const returnIso = nextWorkingDay(to, holidaySetFromRows(holQ.data?.data));
      const { blob, fileName } = await generateVacationDecisionPdf({
        brojResenja: `GO-${year}-${String(row.emp.id).slice(0, 8).toUpperCase()}`,
        datumDonosenja: formatDate(new Date().toISOString().slice(0, 10)),
        mesto: 'Dobanovci',
        godina: year,
        imePrezime: row.emp.name,
        jmbg,
        radnoMesto: row.emp.position,
        brojDana: days,
        datumOd: formatDate(from),
        datumDo: formatDate(to),
        datumPovratka: returnIso ? formatDate(returnIso) : '________',
        saldo: {
          ukupno: (row.daysEarned != null ? row.daysEarned : row.daysTotal) + row.daysCarried,
          iskorisceno: row.daysUsed,
          preostalo: row.daysRemainingAccrued,
        },
        potpisPoslodavac: 'Nenad Jaraković',
      });
      openBlob(blob);
      downloadBlob(blob, fileName);
    } catch (e) {
      showToast('⚠ Greška pri generisanju: ' + (e instanceof Error ? e.message : ''));
    }
  }

  function exportExcel() {
    if (!rows.length) { showToast('Nema podataka za izvoz'); return; }
    const data = [
      ['Zaposleni', 'Odeljenje', 'Preneto', 'Zarađeno do danas', 'Ukupno (do danas)', `Iskorišćeno ${year}`, 'od toga pre 01.05', 'Planirano', 'Preostalo', 'Avans (CEO/CFO)'],
      ...rows.map((r) => [
        r.emp.name,
        r.emp.department,
        r.daysCarried,
        r.daysEarned != null ? r.daysEarned : '',
        (r.daysEarned != null ? r.daysEarned : r.daysTotal) + r.daysCarried,
        r.daysUsed,
        r.openingUsed || 0,
        r.daysPlanned || 0,
        r.daysRemainingAccrued,
        r.isAdvance ? 'DA' : '',
      ]),
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, `GO ${year}`);
    XLSX.writeFile(wb, `Godisnji_odmor_${year}.xlsx`);
  }

  const cols: Column<BalanceRow>[] = [
    {
      key: 'name',
      header: 'Zaposleni',
      render: (r) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-ink">{r.emp.name || '—'}</span>
          {r.reviewFlag && REVIEW_FLAG_BADGE[r.reviewFlag] && (
            <span
              className="rounded border px-1 text-[0.65rem]"
              style={{ color: REVIEW_FLAG_BADGE[r.reviewFlag].color, borderColor: `${REVIEW_FLAG_BADGE[r.reviewFlag].color}66` }}
              title={REVIEW_FLAG_BADGE[r.reviewFlag].tip}
            >
              {REVIEW_FLAG_BADGE[r.reviewFlag].icon} {REVIEW_FLAG_BADGE[r.reviewFlag].label}
            </span>
          )}
          {r.advanceApproved ? (
            <span className="rounded border px-1 text-[0.65rem]" style={{ color: 'var(--status-success)', borderColor: 'color-mix(in srgb, var(--status-success) 45%, transparent)' }} title={`Avans ODOBREN (CEO/CFO).${r.advanceApprovedBy ? ' Odobrio: ' + r.advanceApprovedBy + '.' : ''}${r.advanceNote ? ' Napomena: ' + r.advanceNote : ''}`}>
              🛫 avans ✓ odobren
            </span>
          ) : r.isAdvance ? (
            <span className="rounded border px-1 text-[0.65rem]" style={{ color: 'var(--status-danger)', borderColor: 'color-mix(in srgb, var(--status-danger) 45%, transparent)' }} title="Uzeto/planirano više od zarađenog do danas — avans čeka odobrenje CEO/CFO.">
              🛫 avans — čeka odobrenje
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'dep',
      header: 'Odeljenje',
      render: (r) =>
        r.emp.department ? (
          <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: `${deptColor(r.emp.department)}22`, color: deptColor(r.emp.department) }}>
            {r.emp.department}
          </span>
        ) : '—',
    },
    {
      key: 'carry',
      header: 'Preneto',
      align: 'right',
      render: (r) => (
        <CarryEdit key={r.emp.id} initial={r.daysCarried} disabled={!canEdit} onCommit={(v) => commitCarry(r, v)} />
      ),
    },
    {
      key: 'total',
      header: 'Ukupno (do danas)',
      align: 'right',
      numeric: true,
      render: (r) =>
        r.daysEarned != null ? (
          <span className="font-semibold" title={`Zarađeno do danas (${r.daysEarned}) + preneto (${r.daysCarried})`}>
            {(r.daysEarned) + r.daysCarried}
          </span>
        ) : <span className="text-ink-disabled">—</span>,
    },
    {
      key: 'used',
      header: `Iskorišćeno ${year}`,
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className="font-semibold" title={r.openingUsed > 0 ? `od toga ${r.openingUsed} pre 01.05.2026 (bez datuma)` : undefined}>
          {r.daysUsed}
        </span>
      ),
    },
    {
      key: 'planned',
      header: 'Planirano',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className={cn('font-semibold', r.daysPlanned > 0 ? 'text-status-info' : 'text-ink-disabled')} title="Planirano — budući odobreni GO (rezerviše saldo)">
          {r.daysPlanned || 0}
        </span>
      ),
    },
    {
      key: 'remaining',
      header: 'Preostalo',
      align: 'right',
      numeric: true,
      render: (r) => {
        const tone = r.daysRemainingAccrued < 0 ? 'text-status-danger' : r.daysRemainingAccrued < 3 ? 'text-status-warn' : 'text-status-success';
        return (
          <strong className={cn('tnums', tone)} title="Preostalo = preneto + zarađeno-do-danas − iskorišćeno − planirano.">
            {r.daysRemainingAccrued}
          </strong>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-1">
          {canEdit && (
            <button type="button" className="rounded-control px-1.5 py-1 text-xs text-ink-secondary hover:bg-surface-2" title="Zarađeni odmor (srazmerno sticanje) + iskorišćeno pre cutover-a" onClick={() => setModal({ type: 'accrual', row: r })}>⚙</button>
          )}
          {canEdit && (
            <button type="button" className="rounded-control px-1.5 py-1 text-xs text-ink-secondary hover:bg-surface-2" title="Evidencija odobrenog avansa (CEO/CFO)" onClick={() => setModal({ type: 'advance', row: r })}>🛫</button>
          )}
          <button type="button" className="rounded-control px-1.5 py-1 text-xs text-ink-secondary hover:bg-surface-2" title="GO istorija iz starih Excel fajlova" onClick={() => setModal({ type: 'history', row: r })}>📜</button>
          <button type="button" className="rounded-control px-1.5 py-1 text-xs text-ink-secondary hover:bg-surface-2" title="Rešenje o GO (PDF, štampa)" onClick={() => openResenje(r)}>📄</button>
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-3">
      <SummaryChips
        items={[
          { label: 'Ukupno (pravo do danas)', value: stats.totalTotal },
          { label: `Iskorišćeno ${year}`, value: stats.totalUsed },
          { label: 'Planirano', value: stats.totalPlanned },
          { label: 'Preostalo', value: stats.totalRemaining },
          { label: 'Prekoračilo', value: stats.overCount, tone: stats.overCount > 0 ? 'danger' : 'default' },
          { label: 'Avans (CEO/CFO)', value: stats.advCount, tone: stats.advCount > 0 ? 'accent' : 'default' },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          Godina
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value) || year)}
            className="h-8 w-24 rounded-control border border-line bg-surface px-2 text-sm"
          />
        </label>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Pretraga po imenu…"
          className="h-8 w-52 rounded-control border border-line bg-surface px-3 text-sm"
        />
        <DeptFilter allDepts={allDepts} hidden={hiddenDepts} onChange={setHiddenDepts} />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'active' | 'all')}
          className="h-8 rounded-control border border-line bg-surface px-2 text-sm"
        >
          <option value="active">Samo aktivni</option>
          <option value="all">Svi</option>
        </select>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="inline-flex overflow-hidden rounded-control border border-line">
            <button type="button" onClick={() => setView('table')} className={cn('px-2.5 py-1 text-xs', view === 'table' ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2')}>☰ Tabela</button>
            <button type="button" onClick={() => setView('gantt')} className={cn('px-2.5 py-1 text-xs', view === 'gantt' ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2')}>▦ Gantt</button>
          </div>
          {view === 'table' && <Button variant="secondary" className="h-8 px-2 text-xs" onClick={exportExcel}>📊 Excel</Button>}
          {view === 'gantt' && <Button variant="secondary" className="h-8 px-2 text-xs" onClick={() => window.print()}>🖨 Štampa</Button>}
          <span className="text-xs text-ink-secondary">{rows.length} {rows.length === 1 ? 'zaposleni' : 'zaposlenih'}</span>
        </div>
      </div>

      {view === 'table' ? (
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(r) => r.emp.id}
          loading={empQ.isLoading || balanceQ.isLoading}
          empty={<EmptyState title="Nema zaposlenih za prikaz" />}
        />
      ) : (
        <VacationGantt rows={rows} vac={reqQ.data?.data?.vacation ?? []} gridSegs={gridSegs} year={year} />
      )}

      {modal?.type === 'accrual' && (
        <AccrualModal
          employeeId={modal.row.emp.id}
          employeeName={modal.row.emp.name}
          year={year}
          ent={modal.row.ent}
          bal={{ daysCarried: modal.row.daysCarried, daysEarned: modal.row.daysEarned, daysCommitted: modal.row.daysCommitted, daysUsed: modal.row.daysUsed }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'advance' && (
        <AdvanceModal
          employeeId={modal.row.emp.id}
          employeeName={modal.row.emp.name}
          year={year}
          ent={modal.row.ent}
          bal={{ daysCarried: modal.row.daysCarried, daysEarned: modal.row.daysEarned, daysCommitted: modal.row.daysCommitted, daysUsed: modal.row.daysUsed }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'history' && (
        <HistoryModal
          employeeId={modal.row.emp.id}
          employeeName={modal.row.emp.name}
          position={modal.row.emp.position}
          canMail={canEdit}
          canResenje={canResenje}
          canPii={canPii}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  );
}

/** Inline izmena kolone „Preneto" (debounce 500ms → upsert entitlement). */
function CarryEdit({ initial, disabled, onCommit }: { initial: number; disabled: boolean; onCommit: (v: number) => void }) {
  const [val, setVal] = useState(String(initial));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInitial = useRef(initial);

  // Sinhronizuj kad se red promeni spolja (npr. posle refetch-a), ali NE dok korisnik kuca.
  useEffect(() => {
    if (lastInitial.current !== initial) {
      lastInitial.current = initial;
      setVal(String(initial));
    }
  }, [initial]);

  function onChange(next: string) {
    setVal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const n = Number.parseInt(next, 10);
      onCommit(Number.isFinite(n) ? n : 0);
    }, 500);
  }

  return (
    <input
      type="number"
      min={0}
      max={365}
      value={val}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 w-16 rounded-control border border-line bg-surface px-1.5 text-right text-sm tnums disabled:opacity-60"
    />
  );
}

/** Multi-select filter odeljenja (čekboksi + Odaberi sve/Poništi + brojač). */
function DeptFilter({ allDepts, hidden, onChange }: { allDepts: string[]; hidden: Set<string>; onChange: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const total = allDepts.length;
  const shown = total - hidden.size;
  const label = hidden.size === 0 ? 'Odeljenja' : `Odeljenja (${shown}/${total})`;

  function toggle(d: string, checked: boolean) {
    const n = new Set(hidden);
    if (checked) n.delete(d); else n.add(d);
    onChange(n);
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="h-8 rounded-control border border-line bg-surface px-3 text-sm text-ink-secondary hover:bg-surface-2">
        {label} ▾
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-40 max-h-72 w-56 overflow-auto rounded-panel border border-line bg-surface p-2 shadow-lg">
          <div className="mb-1 flex gap-1.5">
            <button type="button" className="rounded-control px-2 py-0.5 text-xs text-ink-secondary hover:bg-surface-2" onClick={() => onChange(new Set())}>Odaberi sve</button>
            <button type="button" className="rounded-control px-2 py-0.5 text-xs text-ink-secondary hover:bg-surface-2" onClick={() => onChange(new Set(allDepts))}>Poništi</button>
          </div>
          {allDepts.length === 0 ? (
            <div className="px-1 py-1 text-xs text-ink-disabled">Učitavanje…</div>
          ) : allDepts.map((d) => (
            <label key={d} className="flex cursor-pointer items-center gap-2 rounded-control px-1 py-1 text-sm hover:bg-surface-2">
              <input type="checkbox" checked={!hidden.has(d)} onChange={(e) => toggle(d, e.target.checked)} />
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: deptColor(d) }} />
              <span className="truncate">{d}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

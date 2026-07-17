'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Lock, ChevronRight, ArrowLeft, Settings2 } from 'lucide-react';
import type { OpRow, PpMachine } from '@/api/plan-proizvodnje';
import { useMachines, useMachineOperationsAccum, useDeptOperations } from '@/api/plan-proizvodnje';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { cn } from '@/lib/cn';
import { OpsTable } from './ops-table';
import {
  DEPARTMENTS_ROW_1,
  DEPARTMENTS_ROW_2,
  getDepartment,
  filterMachinesForDept,
  machineFitsDept,
  filterOpsByRnOrDrawing,
  type Dept,
} from './shared';
import { LS, lsGet, lsSet, lsGetBool, lsSetBool } from './pp-storage';
import { useRnFilter, RnFilterInput, FilterCounter } from './rn-filter';

/**
 * Po mašini (GAP-PM-03) — drill-down po odeljenju: 11 chip-tabova u 2 reda →
 * lista mašina (numerički sort, ⚙ za mašine bez procedure) → operacije te mašine
 * („← Nazad" + breadcrumb). Tab „Sve" = dropdown (optgroup Mašine/Ostalo); tab
 * „Ostalo" = dve sekcije (mašine + operacije bez kategorije). Persistencija
 * odeljenja+mašine i filtera u localStorage (GAP-PM-21), „Još RN" (GAP-PM-02) i
 * klijentski RN filter (GAP-PM-04).
 */
export function PoMasiniTab({
  onReassign,
  onTp,
  onSkice,
}: {
  onReassign: (o: OpRow) => void;
  onTp: (o: OpRow) => void;
  onSkice: (o: OpRow) => void;
}) {
  const can = useCan();
  const canEdit = can(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  const machines = useMachines();
  const allMachines = useMemo<PpMachine[]>(() => machines.data?.data ?? [], [machines.data]);

  // Persistirani izbor odeljenja/mašine (GAP-PM-21) — inicijalizacija SSR-safe.
  const [deptSlug, setDeptSlug] = useState<string>(() => {
    const saved = lsGet(LS.lastDept);
    return saved && getDepartment(saved) ? saved : 'sve';
  });
  const [machine, setMachine] = useState<string>(() => lsGet(LS.lastMachine) ?? '');
  const [reworkOnly, setReworkOnly] = useState<boolean>(() => lsGetBool(LS.reworkFilter));
  const dept = getDepartment(deptSlug) ?? getDepartment('sve')!;

  // RN filter (debounce + LS po tabu) — GAP-PM-04/PM-21.
  const rn = useRnFilter('po-masini');

  // Restore poslednje mašine SAMO ako pripada trenutnom odeljenju (spreči
  // drill-down u tuđu mašinu). Radi tek kad stignu mašine iz BE-a.
  useEffect(() => {
    if (!machine || allMachines.length === 0) return;
    const known = allMachines.some((m) => m.rj_code === machine);
    if (!known || !machineFitsDept(machine, dept)) setMachine('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allMachines, deptSlug]);

  function selectDept(slug: string) {
    if (slug === deptSlug) return;
    setDeptSlug(slug);
    setMachine('');
    lsSet(LS.lastDept, slug);
    lsSet(LS.lastMachine, null);
  }
  function selectMachine(code: string) {
    setMachine(code);
    lsSet(LS.lastMachine, code || null);
  }
  function toggleRework(v: boolean) {
    setReworkOnly(v);
    lsSetBool(LS.reworkFilter, v);
  }

  // Odluka o prikazu: 'sve' (dropdown), 'machines' (lista→drill), 'ostalo' (2 sekcije→drill).
  const inDrill = !!machine;
  const isSve = dept.kind === 'all' && !dept.isFallback;
  const isOstalo = dept.kind === 'all' && !!dept.isFallback;

  return (
    <div className="space-y-3">
      {/* Chip-tabovi odeljenja u 2 fiksna reda */}
      <nav role="tablist" aria-label="Odeljenja" className="space-y-1.5">
        <div className="flex flex-wrap gap-1.5">
          {DEPARTMENTS_ROW_1.map((d) => (
            <DeptChip key={d.slug} dept={d} active={d.slug === deptSlug} onClick={() => selectDept(d.slug)} />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {DEPARTMENTS_ROW_2.map((d) => (
            <DeptChip key={d.slug} dept={d} active={d.slug === deptSlug} onClick={() => selectDept(d.slug)} />
          ))}
        </div>
      </nav>

      {isSve ? (
        <SveView
          machines={allMachines}
          machine={machine}
          onSelectMachine={selectMachine}
          rn={rn}
          reworkOnly={reworkOnly}
          onToggleRework={toggleRework}
          canEdit={canEdit}
          onReassign={onReassign}
          onTp={onTp}
          onSkice={onSkice}
        />
      ) : inDrill ? (
        <DrillDownView
          dept={dept}
          machines={allMachines}
          machine={machine}
          onBack={() => selectMachine('')}
          rn={rn}
          reworkOnly={reworkOnly}
          onToggleRework={toggleRework}
          canEdit={canEdit}
          onReassign={onReassign}
          onTp={onTp}
          onSkice={onSkice}
        />
      ) : isOstalo ? (
        <OstaloView
          dept={dept}
          machines={allMachines}
          onSelectMachine={selectMachine}
          rn={rn}
          reworkOnly={reworkOnly}
          onToggleRework={toggleRework}
          canEdit={canEdit}
          onReassign={onReassign}
          onTp={onTp}
          onSkice={onSkice}
        />
      ) : (
        <MachineListView dept={dept} machines={allMachines} loading={machines.isLoading} onSelectMachine={selectMachine} />
      )}
    </div>
  );
}

function DeptChip({ dept, active, onClick }: { dept: Dept; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'h-8 rounded-control border px-3 text-sm transition-colors',
        active
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-line bg-surface text-ink-secondary hover:bg-surface-2',
      )}
    >
      {dept.label}
    </button>
  );
}

/** Read-only badge + rework toggle — deljeni toolbar delovi. */
function ReadonlyBadge({ canEdit }: { canEdit: boolean }) {
  if (canEdit) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary"
      title="Nemate pravo izmene"
    >
      <Lock className="h-3 w-3" /> Samo za pregled
    </span>
  );
}

function ReworkToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-ink-secondary" title="Prikaži samo DORADA/ŠKART operacije">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> Dorada/škart
    </label>
  );
}

/** Lista mašina odeljenja (numerički sort, ⚙ za bez-procedure) → klik = drill-down. */
function MachineListView({
  dept,
  machines,
  loading,
  onSelectMachine,
}: {
  dept: Dept;
  machines: PpMachine[];
  loading: boolean;
  onSelectMachine: (code: string) => void;
}) {
  const list = useMemo(() => filterMachinesForDept(machines as { rj_code: string }[], dept), [machines, dept]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm text-ink-secondary">Odeljenje: <strong className="text-ink">{dept.label}</strong></span>
        <span className="ml-auto text-sm text-ink-secondary">{list.length} mašina</span>
      </div>
      {loading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje mašina…</div>
      ) : list.length === 0 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          Nema mašina u ovom odeljenju. Proveri da li su sinhronizovane iz BigTehn-a (pokreni Bridge sync).
        </div>
      ) : (
        <div className="divide-y divide-line-soft overflow-hidden rounded-panel border border-line bg-surface">
          {list.map((m) => (
            <MachineRow key={m.rj_code} machine={m as PpMachine} onClick={() => onSelectMachine(m.rj_code)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MachineRow({ machine, onClick }: { machine: PpMachine; onClick: () => void }) {
  const noProc = machine.no_procedure === true;
  const label = (machine.name as string) || (machine.naziv as string) || '—';
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2">
      <span className="tnums w-16 shrink-0 font-medium text-ink">{machine.rj_code}</span>
      <span className="flex-1 truncate text-ink-secondary">{label}</span>
      {noProc && (
        <span className="inline-flex items-center text-ink-disabled" title="Bez tehnološke procedure (kontrola, kooperacija…)">
          <Settings2 className="h-3.5 w-3.5" />
        </span>
      )}
      <ChevronRight className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
    </button>
  );
}

interface RnHandle {
  raw: string;
  setRaw: (v: string) => void;
  applied: string;
  active: boolean;
}

/** Zajednička tabela operacija po mašini sa „Još RN" + RN filter + rework. */
function MachineOpsTable({
  machine,
  rn,
  reworkOnly,
  onToggleRework,
  toolbar,
  canEdit,
  onReassign,
  onTp,
  onSkice,
}: {
  machine: string;
  rn: RnHandle;
  reworkOnly: boolean;
  onToggleRework: (v: boolean) => void;
  toolbar: React.ReactNode;
  canEdit: boolean;
  onReassign: (o: OpRow) => void;
  onTp: (o: OpRow) => void;
  onSkice: (o: OpRow) => void;
}) {
  const q = useMachineOperationsAccum(machine || null);

  const filtered = useMemo(() => {
    let out = filterOpsByRnOrDrawing(q.rows, rn.applied);
    if (reworkOnly) out = out.filter((o) => o.is_rework || o.is_scrap);
    return out;
  }, [q.rows, rn.applied, reworkOnly]);

  // Drag isključen dok je RN filter ili rework filter aktivan (paritet 1.0 canDragInCurrentView).
  const reorderable = !rn.active && !reworkOnly;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <button
          type="button"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          title="Osveži"
          className="inline-flex h-8 items-center gap-1 rounded-control border border-line px-2 text-xs text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
        >
          <RefreshCw className={q.isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Osveži
        </button>
        <ReworkToggle checked={reworkOnly} onChange={onToggleRework} />
        <RnFilterInput value={rn.raw} onChange={rn.setRaw} />
        <FilterCounter shown={filtered.length} total={q.rows.length} />
        <div className="ml-auto flex items-center gap-2">
          <ReadonlyBadge canEdit={canEdit} />
        </div>
      </div>

      {q.isError ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-status-danger">
          Greška pri učitavanju.{' '}
          <button type="button" onClick={() => q.refetch()} className="underline">Pokušaj ponovo</button>
        </div>
      ) : q.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : rn.active && filtered.length === 0 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          Nema rezultata za filter „{rn.applied.trim()}".
        </div>
      ) : reworkOnly && filtered.length === 0 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">Nema dorade/škarta.</div>
      ) : (
        <>
          <OpsTable
            ops={filtered}
            machine={machine}
            reorderable={reorderable}
            onReassign={onReassign}
            onTp={onTp}
            onSkice={onSkice}
          />
          {q.hasMore && !rn.active && !reworkOnly && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => q.loadMore()}
                disabled={q.loadingMore}
                className="inline-flex h-9 items-center gap-1.5 rounded-control border border-line bg-surface px-4 text-sm text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
                title="Dovrši učitavanje: sledećih do 100 radnih naloga u istom redosledu prioriteta"
              >
                {q.loadingMore ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : null}
                Još RN (do 100)…
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Drill-down: breadcrumb „Odeljenje › kod — Ime" + „← Nazad". */
function DrillDownView({
  dept,
  machines,
  machine,
  onBack,
  rn,
  reworkOnly,
  onToggleRework,
  canEdit,
  onReassign,
  onTp,
  onSkice,
}: {
  dept: Dept;
  machines: PpMachine[];
  machine: string;
  onBack: () => void;
  rn: RnHandle;
  reworkOnly: boolean;
  onToggleRework: (v: boolean) => void;
  canEdit: boolean;
  onReassign: (o: OpRow) => void;
  onTp: (o: OpRow) => void;
  onSkice: (o: OpRow) => void;
}) {
  const m = machines.find((x) => x.rj_code === machine);
  const name = (m?.name as string) || (m?.naziv as string) || '';
  return (
    <MachineOpsTable
      machine={machine}
      rn={rn}
      reworkOnly={reworkOnly}
      onToggleRework={onToggleRework}
      canEdit={canEdit}
      onReassign={onReassign}
      onTp={onTp}
      onSkice={onSkice}
      toolbar={
        <>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-8 items-center gap-1 rounded-control border border-line px-2 text-xs text-ink-secondary hover:bg-surface-2"
            title="Nazad na listu mašina"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Nazad
          </button>
          <span className="text-sm text-ink-secondary">
            {dept.label} <span className="text-ink-disabled">›</span>{' '}
            <strong className="text-ink">{machine}{name ? ` — ${name}` : ''}</strong>
          </span>
        </>
      }
    />
  );
}

/** „Sve" tab: dropdown (optgroup Mašine/Ostalo) + drill-down kad je mašina izabrana. */
function SveView({
  machines,
  machine,
  onSelectMachine,
  rn,
  reworkOnly,
  onToggleRework,
  canEdit,
  onReassign,
  onTp,
  onSkice,
}: {
  machines: PpMachine[];
  machine: string;
  onSelectMachine: (code: string) => void;
  rn: RnHandle;
  reworkOnly: boolean;
  onToggleRework: (v: boolean) => void;
  canEdit: boolean;
  onReassign: (o: OpRow) => void;
  onTp: (o: OpRow) => void;
  onSkice: (o: OpRow) => void;
}) {
  const procedural = machines.filter((m) => m.no_procedure !== true);
  const nonProcedural = machines.filter((m) => m.no_procedure === true);

  const dropdown = (
    <>
      <span className="text-sm text-ink-secondary">Mašina:</span>
      <select
        value={machine}
        onChange={(e) => onSelectMachine(e.target.value)}
        disabled={machines.length === 0}
        className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink disabled:opacity-50"
      >
        <option value="">— izaberi mašinu —</option>
        <optgroup label="Mašine">
          {procedural.map((m) => (
            <option key={m.rj_code} value={m.rj_code}>
              {(m.name as string) || (m.naziv as string) || '—'} ({m.rj_code})
            </option>
          ))}
        </optgroup>
        {nonProcedural.length > 0 && (
          <optgroup label="Ostalo (kontrola, kooperacija…)">
            {nonProcedural.map((m) => (
              <option key={m.rj_code} value={m.rj_code}>
                {(m.name as string) || (m.naziv as string) || '—'} ({m.rj_code})
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </>
  );

  if (machines.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">{dropdown}</div>
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          Nijedna mašina nije pronađena u <code>bigtehn_machines_cache</code> (pokreni Bridge sync).
        </div>
      </div>
    );
  }

  if (!machine) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {dropdown}
          <div className="ml-auto"><ReadonlyBadge canEdit={canEdit} /></div>
        </div>
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          Izaberi mašinu iz dropdown-a da vidiš njene otvorene operacije.
        </div>
      </div>
    );
  }

  return (
    <MachineOpsTable
      machine={machine}
      rn={rn}
      reworkOnly={reworkOnly}
      onToggleRework={onToggleRework}
      canEdit={canEdit}
      onReassign={onReassign}
      onTp={onTp}
      onSkice={onSkice}
      toolbar={dropdown}
    />
  );
}

/** „Ostalo": mašine bez kategorije (klik→drill) + operacije bez kategorije (tabela). */
function OstaloView({
  dept,
  machines,
  onSelectMachine,
  rn,
  reworkOnly,
  onToggleRework,
  canEdit,
  onReassign,
  onTp,
  onSkice,
}: {
  dept: Dept;
  machines: PpMachine[];
  onSelectMachine: (code: string) => void;
  rn: RnHandle;
  reworkOnly: boolean;
  onToggleRework: (v: boolean) => void;
  canEdit: boolean;
  onReassign: (o: OpRow) => void;
  onTp: (o: OpRow) => void;
  onSkice: (o: OpRow) => void;
}) {
  const list = useMemo(() => filterMachinesForDept(machines as { rj_code: string }[], dept), [machines, dept]);
  const q = useDeptOperations(dept.slug);
  const rawRows = q.data?.data ?? [];

  const filtered = useMemo(() => {
    let out = filterOpsByRnOrDrawing(rawRows, rn.applied);
    if (reworkOnly) out = out.filter((o) => o.is_rework || o.is_scrap);
    return out;
  }, [rawRows, rn.applied, reworkOnly]);

  return (
    <div className="space-y-4">
      {/* Sekcija 1: mašine bez kategorije */}
      <div className="space-y-2">
        <div className="text-sm font-semibold text-ink">Mašine bez kategorije <span className="text-ink-disabled">({list.length})</span></div>
        {list.length === 0 ? (
          <div className="rounded-panel border border-line bg-surface px-4 py-4 text-center text-sm text-ink-disabled">
            Sve mašine pripadaju nekom mašinskom tabu. 👍
          </div>
        ) : (
          <div className="divide-y divide-line-soft overflow-hidden rounded-panel border border-line bg-surface">
            {list.map((m) => (
              <MachineRow key={m.rj_code} machine={m as PpMachine} onClick={() => onSelectMachine(m.rj_code)} />
            ))}
          </div>
        )}
      </div>

      {/* Sekcija 2: operacije bez kategorije */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink">Operacije bez kategorije</span>
          <button
            type="button"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            title="Osveži"
            className="inline-flex h-8 items-center gap-1 rounded-control border border-line px-2 text-xs text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            <RefreshCw className={q.isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Osveži
          </button>
          <ReworkToggle checked={reworkOnly} onChange={onToggleRework} />
          <RnFilterInput value={rn.raw} onChange={rn.setRaw} />
          <FilterCounter shown={filtered.length} total={rawRows.length} />
          <div className="ml-auto"><ReadonlyBadge canEdit={canEdit} /></div>
        </div>
        {q.isError ? (
          <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-status-danger">
            Greška pri učitavanju.{' '}
            <button type="button" onClick={() => q.refetch()} className="underline">Pokušaj ponovo</button>
          </div>
        ) : q.isLoading ? (
          <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
        ) : rn.active && filtered.length === 0 ? (
          <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
            Nema rezultata za filter „{rn.applied.trim()}".
          </div>
        ) : (
          // Drag isključen u operacionom tabu (mešanje raznih mašina nema smisla).
          <OpsTable ops={filtered} reorderable={false} onReassign={onReassign} onTp={onTp} onSkice={onSkice} />
        )}
      </div>
    </div>
  );
}

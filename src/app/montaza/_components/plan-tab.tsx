'use client';

// Plan — editabilna tabela faza (increment 2). Paritet 1.0 planTable.js + planActions.js:
// izbor projekta/WP → faze WP-a, inline izmena polja kroz applyBusinessRules, 8 checkova,
// filteri (search/lokacija/status/vođa/spremnost/datumi/rizik + sakrij završene), dodaj/
// pomeri/obriši fazu, debounce autosave (700 ms, upsert POST) + status panel.
//
// Deferred (increment 5): meta modali projekat/WP (dodavanje/izmena), opis faze i
// povezani crteži dijalozi, 3D model, drag-drop reorder (up/down pokriva funkciju).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, Trash2, FileText, Link2, Plus, Pencil, Download, GripVertical, Loader2 } from 'lucide-react';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { cn } from '@/lib/cn';
import {
  useMontazaTree,
  useUpdatePhase,
  useUpsertProject,
  useUpsertWorkPackage,
  useUpsertPhase,
  newClientEventId,
  toPhaseVM,
  type PhaseVM,
  type MontazaWorkPackage,
  type MontazaProjectNode,
} from '@/api/plan-montaze';
import {
  STATUSES,
  CHECK_LABELS,
  CHECK_SHORT,
  DEFAULT_LOCATIONS,
  ENGINEERS_DEFAULT,
  VODJA_DEFAULT,
} from '@/lib/plan-montaze/constants';
import { calcDuration, dayDiffFromToday, todayYmd } from '@/lib/plan-montaze/date';
import {
  applyBusinessRules,
  calcReadiness,
  calcRisk,
  normalizePhaseType,
  riskTone,
  locationColor,
  RISK_LABEL,
} from '@/lib/plan-montaze/phase';
import { usePhaseAutosave } from '@/lib/plan-montaze/autosave';
import { readActiveSelection, writeActiveSelection } from '@/lib/plan-montaze/active-selection';
import { exportPlanJson, exportPlanXlsx, parsePlanImport } from '@/lib/plan-montaze/export';
import { SaveStatusPanel } from './save-status';
import { PhaseCard, DrawingChip } from './phase-card';
import { ProjectMetaDialog, WpMetaDialog } from './meta-modals';
import { PhaseDescriptionDialog, PhaseLinkedDrawingsDialog } from './phase-dialogs';

interface FilterValues {
  search: string;
  loc: string;
  status: string;
  person: string;
  ready: string;
  dates: string;
  risk: string;
}
const EMPTY_FILTERS: FilterValues = { search: '', loc: '', status: '', person: '', ready: '', dates: '', risk: '' };

/** Blank faza (paritet 1.0 createBlankPhase): tip iz naziva, lokacija/ljudi iz WP defaulta. */
function blankPhase(name: string, wp: MontazaWorkPackage, projectId: string, sortOrder: number): PhaseVM {
  return {
    id: newClientEventId(),
    projectId,
    workPackageId: wp.id,
    phaseName: name,
    location: wp.location || DEFAULT_LOCATIONS[0],
    startDate: '',
    endDate: '',
    responsibleEngineer: wp.responsibleEngineerDefault || '',
    montageLead: wp.montageLeadDefault || '',
    status: 0,
    pct: 0,
    checks: new Array(8).fill(false),
    blocker: '',
    note: '',
    sortOrder,
    phaseType: name.toLowerCase().includes('elektro') ? 'electrical' : 'mechanical',
    description: '',
    linkedDrawings: [],
    actualStartDate: '',
    actualEndDate: '',
  };
}

function passesFilters(p: PhaseVM, f: FilterValues, hideDone: boolean): boolean {
  if (hideDone && p.status === 2) return false;
  if (f.search && !p.phaseName.toLowerCase().includes(f.search.toLowerCase().trim())) return false;
  if (f.loc && p.location !== f.loc) return false;
  if (f.status !== '' && p.status !== parseInt(f.status, 10)) return false;
  if (f.person === '__none__' && p.montageLead !== '') return false;
  if (f.person && f.person !== '__none__' && p.montageLead !== f.person) return false;
  if (f.ready === 'ready' && !calcReadiness(p).ready) return false;
  if (f.ready === 'notready' && calcReadiness(p).ready) return false;
  if (f.dates === 'nodate' && p.startDate && p.endDate) return false;
  if (f.dates === 'hasdate' && (!p.startDate || !p.endDate)) return false;
  if (f.risk === 'hasrisk' && calcRisk(p).level === 'none') return false;
  return true;
}

function uniq(base: readonly string[], extra: (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  const out: string[] = [];
  for (const v of [...base, ...extra]) {
    const s = (v ?? '').trim();
    if (s && !set.has(s)) {
      set.add(s);
      out.push(s);
    }
  }
  return out;
}

const HIDE_DONE_LS_KEY = 'montaza.plan.hideDone';

export function PlanTab() {
  const tree = useMontazaTree();
  const canEdit = useCan()(PERMISSIONS.MONTAZA_EDIT);
  const save = usePhaseAutosave();
  const updatePhase = useUpdatePhase();
  const importProject = useUpsertProject();
  const importWp = useUpsertWorkPackage();
  const importPhase = useUpsertPhase();

  const projects = useMemo(() => tree.data?.data ?? [], [tree.data]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [wpId, setWpId] = useState<string | null>(null);
  const [phases, setPhases] = useState<PhaseVM[]>([]);
  const [filters, setFilters] = useState<FilterValues>(EMPTY_FILTERS);
  // „Sakrij završene" preživljava reload (localStorage; typeof window guard za SSR).
  const [hideDone, setHideDone] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(HIDE_DONE_LS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [newName, setNewName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionEng, setSessionEng] = useState<string[]>([]);
  const [sessionLead, setSessionLead] = useState<string[]>([]);
  const [projectDialog, setProjectDialog] = useState<{ project: MontazaProjectNode | null } | null>(null);
  const [wpDialog, setWpDialog] = useState<{ wp: MontazaWorkPackage | null } | null>(null);
  const [descId, setDescId] = useState<string | null>(null);
  const [drawingsId, setDrawingsId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const seededWp = useRef<string | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(HIDE_DONE_LS_KEY, hideDone ? '1' : '0');
    } catch {
      /* localStorage nedostupan (privatni mod) — preskoči persist. */
    }
  }, [hideDone]);

  // Podrazumevani izbor kad se stablo učita: PRVO sačuvan aktivan projekat/nalog
  // (deljen sa Gantt tabom + preživljava tab switch i reload — 1.0 activeProject), pa prvi.
  useEffect(() => {
    if (!projects.length) return;
    if (!projectId || !projects.some((p) => p.id === projectId)) {
      const saved = readActiveSelection();
      const sp = projects.find((p) => p.id === saved.projectId) ?? null;
      const p0 = sp ?? projects[0];
      setProjectId(p0.id);
      const w0 = (sp && p0.workPackages.find((w) => w.id === saved.wpId)) ?? p0.workPackages[0];
      setWpId(w0?.id ?? null);
    }
  }, [projects, projectId]);

  // Svaka promena izbora se pamti (hvata i switch fn-ove i auto-select posle snimanja).
  useEffect(() => {
    if (projectId) writeActiveSelection(projectId, wpId);
  }, [projectId, wpId]);

  const activeProject = projects.find((p) => p.id === projectId) ?? null;
  const activeWp = activeProject?.workPackages.find((w) => w.id === wpId) ?? null;

  // Seed faza pri promeni WP-a (NE reseed na pozadinski refetch — lokalno je izvor istine,
  // last-write-wins kao 1.0; izbegava clobber izmena u toku).
  useEffect(() => {
    if (!wpId) {
      setPhases([]);
      seededWp.current = null;
      return;
    }
    if (seededWp.current === wpId) return;
    const wp = projects.find((p) => p.id === projectId)?.workPackages.find((w) => w.id === wpId);
    if (!wp) return; // stablo još nije stiglo
    const seeded = wp.phases
      .slice()
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map(toPhaseVM);
    setPhases(seeded);
    seededWp.current = wpId;
  }, [wpId, projectId, projects]);

  const engineers = useMemo(
    () => uniq(ENGINEERS_DEFAULT, [...phases.map((p) => p.responsibleEngineer), ...sessionEng]),
    [phases, sessionEng],
  );
  const leads = useMemo(
    () => uniq(VODJA_DEFAULT, [...phases.map((p) => p.montageLead), ...sessionLead]),
    [phases, sessionLead],
  );
  const locations = useMemo(
    () => uniq(DEFAULT_LOCATIONS, [activeWp?.location, ...phases.map((p) => p.location)]),
    [activeWp, phases],
  );

  function flash(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 3500);
  }

  const updateField = useCallback(
    (id: string, field: keyof PhaseVM, value: unknown) => {
      if (!canEdit) return;
      setPhases((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          if (field === 'status' && value === 3 && !p.blocker.trim()) {
            flash('Upišite blokator pre statusa „Na čekanju".');
            return p;
          }
          const next: PhaseVM = { ...p, [field]: value } as PhaseVM;
          if (field === 'phaseType') next.phaseType = normalizePhaseType(String(value));
          applyBusinessRules(next, field as string);
          const ymd = todayYmd();
          if (next.status === 1 && !next.actualStartDate) next.actualStartDate = ymd;
          if (next.status === 2 && !next.actualEndDate) next.actualEndDate = ymd;
          save.schedule(next);
          return next;
        }),
      );
    },
    [canEdit, save],
  );

  const toggleCheck = useCallback(
    (id: string, ci: number, nextVal: boolean) => {
      if (!canEdit) return;
      setPhases((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          const checks = p.checks.slice();
          checks[ci] = nextVal;
          const next = { ...p, checks };
          save.schedule(next);
          return next;
        }),
      );
    },
    [canEdit, save],
  );

  const toggleType = useCallback(
    (id: string) => {
      if (!canEdit) return;
      setPhases((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          const next = { ...p, phaseType: (p.phaseType === 'mechanical' ? 'electrical' : 'mechanical') as PhaseVM['phaseType'] };
          save.schedule(next);
          return next;
        }),
      );
    },
    [canEdit, save],
  );

  const move = useCallback(
    (id: string, dir: -1 | 1) => {
      if (!canEdit) return;
      setFilters(EMPTY_FILTERS);
      setHideDone(false);
      setPhases((prev) => {
        const i = prev.findIndex((p) => p.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= prev.length) return prev;
        const arr = prev.slice();
        [arr[i], arr[j]] = [arr[j], arr[i]];
        const changed: PhaseVM[] = [];
        arr.forEach((p, idx) => {
          if (p.sortOrder !== idx) {
            arr[idx] = { ...p, sortOrder: idx };
            changed.push(arr[idx]);
          }
        });
        changed.forEach((p) => save.saveNow(p));
        return arr;
      });
    },
    [canEdit, save],
  );

  // Drag-drop reorder (paritet 1.0 movePhaseToIndex): premesti fazu `fromId` na mesto
  // pre/posle `toId`, renumeriši sortOrder, snimi izmenjene. Aktivno samo bez filtera.
  const reorder = useCallback(
    (fromId: string, toId: string, after: boolean) => {
      if (!canEdit || fromId === toId) return;
      setPhases((prev) => {
        const from = prev.findIndex((p) => p.id === fromId);
        let to = prev.findIndex((p) => p.id === toId);
        if (from < 0 || to < 0) return prev;
        const arr = prev.slice();
        const [moved] = arr.splice(from, 1);
        if (from < to) to -= 1;
        arr.splice(after ? to + 1 : to, 0, moved);
        const changed: PhaseVM[] = [];
        arr.forEach((p, idx) => {
          if (p.sortOrder !== idx) {
            arr[idx] = { ...p, sortOrder: idx };
            changed.push(arr[idx]);
          }
        });
        changed.forEach((p) => save.saveNow(p));
        return arr;
      });
    },
    [canEdit, save],
  );

  const removePhase = useCallback(
    async (id: string) => {
      if (!canEdit) return;
      const p = phases.find((x) => x.id === id);
      if (!p) return;
      if (!window.confirm(`Obrisati fazu „${p.phaseName || '—'}"?`)) return;
      setPhases((prev) => prev.filter((x) => x.id !== id));
      await save.remove(id);
    },
    [canEdit, phases, save],
  );

  function addPhase() {
    if (!canEdit || !activeWp || !projectId) return;
    const name = newName.trim();
    if (!name) return;
    const vm = blankPhase(name, activeWp, projectId, phases.length);
    setPhases((prev) => [...prev, vm]);
    setNewName('');
    save.saveNow(vm);
  }

  function pickPerson(id: string, field: 'responsibleEngineer' | 'montageLead', value: string) {
    if (value === '__add__') {
      const kind = field === 'responsibleEngineer' ? 'odg. inženjera' : 'vođu montaže';
      const raw = window.prompt(`Unesite ime — ${kind}:`, '');
      const name = String(raw || '').trim();
      if (!name) return;
      if (field === 'responsibleEngineer') setSessionEng((s) => [...s, name]);
      else setSessionLead((s) => [...s, name]);
      updateField(id, field, name);
      return;
    }
    updateField(id, field, value);
  }

  // „Primeni na prazne / Primeni na sve" (paritet 1.0 metaModals): default inženjer/vođa
  // iz WP dijaloga na faze AKTIVNOG naloga; 'empty' popunjava samo prazna polja.
  function applyWpDefaults(mode: 'empty' | 'all', engineer: string, lead: string) {
    if (!canEdit) return;
    const eng = engineer.trim();
    const led = lead.trim();
    if (!eng && !led) {
      flash('Nema podrazumevanih vrednosti za primenu.');
      return;
    }
    const next = phases.map((p) => {
      const setEng = !!eng && (mode === 'all' ? p.responsibleEngineer !== eng : !p.responsibleEngineer.trim());
      const setLead = !!led && (mode === 'all' ? p.montageLead !== led : !p.montageLead.trim());
      if (!setEng && !setLead) return p;
      return {
        ...p,
        responsibleEngineer: setEng ? eng : p.responsibleEngineer,
        montageLead: setLead ? led : p.montageLead,
      };
    });
    const changed = next.filter((p, i) => p !== phases[i]);
    if (!changed.length) {
      flash('Nema faza za izmenu.');
      return;
    }
    setPhases(next);
    changed.forEach((p) => save.saveNow(p));
    flash(`Primenjeno na ${changed.length} faza.`);
  }

  // Sve lokacije CELOG aktivnog projekta (tree + lokalne izmene) — za „Preimenuj lokaciju".
  const projectLocations = useMemo(() => {
    const extra: (string | null | undefined)[] = [];
    if (activeProject) {
      for (const w of activeProject.workPackages) {
        extra.push(w.location);
        for (const ph of w.phases) extra.push(ph.location);
      }
    }
    extra.push(...phases.map((p) => p.location));
    return uniq(DEFAULT_LOCATIONS, extra);
  }, [activeProject, phases]);

  // „Preimenuj lokaciju" (paritet 1.0 renameLocationEverywhere): PATCH svake faze CELOG
  // aktivnog projekta sa location===old + ažuriranje lokalnog state-a aktivnog WP-a.
  async function renameLocation(oldLoc: string, newLoc: string): Promise<number> {
    if (!canEdit || !activeProject) return 0;
    const from = oldLoc.trim();
    const to = newLoc.trim();
    if (!from || !to || from === to) return 0;
    const ids: string[] = [];
    for (const w of activeProject.workPackages) {
      for (const ph of w.phases) {
        if ((ph.location ?? '') === from) ids.push(ph.id);
      }
    }
    // Lokalne (još nerefetchovane) faze aktivnog WP-a — dedupe po id-u.
    for (const p of phases) {
      if (p.location === from && !ids.includes(p.id)) ids.push(p.id);
    }
    if (!ids.length) {
      flash(`Nema faza sa lokacijom „${from}".`);
      return 0;
    }
    if (!window.confirm(`Preimenovati lokaciju '${from}' u '${to}' na ${ids.length} faza?`)) return 0;
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        await updatePhase.mutateAsync({ id, location: to });
        ok++;
      } catch {
        fail++;
      }
    }
    setPhases((prev) => prev.map((p) => (p.location === from ? { ...p, location: to } : p)));
    flash(fail ? `Preimenovano ${ok}/${ids.length} faza (${fail} grešaka).` : `Preimenovano ${ok} faza.`);
    return ok;
  }

  // JSON uvoz (paritet 1.0 exportModal import): parse → confirm → sekvencijalni upsert
  // po ID-u projekat→WP→faza. Invalidacija stabla ide automatski kroz mutacije.
  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !canEdit || importBusy) return;
    setImportResult(null);

    let parsed: ReturnType<typeof parsePlanImport>;
    try {
      parsed = parsePlanImport(JSON.parse(await file.text()));
    } catch (err) {
      setImportResult(err instanceof Error ? err.message : 'Neispravan JSON fajl.');
      return;
    }
    const { projects: impProjects, counts } = parsed;
    const total = counts.projects + counts.wps + counts.phases;
    if (!total) {
      setImportResult('Fajl ne sadrži nijedan projekat.');
      return;
    }
    if (!window.confirm(`Uvoz će upisati/pregaziti po ID-u: ${counts.projects} projekata, ${counts.wps} naloga, ${counts.phases} faza. Nastaviti?`)) {
      return;
    }

    let done = 0;
    let errs = 0;
    const tick = () => setImportBusy(`Uvozim… ${done}/${total}`);
    tick();

    for (const proj of impProjects) {
      const subtree = proj.workPackages.reduce((a, w) => a + 1 + w.phases.length, 0);
      let projId: string;
      try {
        const r = await importProject.mutateAsync({
          id: proj.id,
          projectCode: proj.projectCode,
          projectName: proj.projectName,
          projectm: proj.projectm,
          projectDeadline: proj.projectDeadline ?? null,
          pmEmail: proj.pmEmail,
          leadpmEmail: proj.leadpmEmail,
          status: proj.status,
        });
        projId = r.data.id;
      } catch {
        // Projekat pao → preskoči celo podstablo (WP/faze nemaju roditelja).
        errs += 1 + subtree;
        done += 1 + subtree;
        tick();
        continue;
      }
      done++;
      tick();

      for (let wi = 0; wi < proj.workPackages.length; wi++) {
        const wp = proj.workPackages[wi];
        let wpDbId: string;
        try {
          const r = await importWp.mutateAsync({
            id: wp.id,
            projectId: projId,
            name: wp.name,
            rnCode: wp.rnCode,
            rnOrder: wp.rnOrder ?? wi + 1,
            location: wp.location,
            responsibleEngineerDefault: wp.responsibleEngineerDefault,
            montageLeadDefault: wp.montageLeadDefault,
            deadline: wp.deadline ?? null,
            assemblyDrawingNo: wp.assemblyDrawingNo,
          });
          wpDbId = r.data.id;
        } catch {
          errs += 1 + wp.phases.length;
          done += 1 + wp.phases.length;
          tick();
          continue;
        }
        done++;
        tick();

        for (let pi = 0; pi < wp.phases.length; pi++) {
          const ph = wp.phases[pi];
          try {
            await importPhase.mutateAsync({
              id: ph.id,
              projectId: projId,
              workPackageId: wpDbId,
              phaseName: ph.phaseName,
              location: ph.location,
              startDate: ph.startDate ?? null,
              endDate: ph.endDate ?? null,
              responsibleEngineer: ph.responsibleEngineer,
              montageLead: ph.montageLead,
              status: ph.status,
              pct: ph.pct,
              checks: ph.checks,
              blocker: ph.blocker,
              note: ph.note,
              sortOrder: pi,
              phaseType: ph.phaseType,
              description: ph.description,
              linkedDrawings: ph.linkedDrawings,
              actualStartDate: ph.actualStartDate ?? null,
              actualEndDate: ph.actualEndDate ?? null,
            });
          } catch {
            errs++;
          }
          done++;
          tick();
        }
      }
    }

    // Dozvoli reseed lokalnog state-a iz osveženog stabla (invalidacija kroz mutacije).
    seededWp.current = null;
    setImportBusy(null);
    setImportResult(
      errs
        ? `Uvoz završen: ${total - errs} uspešno, ${errs} grešaka.`
        : `Uvoz završen: svih ${total} stavki uspešno.`,
    );
  }

  function switchWp(id: string) {
    save.flushAll();
    setWpId(id);
  }
  function switchProject(id: string) {
    save.flushAll();
    setProjectId(id);
    const p = projects.find((x) => x.id === id);
    setWpId(p?.workPackages[0]?.id ?? null);
  }

  const visible = useMemo(
    () => phases.map((p, i) => ({ p, i })).filter(({ p }) => passesFilters(p, filters, hideDone)),
    [phases, filters, hideDone],
  );
  const anyFilter =
    !!filters.search || !!filters.loc || filters.status !== '' || !!filters.person || !!filters.ready || !!filters.dates || !!filters.risk || hideDone;

  if (tree.isLoading) return <div className="p-6 text-sm text-ink-secondary">Učitavanje…</div>;
  if (tree.isError) return <div className="p-6 text-sm text-status-danger">Greška pri učitavanju plana.</div>;
  if (!projects.length) {
    return (
      <EmptyState title="Nema projekata" hint="Projekti se izvode iz aktiviranih predmeta (Podešavanja predmeta)." />
    );
  }

  return (
    <div className="space-y-3">
      {/* Project + WP izbor */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Projekat
          <select
            value={projectId ?? ''}
            onChange={(e) => switchProject(e.target.value)}
            className="h-9 min-w-64 rounded-control border border-line bg-surface px-2 text-sm text-ink"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.project_code ? `${p.project_code} · ` : ''}
                {p.project_name}
              </option>
            ))}
          </select>
        </label>
        {canEdit && (
          <div className="flex items-center gap-1">
            {activeProject && (
              <button type="button" onClick={() => setProjectDialog({ project: activeProject })} title="Uredi projekat" className="flex items-center gap-1 rounded-control border border-line px-2 py-1.5 text-xs text-ink-secondary hover:bg-surface-2">
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Projekat
              </button>
            )}
            <button type="button" onClick={() => setProjectDialog({ project: null })} title="Novi projekat" className="flex items-center gap-1 rounded-control border border-line px-2 py-1.5 text-xs text-ink-secondary hover:bg-surface-2">
              <Plus className="h-3.5 w-3.5" aria-hidden /> Projekat
            </button>
          </div>
        )}
        {activeProject && (
          <div className="flex flex-wrap items-center gap-1">
            {activeProject.workPackages.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => switchWp(w.id)}
                className={cn(
                  'rounded-control px-2.5 py-1.5 text-xs',
                  w.id === wpId
                    ? 'bg-accent font-medium text-accent-fg'
                    : 'border border-line text-ink-secondary hover:bg-surface-2',
                )}
                title={w.name}
              >
                <span className="tnums">{w.rnCode || 'RN'}</span>
                {w.name ? ` · ${w.name}` : ''}
              </button>
            ))}
            {canEdit && (
              <>
                {activeWp && (
                  <button type="button" onClick={() => setWpDialog({ wp: activeWp })} title="Uredi nalog" className="rounded-control border border-line p-1.5 text-ink-secondary hover:bg-surface-2">
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
                <button type="button" onClick={() => setWpDialog({ wp: null })} title="Novi nalog montaže" className="flex items-center gap-1 rounded-control border border-line px-2 py-1.5 text-xs text-ink-secondary hover:bg-surface-2">
                  <Plus className="h-3.5 w-3.5" aria-hidden /> Nalog
                </button>
              </>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          title="Izvoz / uvoz plana (JSON / XLSX)"
          className="ml-auto flex items-center gap-1 rounded-control border border-line px-2 py-1.5 text-xs text-ink-secondary hover:bg-surface-2"
        >
          <Download className="h-3.5 w-3.5" aria-hidden /> Izvoz / Uvoz
        </button>
      </div>

      {!activeWp ? (
        <EmptyState
          title="Nema pozicije (naloga montaže)"
          hint={canEdit ? 'Dodaj nalog montaže dugmetom „+ Nalog" iznad.' : 'Ovaj projekat još nema nalog montaže.'}
        />
      ) : (
        <>
          {/* Filter bar */}
          <div className="flex flex-wrap items-end gap-2 rounded-panel border border-line bg-surface p-2">
            <FilterInput label="Pretraga" value={filters.search} onChange={(v) => setFilters((f) => ({ ...f, search: v }))} type="search" placeholder="Naziv faze…" />
            <FilterSelect label="Lokacija" value={filters.loc} onChange={(v) => setFilters((f) => ({ ...f, loc: v }))}>
              <option value="">Sve</option>
              {locations.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </FilterSelect>
            <FilterSelect label="Status" value={filters.status} onChange={(v) => setFilters((f) => ({ ...f, status: v }))}>
              <option value="">Sve</option>
              {STATUSES.map((s, i) => (
                <option key={s} value={i}>{s}</option>
              ))}
            </FilterSelect>
            <FilterSelect label="Vođa" value={filters.person} onChange={(v) => setFilters((f) => ({ ...f, person: v }))}>
              <option value="">Svi</option>
              <option value="__none__">— Bez vođe —</option>
              {leads.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </FilterSelect>
            <FilterSelect label="Spremnost" value={filters.ready} onChange={(v) => setFilters((f) => ({ ...f, ready: v }))}>
              <option value="">Sve</option>
              <option value="ready">Spremno</option>
              <option value="notready">Nije spremno</option>
            </FilterSelect>
            <FilterSelect label="Datumi" value={filters.dates} onChange={(v) => setFilters((f) => ({ ...f, dates: v }))}>
              <option value="">Sve</option>
              <option value="hasdate">Ima datume</option>
              <option value="nodate">Bez datuma</option>
            </FilterSelect>
            <FilterSelect label="Rizik" value={filters.risk} onChange={(v) => setFilters((f) => ({ ...f, risk: v }))}>
              <option value="">Sve</option>
              <option value="hasrisk">Sa rizikom</option>
            </FilterSelect>
            <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
              <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
              Sakrij završene
            </label>
            <span className="ml-auto text-xs text-ink-secondary">
              {anyFilter ? `${visible.length}/${phases.length}` : `${phases.length} faza`}
            </span>
            {anyFilter && (
              <button
                type="button"
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setHideDone(false);
                }}
                className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
              >
                Reset
              </button>
            )}
          </div>

          {/* Dodaj fazu */}
          {canEdit && (
            <div className="flex items-center gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPhase()}
                placeholder="Naziv nove faze…"
                className="h-9 w-72 rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled"
              />
              <Button onClick={addPhase} disabled={!newName.trim()}><Plus className="h-4 w-4" aria-hidden /> Faza</Button>
            </div>
          )}

          {notice && (
            <div className="rounded-control border border-status-warn/40 bg-status-warn-bg px-3 py-1.5 text-sm text-status-warn">
              {notice}
            </div>
          )}

          {/* Tabela (desktop ≥ lg) */}
          <div className="hidden overflow-x-auto rounded-panel border border-line bg-surface lg:block">
            <table className="w-full min-w-[1400px] text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                  <th className="w-10 px-2 py-2">#</th>
                  <th className="min-w-56 px-2 py-2">Naziv</th>
                  <th className="px-2 py-2">Lokacija</th>
                  <th className="px-2 py-2">Početak</th>
                  <th className="px-2 py-2">Kraj</th>
                  <th className="px-2 py-2 text-right">Traj.</th>
                  <th className="px-2 py-2">Inženjer</th>
                  <th className="px-2 py-2">Vođa</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="min-w-28 px-2 py-2">%</th>
                  {CHECK_SHORT.map((s, i) => (
                    <th key={s} className="px-1 py-2 text-center" title={CHECK_LABELS[i]}>{s}</th>
                  ))}
                  <th className="px-2 py-2">Spreman</th>
                  <th className="px-2 py-2">Rizik</th>
                  <th className="min-w-40 px-2 py-2">Blokator</th>
                  <th className="min-w-40 px-2 py-2">Beleška</th>
                  <th className="px-2 py-2 text-right">Akcije</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={10 + CHECK_SHORT.length + 5} className="px-4 py-8 text-center text-ink-disabled">
                      {phases.length === 0 ? 'Nema faza — dodajte prvu iznad.' : 'Nema faza za zadate filtere.'}
                    </td>
                  </tr>
                ) : (
                  visible.map(({ p, i }) => (
                    <PhaseRow
                      key={p.id}
                      p={p}
                      displayNo={i + 1}
                      canEdit={canEdit}
                      engineers={engineers}
                      leads={leads}
                      locations={locations}
                      onField={updateField}
                      onCheck={toggleCheck}
                      onToggleType={toggleType}
                      onPerson={pickPerson}
                      onMove={move}
                      onDelete={removePhase}
                      onOpenDesc={setDescId}
                      onOpenDrawings={setDrawingsId}
                      dragEnabled={canEdit && !anyFilter}
                      onDragStartRow={(id) => { dragId.current = id; }}
                      onDropRow={(toId, after) => {
                        if (dragId.current) reorder(dragId.current, toId, after);
                        dragId.current = null;
                      }}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Kartice (telefon/tablet < lg) — isti handleri kao tabela */}
          <div className="space-y-3 lg:hidden">
            {visible.length === 0 ? (
              <div className="rounded-panel border border-line bg-surface px-4 py-8 text-center text-sm text-ink-disabled">
                {phases.length === 0 ? 'Nema faza — dodajte prvu iznad.' : 'Nema faza za zadate filtere.'}
              </div>
            ) : (
              visible.map(({ p, i }) => (
                <PhaseCard
                  key={p.id}
                  p={p}
                  displayNo={i + 1}
                  canEdit={canEdit}
                  engineers={engineers}
                  leads={leads}
                  locations={locations}
                  onField={updateField}
                  onCheck={toggleCheck}
                  onToggleType={toggleType}
                  onPerson={pickPerson}
                  onMove={move}
                  onDelete={removePhase}
                  onOpenDesc={setDescId}
                  onOpenDrawings={setDrawingsId}
                />
              ))
            )}
          </div>
        </>
      )}

      {/* Meta modali projekat / nalog */}
      {projectDialog && (
        <ProjectMetaDialog
          open
          onClose={() => setProjectDialog(null)}
          project={projectDialog.project}
          onSaved={(id) => switchProject(id)}
          locations={projectLocations}
          onRenameLocation={canEdit && projectDialog.project ? renameLocation : undefined}
        />
      )}
      {wpDialog && projectId && (
        <WpMetaDialog
          open
          onClose={() => setWpDialog(null)}
          projectId={projectId}
          wp={wpDialog.wp}
          onSaved={(id) => switchWp(id)}
          onApplyDefaults={canEdit && wpDialog.wp ? applyWpDefaults : undefined}
        />
      )}

      {/* Izvoz / Uvoz */}
      {exportOpen && (
        <Dialog
          open
          onClose={() => {
            // Ne zatvaraj dok uvoz traje — sekvencijalni upserti u toku.
            if (!importBusy) setExportOpen(false);
          }}
          title="Izvoz / Uvoz"
        >
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">Izaberi format i obim izvoza.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <ExportBtn label="XLSX — aktivni projekat" onClick={() => { if (activeProject) exportPlanXlsx([activeProject]); setExportOpen(false); }} />
              <ExportBtn label="XLSX — svi projekti" onClick={() => { exportPlanXlsx(projects); setExportOpen(false); }} />
              <ExportBtn label="JSON — aktivni projekat" onClick={() => { if (activeProject) exportPlanJson([activeProject], activeProject.project_code || 'projekat'); setExportOpen(false); }} />
              <ExportBtn label="JSON — svi projekti (backup)" onClick={() => { exportPlanJson(projects, 'svi'); setExportOpen(false); }} />
            </div>
            {canEdit && (
              <div className="space-y-2 border-t border-line pt-3">
                <p className="text-sm font-medium text-ink">Uvoz (JSON)</p>
                <p className="text-xs text-ink-secondary">
                  Podržani formati: izvoz ovog modula (2.0) i 1.0 JSON snapshot. Upis ide po ID-u
                  (postojeći projekti/nalozi/faze se pregaze, novi se dodaju).
                </p>
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={!!importBusy}
                  onChange={onImportFile}
                  className="block w-full text-sm text-ink-secondary file:mr-3 file:rounded-control file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-ink hover:file:bg-surface-2 disabled:opacity-60"
                />
                {importBusy && (
                  <p className="flex items-center gap-2 text-sm text-ink-secondary">
                    <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
                    <span className="tnums">{importBusy}</span>
                  </p>
                )}
                {importResult && !importBusy && (
                  <p className="text-sm text-ink-secondary">{importResult}</p>
                )}
              </div>
            )}
            <p className="text-xs text-ink-disabled">PDF Gantta stiže uz html2canvas (posebna odluka o dep-u).</p>
          </div>
        </Dialog>
      )}

      {/* Dijalozi faze */}
      {descId && (
        <PhaseDescriptionDialog
          open
          onClose={() => setDescId(null)}
          phaseName={phases.find((p) => p.id === descId)?.phaseName ?? ''}
          initial={phases.find((p) => p.id === descId)?.description ?? ''}
          onSave={(text) => updateField(descId, 'description', text)}
        />
      )}
      {drawingsId && (
        <PhaseLinkedDrawingsDialog
          open
          onClose={() => setDrawingsId(null)}
          phaseName={phases.find((p) => p.id === drawingsId)?.phaseName ?? ''}
          initial={phases.find((p) => p.id === drawingsId)?.linkedDrawings ?? []}
          onSave={(list) => updateField(drawingsId, 'linkedDrawings', list)}
        />
      )}

      <SaveStatusPanel status={save.status} />
    </div>
  );
}

// ------------------------------------------------------------------ filter kontrole

function FilterInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-secondary">
      {label}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-40 rounded-control border border-line bg-surface px-2 text-sm text-ink placeholder:text-ink-disabled"
      />
    </label>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-secondary">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-control border border-line bg-surface px-2 text-sm text-ink"
      >
        {children}
      </select>
    </label>
  );
}

function ExportBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-control border border-line px-3 py-2 text-left text-sm text-ink hover:bg-surface-2"
    >
      {label}
    </button>
  );
}

// ------------------------------------------------------------------ red faze

interface PhaseRowProps {
  p: PhaseVM;
  displayNo: number;
  canEdit: boolean;
  engineers: string[];
  leads: string[];
  locations: string[];
  onField: (id: string, field: keyof PhaseVM, value: unknown) => void;
  onCheck: (id: string, ci: number, next: boolean) => void;
  onToggleType: (id: string) => void;
  onPerson: (id: string, field: 'responsibleEngineer' | 'montageLead', value: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDelete: (id: string) => void;
  onOpenDesc: (id: string) => void;
  onOpenDrawings: (id: string) => void;
  dragEnabled: boolean;
  onDragStartRow: (id: string) => void;
  onDropRow: (toId: string, after: boolean) => void;
}

function PhaseRow({
  p,
  displayNo,
  canEdit,
  engineers,
  leads,
  locations,
  onField,
  onCheck,
  onToggleType,
  onPerson,
  onMove,
  onDelete,
  onOpenDesc,
  onOpenDrawings,
  dragEnabled,
  onDragStartRow,
  onDropRow,
}: PhaseRowProps) {
  const [dragOver, setDragOver] = useState<'above' | 'below' | null>(null);
  // % slider: lokalni preview tokom prevlačenja, commit tek na otpuštanje (paritet 1.0 —
  // business rules se ne primenjuju usred prevlačenja).
  const [pctPreview, setPctPreview] = useState<number | null>(null);
  const commitPct = () => {
    if (pctPreview != null && pctPreview !== p.pct) onField(p.id, 'pct', pctPreview);
    setPctPreview(null);
  };
  const dur = calcDuration(p.startDate, p.endDate);
  const durText = dur === -1 ? '!' : dur == null ? '—' : `${dur} d`;
  const rd = calcReadiness(p);
  const rk = calcRisk(p);
  const dis = !canEdit;
  const cellSelect = 'h-8 w-full rounded-control border border-line bg-surface px-1.5 text-sm text-ink disabled:opacity-60';
  const cellInput = 'h-8 w-full rounded-control border border-line bg-surface px-1.5 text-sm text-ink disabled:opacity-60';

  // Reminder tačka (paritet 1.0): počinje uskoro i nije spremno.
  let remDot: string | null = null;
  if (p.startDate && p.status !== 2) {
    const dd = dayDiffFromToday(p.startDate);
    if (dd !== null && dd >= 0 && dd <= 3 && !rd.ready) remDot = 'bg-status-danger';
    else if (dd !== null && dd >= 4 && dd <= 7 && !rd.ready) remDot = 'bg-status-warn';
  }

  const rowTone =
    p.status === 2
      ? 'bg-status-success-bg/30'
      : rk.level === 'high'
        ? 'bg-status-danger-bg/25'
        : rk.level === 'med'
          ? 'bg-status-warn-bg/25'
          : undefined;

  return (
    <tr
      className={cn(
        'border-b border-line-soft align-top',
        rowTone,
        dragOver === 'above' && 'shadow-[inset_0_2px_0_var(--accent)]',
        dragOver === 'below' && 'shadow-[inset_0_-2px_0_var(--accent)]',
      )}
      onDragOver={
        dragEnabled
          ? (e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setDragOver(e.clientY - r.top < r.height / 2 ? 'above' : 'below');
            }
          : undefined
      }
      onDragLeave={dragEnabled ? () => setDragOver(null) : undefined}
      onDrop={
        dragEnabled
          ? (e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const after = e.clientY - r.top >= r.height / 2;
              setDragOver(null);
              onDropRow(p.id, after);
            }
          : undefined
      }
    >
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1">
          {dragEnabled && (
            <span
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                onDragStartRow(p.id);
              }}
              className="cursor-grab text-ink-disabled hover:text-ink-secondary"
              title="Prevuci za promenu redosleda"
              aria-label="Prevuci za promenu redosleda"
            >
              <GripVertical className="h-3.5 w-3.5" aria-hidden />
            </span>
          )}
          {remDot && <span className={cn('h-2 w-2 rounded-full', remDot)} aria-hidden />}
          <span className="tnums text-ink-secondary">{displayNo}</span>
        </div>
      </td>
      <td className="px-2 py-1.5">
        <input
          value={p.phaseName}
          disabled={dis}
          onChange={(e) => onField(p.id, 'phaseName', e.target.value)}
          className={cn(cellInput, 'font-medium')}
        />
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <button
            type="button"
            disabled={dis}
            onClick={() => onToggleType(p.id)}
            title={p.phaseType === 'electrical' ? 'Elektro (klik za Mašinska)' : 'Mašinska (klik za Elektro)'}
            className={cn(
              'rounded-control px-1.5 py-0.5 text-2xs font-semibold',
              p.phaseType === 'electrical'
                ? 'bg-status-info-bg text-status-info'
                : 'bg-surface-2 text-ink-secondary',
            )}
          >
            {p.phaseType === 'electrical' ? 'E · Elektro' : 'M · Mašinska'}
          </button>
          {canEdit ? (
            <button
              type="button"
              onClick={() => onOpenDesc(p.id)}
              title={p.description?.trim() ? 'Opis (dodeljen) — izmeni' : 'Dodaj opis faze'}
              className={cn(
                'inline-flex items-center gap-0.5 rounded-control px-1 py-0.5 text-2xs hover:bg-surface-2',
                p.description?.trim() ? 'text-accent' : 'text-ink-disabled',
              )}
            >
              <FileText className="h-3 w-3" aria-hidden /> opis
            </button>
          ) : (
            p.description?.trim() && (
              <span className="inline-flex items-center gap-0.5 text-2xs text-ink-disabled" title="Ima opis">
                <FileText className="h-3 w-3" aria-hidden /> opis
              </span>
            )
          )}
          {/* Povezani crteži: chip po crtežu (klik → PDF; vidljivo i vieweru — BE gate
              presuđuje), u edit režimu olovka otvara postojeći dijalog liste. */}
          {p.linkedDrawings.map((no) => (
            <DrawingChip key={no} code={no} />
          ))}
          {canEdit &&
            (p.linkedDrawings.length ? (
              <button
                type="button"
                onClick={() => onOpenDrawings(p.id)}
                title="Izmeni listu povezanih crteža"
                className="rounded-control p-0.5 text-ink-disabled hover:bg-surface-2 hover:text-ink-secondary"
              >
                <Pencil className="h-3 w-3" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onOpenDrawings(p.id)}
                title="Poveži crteže"
                className="inline-flex items-center gap-0.5 rounded-control px-1 py-0.5 text-2xs text-ink-disabled hover:bg-surface-2"
              >
                <Link2 className="h-3 w-3" aria-hidden /> crteži
              </button>
            ))}
        </div>
      </td>
      <td className="px-2 py-1.5">
        <select
          value={p.location}
          disabled={dis}
          onChange={(e) => onField(p.id, 'location', e.target.value)}
          className={cellSelect}
          style={{ borderLeft: `3px solid ${locationColor(p.location)}` }}
        >
          {locations.includes(p.location) ? null : <option value={p.location}>{p.location || '—'}</option>}
          {locations.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5">
        <input
          type="date"
          value={p.startDate}
          disabled={dis}
          onChange={(e) => onField(p.id, 'startDate', e.target.value)}
          className={cn(cellInput, dur === -1 && 'border-status-danger')}
        />
        {p.actualStartDate && <div className="mt-0.5 text-2xs text-ink-disabled">Ostv: {p.actualStartDate}</div>}
      </td>
      <td className="px-2 py-1.5">
        <input
          type="date"
          value={p.endDate}
          disabled={dis}
          onChange={(e) => onField(p.id, 'endDate', e.target.value)}
          className={cn(cellInput, dur === -1 && 'border-status-danger')}
        />
        {p.actualEndDate && <div className="mt-0.5 text-2xs text-ink-disabled">Ostv: {p.actualEndDate}</div>}
      </td>
      <td className={cn('px-2 py-1.5 text-right tnums', dur === -1 && 'text-status-danger')}>{durText}</td>
      <td className="px-2 py-1.5">
        <select
          value={engineers.includes(p.responsibleEngineer) ? p.responsibleEngineer : ''}
          disabled={dis}
          onChange={(e) => onPerson(p.id, 'responsibleEngineer', e.target.value)}
          className={cellSelect}
        >
          <option value="">—</option>
          {!engineers.includes(p.responsibleEngineer) && p.responsibleEngineer && (
            <option value={p.responsibleEngineer}>{p.responsibleEngineer}</option>
          )}
          {engineers.map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
          {canEdit && <option value="__add__">+ Dodaj…</option>}
        </select>
      </td>
      <td className="px-2 py-1.5">
        <select
          value={leads.includes(p.montageLead) ? p.montageLead : ''}
          disabled={dis}
          onChange={(e) => onPerson(p.id, 'montageLead', e.target.value)}
          className={cellSelect}
        >
          <option value="">—</option>
          {!leads.includes(p.montageLead) && p.montageLead && (
            <option value={p.montageLead}>{p.montageLead}</option>
          )}
          {leads.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
          {canEdit && <option value="__add__">+ Dodaj…</option>}
        </select>
      </td>
      <td className="px-2 py-1.5">
        <select
          value={p.status}
          disabled={dis}
          onChange={(e) => onField(p.id, 'status', parseInt(e.target.value, 10))}
          className={cellSelect}
        >
          {STATUSES.map((s, si) => (
            <option key={s} value={si}>{s}</option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={pctPreview ?? p.pct}
            disabled={dis}
            onChange={(e) => setPctPreview(parseInt(e.target.value, 10))}
            onPointerUp={commitPct}
            onKeyUp={commitPct}
            onBlur={commitPct}
            className="w-16"
          />
          <span className="tnums w-9 text-right text-xs text-ink-secondary">{pctPreview ?? p.pct}%</span>
        </div>
      </td>
      {p.checks.map((c, ci) => (
        <td key={ci} className="px-1 py-1.5 text-center">
          <button
            type="button"
            disabled={dis}
            onClick={() => onCheck(p.id, ci, !c)}
            title={`${CHECK_LABELS[ci]}: ${c ? 'Spremno — klik za NE' : 'Nije — klik za DA'}`}
            className={cn(
              'inline-flex h-6 w-8 items-center justify-center rounded-control text-2xs font-semibold',
              c ? 'bg-status-success-bg text-status-success' : 'bg-surface-2 text-ink-disabled',
              'disabled:opacity-60',
            )}
          >
            {c ? 'DA' : 'NE'}
          </button>
        </td>
      ))}
      <td className="px-2 py-1.5">
        {rd.done ? (
          <StatusBadge tone="success" label="Završeno" />
        ) : rd.ready ? (
          <StatusBadge tone="success" label="Spreman" />
        ) : (
          <span title={rd.reasons.join('\n')}>
            <StatusBadge tone="warn" label="Nije" />
          </span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <span title={rk.reasons.map((r) => r.text).join('\n') || undefined}>
          <StatusBadge tone={riskTone(rk.level)} label={RISK_LABEL[rk.level]} />
        </span>
      </td>
      <td className="px-2 py-1.5">
        <textarea
          rows={2}
          value={p.blocker}
          disabled={dis}
          onChange={(e) => onField(p.id, 'blocker', e.target.value)}
          className={cn(
            'w-full rounded-control border bg-surface px-1.5 py-1 text-xs text-ink disabled:opacity-60',
            p.status === 3 && !p.blocker.trim() ? 'border-status-warn' : 'border-line',
          )}
          placeholder={p.status === 3 ? 'Obavezno' : ''}
        />
      </td>
      <td className="px-2 py-1.5">
        <textarea
          rows={2}
          value={p.note}
          disabled={dis}
          onChange={(e) => onField(p.id, 'note', e.target.value)}
          className="w-full rounded-control border border-line bg-surface px-1.5 py-1 text-xs text-ink disabled:opacity-60"
        />
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center justify-end gap-0.5">
          <button type="button" disabled={dis} onClick={() => onMove(p.id, -1)} title="Gore" className="rounded-control p-1 text-ink-secondary hover:bg-surface-2 disabled:opacity-40">
            <ChevronUp className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" disabled={dis} onClick={() => onMove(p.id, 1)} title="Dole" className="rounded-control p-1 text-ink-secondary hover:bg-surface-2 disabled:opacity-40">
            <ChevronDown className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" disabled={dis} onClick={() => onDelete(p.id)} title="Obriši" className="rounded-control p-1 text-status-danger hover:bg-status-danger-bg disabled:opacity-40">
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </td>
    </tr>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, FileText, RefreshCw, ChevronRight, ChevronDown } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import {
  useCompetenceFramework,
  useCreateCompetenceGroup,
  useUpdateCompetenceGroup,
  useDeleteCompetenceGroup,
  useCreateCompetence,
  useUpdateCompetence,
  useDeleteCompetence,
  useCreateCompetenceQuestion,
  useUpdateCompetenceQuestion,
  useDeleteCompetenceQuestion,
  type CompetenceLevelInput,
} from '@/api/podesavanja';

// ============================================================================
// Okvir kompetencija 360° — ADMIN UREĐIVAČ (P10). Paritet 1.0
// `ui/podesavanja/competenceFrameworkEditor.js`. Modal „Uredi okvir": lista grupa
// (ose) → expand u kompetencije; toolbar (+ Nova grupa / Opšta pitanja / Osveži).
// Sub-modali: grupa (naziv/opis/scope/redosled), kompetencija (naziv/redosled + 6
// nivoa 0–5; prazan opis nivoa = obriši), pitanja (po grupi + opšta; prompt izmena).
// GET framework vraća camelCase (nameSr/groupId/descriptorSr/textSr/sortOrder).
// Sve mutacije invalidiraju KEYS.competence → pregled se sam osveži. 42501→403.
// ============================================================================

const SCOPE_ORDER = ['core', 'strucna', 'liderska'] as const;
const SCOPE_LABEL: Record<string, string> = {
  core: 'Zajedničko (svima)',
  strucna: 'Stručno (po familiji)',
  liderska: 'Liderstvo',
};
const SCOPE_BADGE: Record<string, { bg: string; t: string }> = {
  core: { bg: '#0891b2', t: 'CORE' },
  strucna: { bg: '#2563eb', t: 'STRUČNO' },
  liderska: { bg: '#7c3aed', t: 'LIDERSTVO' },
};
const LVL_BG = ['#9ca3af', '#f59e0b', '#eab308', '#3b82f6', '#16a34a', '#7c3aed'];
const NUM_LEVELS = 6; // 0..5

// ---- normalizovani view modeli iz raw camelCase framework arrays

type Raw = Record<string, unknown>;
const rs = (o: Raw, k: string): string => (o[k] == null ? '' : String(o[k]));
const rn = (o: Raw, k: string): number => Number(o[k]);

interface VLevel {
  level: number;
  descriptor: string;
}
interface VComp {
  id: number;
  name: string;
  sort: number;
  levels: VLevel[];
}
interface VGroup {
  id: number;
  name: string;
  descriptionSr: string;
  scope: string;
  sort: number;
  competences: VComp[];
}
interface VQuestion {
  id: number;
  groupId: number | null;
  text: string;
  sort: number;
}

/** Sklopi raw framework (camelCase arrays) u sortiran model grupa→kompetencije→nivoi. */
function buildGroups(groups: Raw[], competences: Raw[], levels: Raw[]): VGroup[] {
  const levelsByComp = new Map<number, VLevel[]>();
  for (const l of levels) {
    const cid = rn(l, 'competenceId');
    const arr = levelsByComp.get(cid) ?? [];
    arr.push({ level: rn(l, 'level'), descriptor: rs(l, 'descriptorSr') });
    levelsByComp.set(cid, arr);
  }
  const compsByGroup = new Map<number, VComp[]>();
  for (const c of competences) {
    const gid = rn(c, 'groupId');
    const arr = compsByGroup.get(gid) ?? [];
    const cid = rn(c, 'id');
    arr.push({
      id: cid,
      name: rs(c, 'nameSr'),
      sort: rn(c, 'sortOrder'),
      levels: (levelsByComp.get(cid) ?? []).sort((a, b) => a.level - b.level),
    });
    compsByGroup.set(gid, arr);
  }
  return groups
    .map((g): VGroup => {
      const gid = rn(g, 'id');
      return {
        id: gid,
        name: rs(g, 'nameSr'),
        descriptionSr: rs(g, 'descriptionSr'),
        scope: rs(g, 'scope'),
        sort: rn(g, 'sortOrder'),
        competences: (compsByGroup.get(gid) ?? []).sort((a, b) => a.sort - b.sort || a.id - b.id),
      };
    })
    .sort((a, b) => a.sort - b.sort || SCOPE_ORDER.indexOf(a.scope as never) - SCOPE_ORDER.indexOf(b.scope as never));
}

function buildQuestions(questions: Raw[]): VQuestion[] {
  return questions
    .map((q): VQuestion => ({
      id: rn(q, 'id'),
      groupId: q['groupId'] == null ? null : rn(q, 'groupId'),
      text: rs(q, 'textSr'),
      sort: rn(q, 'sortOrder'),
    }))
    .sort((a, b) => a.sort - b.sort || a.id - b.id);
}

function nextSort(sorts: number[]): number {
  const arr = sorts.filter((n) => Number.isFinite(n));
  return arr.length ? Math.max(...arr) + 10 : 10;
}
/** ApiError → čitljiva srpska poruka (403/409/422 mapa). */
function errMsg(e: unknown, fallback = 'Snimanje nije uspelo.'): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return 'Nemate dozvolu (samo administrator).';
    if (e.status === 409) return 'Već postoji stavka sa tim podacima (duplikat).';
    return e.message || fallback;
  }
  return fallback;
}

const SELECT_CLS = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink';
const TA_CLS =
  'w-full resize-y rounded-control border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-disabled focus-visible:border-accent focus-visible:outline-none';

// ============================================================================
// GLAVNI MODAL — lista grupa
// ============================================================================

export function CompetenceEditor({ onClose }: { onClose: () => void }) {
  const q = useCompetenceFramework();
  const f = q.data?.data;

  const groups = useMemo(
    () => (f ? buildGroups(f.groups, f.competences, f.levels) : []),
    [f],
  );
  const questions = useMemo(() => (f ? buildQuestions(f.questions) : []), [f]);

  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  // aktivni sub-modali
  const [groupModal, setGroupModal] = useState<{ mode: 'new' | 'edit'; row?: VGroup } | null>(null);
  const [compModal, setCompModal] = useState<{ groupId: number; groupName: string; row?: VComp } | null>(null);
  const [qModal, setQModal] = useState<{ groupId: number | null; groupName: string } | null>(null);
  const [delGroup, setDelGroup] = useState<VGroup | null>(null);
  const [delComp, setDelComp] = useState<VComp | null>(null);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const qCountForGroup = (gid: number | null) => questions.filter((x) => x.groupId === gid).length;

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        size="2xl"
        title="Uredi okvir kompetencija (360°)"
        footer={
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
        }
      >
        <p className="mb-3 text-xs text-ink-secondary">
          Grupe (ose), kompetencije, opisi nivoa 0–5 i pitanja. Izmene su dozvoljene samo administratoru.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => setGroupModal({ mode: 'new' })}>
            <Plus className="h-4 w-4" aria-hidden /> Nova grupa (osa)
          </Button>
          <Button variant="secondary" onClick={() => setQModal({ groupId: null, groupName: 'Opšta pitanja' })}>
            <FileText className="h-4 w-4" aria-hidden /> Opšta pitanja
          </Button>
          <Button variant="secondary" onClick={() => q.refetch()} loading={q.isFetching}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Osveži
          </Button>
        </div>

        {q.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>
        ) : groups.length === 0 ? (
          <EmptyState title="Nema grupa. Dodaj prvu osu dugmetom „Nova grupa”." />
        ) : (
          <div className="space-y-2">
            {groups.map((g) => {
              const badge = SCOPE_BADGE[g.scope] ?? { bg: '#64748b', t: (g.scope || '').toUpperCase() };
              const open = expanded.has(g.id);
              return (
                <section key={g.id} className="overflow-hidden rounded-panel border border-line bg-surface">
                  <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggle(g.id)}
                      className="rounded p-0.5 text-ink-secondary hover:bg-surface"
                      aria-expanded={open}
                      aria-label={open ? 'Skupi' : 'Razvij'}
                    >
                      {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <span
                      className="rounded px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wide text-white"
                      style={{ background: badge.bg }}
                    >
                      {badge.t}
                    </span>
                    <span className="flex-1 truncate font-semibold text-ink">{g.name}</span>
                    <span className="whitespace-nowrap text-2xs text-ink-secondary">
                      {g.competences.length} komp. · {qCountForGroup(g.id)} pit. · #{g.sort}
                    </span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setCompModal({ groupId: g.id, groupName: g.name })}
                        className="rounded px-1.5 py-0.5 text-2xs text-ink-secondary hover:bg-surface hover:text-ink"
                        title="Dodaj kompetenciju"
                      >
                        <Plus className="inline h-3 w-3" /> Kompetencija
                      </button>
                      <button
                        type="button"
                        onClick={() => setQModal({ groupId: g.id, groupName: g.name })}
                        className="rounded p-1 text-ink-secondary hover:bg-surface hover:text-ink"
                        title="Pitanja ose"
                        aria-label="Pitanja ose"
                      >
                        <FileText className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setGroupModal({ mode: 'edit', row: g })}
                        className="rounded p-1 text-ink-secondary hover:bg-surface hover:text-ink"
                        title="Uredi grupu"
                        aria-label="Uredi grupu"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDelGroup(g)}
                        className="rounded p-1 text-ink-secondary hover:bg-surface hover:text-status-danger"
                        title="Obriši grupu"
                        aria-label="Obriši grupu"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {open && (
                    <div className="divide-y divide-line-soft">
                      {g.competences.length === 0 ? (
                        <div className="px-3 py-2 pl-9 text-sm italic text-ink-disabled">Nema kompetencija u ovoj osi.</div>
                      ) : (
                        g.competences.map((c) => (
                          <div key={c.id} className="flex items-center gap-2 px-3 py-1.5 pl-9">
                            <span className="flex-1 text-sm font-medium text-ink">{c.name}</span>
                            <span className="whitespace-nowrap text-2xs text-ink-secondary">
                              {c.levels.length}/6 nivoa · #{c.sort}
                            </span>
                            <button
                              type="button"
                              onClick={() => setCompModal({ groupId: g.id, groupName: g.name, row: c })}
                              className="rounded px-1.5 py-0.5 text-2xs text-ink-secondary hover:bg-surface-2 hover:text-ink"
                              title="Uredi"
                            >
                              <Pencil className="inline h-3 w-3" /> Uredi
                            </button>
                            <button
                              type="button"
                              onClick={() => setDelComp(c)}
                              className="rounded p-1 text-ink-secondary hover:bg-surface-2 hover:text-status-danger"
                              title="Obriši"
                              aria-label="Obriši kompetenciju"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </Dialog>

      {groupModal && (
        <GroupModal
          mode={groupModal.mode}
          row={groupModal.row}
          allSorts={groups.map((g) => g.sort)}
          onClose={() => setGroupModal(null)}
          onSaved={(id) => {
            setGroupModal(null);
            if (id) setExpanded((prev) => new Set(prev).add(id));
          }}
        />
      )}
      {compModal && (
        <CompetenceModal
          groupId={compModal.groupId}
          groupName={compModal.groupName}
          row={compModal.row}
          siblingSorts={(groups.find((g) => g.id === compModal.groupId)?.competences ?? []).map((c) => c.sort)}
          onClose={() => setCompModal(null)}
          onSaved={() => {
            setExpanded((prev) => new Set(prev).add(compModal.groupId));
            setCompModal(null);
          }}
        />
      )}
      {qModal && (
        <QuestionsModal
          groupId={qModal.groupId}
          groupName={qModal.groupName}
          questions={questions.filter((x) => x.groupId === qModal.groupId)}
          onClose={() => setQModal(null)}
        />
      )}
      {delGroup && (
        <DeleteGroupModal
          group={delGroup}
          questionCount={qCountForGroup(delGroup.id)}
          onClose={() => setDelGroup(null)}
          onDeleted={() => {
            setExpanded((prev) => {
              const next = new Set(prev);
              next.delete(delGroup.id);
              return next;
            });
            setDelGroup(null);
          }}
        />
      )}
      {delComp && <DeleteCompModal comp={delComp} onClose={() => setDelComp(null)} onDeleted={() => setDelComp(null)} />}
    </>
  );
}

// ============================================================================
// GRUPA (osa) — dodaj / uredi
// ============================================================================

function GroupModal({
  mode,
  row,
  allSorts,
  onClose,
  onSaved,
}: {
  mode: 'new' | 'edit';
  row?: VGroup;
  allSorts: number[];
  onClose: () => void;
  onSaved: (createdId?: number) => void;
}) {
  const createM = useCreateCompetenceGroup();
  const updateM = useUpdateCompetenceGroup();
  const isNew = mode === 'new';

  const [name, setName] = useState(row?.name ?? '');
  const [desc, setDesc] = useState(row?.descriptionSr ?? '');
  const [scope, setScope] = useState(row?.scope ?? 'core');
  const [sortOrder, setSortOrder] = useState(String(isNew ? nextSort(allSorts) : (row?.sort ?? 0)));
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!name.trim()) return setErr('Naziv ose je obavezan.');
    const body = {
      nameSr: name.trim(),
      descriptionSr: desc.trim() || null,
      scope,
      sortOrder: Number.parseInt(sortOrder, 10) || nextSort(allSorts),
    };
    try {
      if (isNew) {
        const res = (await createM.mutateAsync(body)) as { data?: { id?: number } } | undefined;
        toast('✅ Osa dodata');
        onSaved(res?.data?.id);
      } else if (row) {
        await updateM.mutateAsync({ id: row.id, ...body });
        toast('✅ Osa izmenjena');
        onSaved();
      }
    } catch (e) {
      setErr(errMsg(e));
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={isNew ? 'Nova grupa (osa)' : `Grupa: ${row?.name ?? ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={save} loading={createM.isPending || updateM.isPending}>
            {isNew ? 'Dodaj osu' : 'Snimi izmene'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        <FormField label="Naziv ose" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="npr. Saradnja i komunikacija" />
        </FormField>
        <FormField label="Opis (opciono)">
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="Kratko objašnjenje šta ova osa pokriva…" className={TA_CLS} />
        </FormField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Domen (scope)" required>
            <select value={scope} onChange={(e) => setScope(e.target.value)} className={SELECT_CLS}>
              {SCOPE_ORDER.map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Redosled">
            <input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} step={1} className={SELECT_CLS} />
          </FormField>
        </div>
      </div>
    </Dialog>
  );
}

function DeleteGroupModal({
  group,
  questionCount,
  onClose,
  onDeleted,
}: {
  group: VGroup;
  questionCount: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const delM = useDeleteCompetenceGroup();
  const [err, setErr] = useState<string | null>(null);
  const nComp = group.competences.length;

  async function go() {
    setErr(null);
    try {
      await delM.mutateAsync({ id: group.id });
      toast('🗑 Osa obrisana');
      onDeleted();
    } catch (e) {
      setErr(errMsg(e, 'Brisanje nije uspelo (verovatno postoje vezane kompetencije/pitanja).'));
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Brisanje grupe (ose)"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button variant="danger" onClick={go} loading={delM.isPending}>
            Obriši
          </Button>
        </>
      }
    >
      {err && <p className="mb-2 rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
      <p className="text-sm text-ink">
        Obrisati osu <b>„{group.name}”</b>?
      </p>
      {(nComp > 0 || questionCount > 0) && (
        <p className="mt-2 text-sm text-status-warn">
          Ova osa ima <b>{nComp}</b> kompetencija i <b>{questionCount}</b> pitanja. Brisanje može da bude blokirano ako postoje vezani redovi.
        </p>
      )}
    </Dialog>
  );
}

// ============================================================================
// KOMPETENCIJA — dodaj / uredi (+ nivoi 0–5)
// ============================================================================

function CompetenceModal({
  groupId,
  groupName,
  row,
  siblingSorts,
  onClose,
  onSaved,
}: {
  groupId: number;
  groupName: string;
  row?: VComp;
  siblingSorts: number[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const createM = useCreateCompetence();
  const updateM = useUpdateCompetence();
  const isNew = !row;

  const [name, setName] = useState(row?.name ?? '');
  const [sortOrder, setSortOrder] = useState(String(isNew ? nextSort(siblingSorts) : (row?.sort ?? 0)));
  const [levels, setLevels] = useState<string[]>(() => {
    const map = new Map<number, string>();
    (row?.levels ?? []).forEach((l) => map.set(l.level, l.descriptor));
    return Array.from({ length: NUM_LEVELS }, (_, i) => map.get(i) ?? '');
  });
  const [err, setErr] = useState<string | null>(null);

  const setLevel = (i: number, v: string) =>
    setLevels((prev) => {
      const next = [...prev];
      next[i] = v;
      return next;
    });

  async function save() {
    setErr(null);
    if (!name.trim()) return setErr('Naziv kompetencije je obavezan.');
    // Prazan opis nivoa = obriši nivo (BE tumači prazan descriptorSr kao delete).
    const levelInputs: CompetenceLevelInput[] = levels.map((d, level) => ({ level, descriptorSr: d.trim() }));
    const body = {
      groupId,
      nameSr: name.trim(),
      sortOrder: Number.parseInt(sortOrder, 10) || nextSort(siblingSorts),
      levels: levelInputs,
    };
    try {
      if (isNew) {
        await createM.mutateAsync(body);
        toast('✅ Kompetencija dodata');
      } else if (row) {
        await updateM.mutateAsync({ id: row.id, ...body });
        toast('✅ Kompetencija snimljena');
      }
      onSaved();
    } catch (e) {
      // Parcijalni neuspeh nivoa: BE vraća 422/P0001; prikaži poruku, ostavi formu otvorenu.
      setErr(errMsg(e));
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={isNew ? `Nova kompetencija — ${groupName}` : `Kompetencija: ${row?.name ?? ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={save} loading={createM.isPending || updateM.isPending}>
            {isNew ? 'Dodaj kompetenciju' : 'Snimi kompetenciju'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr,120px]">
          <FormField label="Naziv kompetencije" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="npr. Timski rad" />
          </FormField>
          <FormField label="Redosled">
            <input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} step={1} className={SELECT_CLS} />
          </FormField>
        </div>

        <div>
          <div className="mb-1 text-2xs font-bold uppercase tracking-wide text-ink">Opisi ponašanja po nivoima (0–5)</div>
          <p className="mb-2 text-xs text-ink-secondary">Prazan opis nivoa se neće upisati (ili će postojeći biti obrisan).</p>
          <div className="space-y-1.5">
            {levels.map((val, lvl) => (
              <div key={lvl} className="flex items-start gap-2">
                <span
                  className="mt-1 flex h-7 w-7 flex-none items-center justify-center rounded text-sm font-bold text-white"
                  style={{ background: LVL_BG[lvl] }}
                >
                  {lvl}
                </span>
                <textarea
                  value={val}
                  onChange={(e) => setLevel(lvl, e.target.value)}
                  rows={2}
                  placeholder={`Opis ponašanja za nivo ${lvl}…`}
                  className={TA_CLS}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function DeleteCompModal({ comp, onClose, onDeleted }: { comp: VComp; onClose: () => void; onDeleted: () => void }) {
  const delM = useDeleteCompetence();
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    try {
      await delM.mutateAsync({ id: comp.id });
      toast('🗑 Kompetencija obrisana');
      onDeleted();
    } catch (e) {
      setErr(errMsg(e, 'Brisanje nije uspelo (vezani redovi ili nema dozvole).'));
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Brisanje kompetencije"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button variant="danger" onClick={go} loading={delM.isPending}>
            Obriši
          </Button>
        </>
      }
    >
      {err && <p className="mb-2 rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
      <p className="text-sm text-ink">
        Obrisati kompetenciju <b>„{comp.name}”</b> i sve njene opise nivoa?
      </p>
    </Dialog>
  );
}

// ============================================================================
// PITANJA (po grupi ili opšta — groupId null)
// ============================================================================

function QuestionsModal({
  groupId,
  groupName,
  questions,
  onClose,
}: {
  groupId: number | null;
  groupName: string;
  questions: VQuestion[];
  onClose: () => void;
}) {
  const createM = useCreateCompetenceQuestion();
  const updateM = useUpdateCompetenceQuestion();
  const delM = useDeleteCompetenceQuestion();
  const [err, setErr] = useState<string | null>(null);

  const title = groupId ? `Pitanja — ${groupName}` : 'Opšta pitanja (za sve)';

  async function addOne() {
    const text = (window.prompt('Tekst novog pitanja:', '') ?? '').trim();
    if (!text) return;
    setErr(null);
    try {
      await createM.mutateAsync({ groupId, textSr: text, sortOrder: nextSort(questions.map((x) => x.sort)) });
      toast('✅ Pitanje dodato');
    } catch (e) {
      setErr(errMsg(e));
    }
  }
  async function editOne(qn: VQuestion) {
    const text = (window.prompt('Izmeni tekst pitanja:', qn.text) ?? '').trim();
    if (!text || text === qn.text) return;
    setErr(null);
    try {
      await updateM.mutateAsync({ id: qn.id, textSr: text });
      toast('✅ Pitanje izmenjeno');
    } catch (e) {
      setErr(errMsg(e));
    }
  }
  async function delOne(qn: VQuestion) {
    if (!window.confirm(`Obrisati pitanje?\n\n„${qn.text}”`)) return;
    setErr(null);
    try {
      await delM.mutateAsync({ id: qn.id });
      toast('🗑 Pitanje obrisano');
    } catch (e) {
      setErr(errMsg(e, 'Brisanje pitanja nije uspelo.'));
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={title}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Zatvori
        </Button>
      }
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-xs text-ink-secondary">Otvorena pitanja koja se postavljaju u proceni.</span>
        <Button onClick={addOne} loading={createM.isPending}>
          <Plus className="h-4 w-4" aria-hidden /> Novo pitanje
        </Button>
      </div>
      {err && <p className="mb-2 rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
      {questions.length === 0 ? (
        <EmptyState title="Nema pitanja. Dodaj prvo dugmetom „Novo pitanje”." />
      ) : (
        <div className="divide-y divide-line-soft rounded-panel border border-line bg-surface">
          {questions.map((qn) => (
            <div key={qn.id} className="flex items-center gap-2 px-3 py-2">
              <span className="w-8 flex-none text-2xs text-ink-secondary">#{qn.sort}</span>
              <span className="flex-1 text-sm text-ink">{qn.text}</span>
              <button
                type="button"
                onClick={() => editOne(qn)}
                className="rounded p-1 text-ink-secondary hover:bg-surface-2 hover:text-ink"
                title="Izmeni"
                aria-label="Izmeni pitanje"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => delOne(qn)}
                className="rounded p-1 text-ink-secondary hover:bg-surface-2 hover:text-status-danger"
                title="Obriši"
                aria-label="Obriši pitanje"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

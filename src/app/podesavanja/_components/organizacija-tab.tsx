'use client';

import { useEffect, useMemo, useState } from 'react';
import { Pencil, Trash2, Check, ClipboardList, AlertTriangle, Ban, X as XIcon } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Markdown } from '@/lib/markdown';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import {
  useOrgStructure,
  useCreateDepartment,
  useUpdateDepartment,
  useDeleteDepartment,
  useCreateSubDepartment,
  useUpdateSubDepartment,
  useDeleteSubDepartment,
  useCreateJobPosition,
  useUpdateJobPosition,
  useDeleteJobPosition,
  useSaveJobPositionProfile,
  useBulkJobPositionProfiles,
  type Department,
  type SubDepartment,
  type JobPosition,
} from '@/api/podesavanja';
import {
  parsePositionDescriptions,
  matchPositions,
  parsedHasContent,
  type ParsedPosition,
} from '@/lib/position-desc-parser';

// ============================================================================
// Organizacija — struktura CRUD + opis pozicije + bulk import (paritet 1.0
// `podesavanja/orgStructureTab.js`). Trostepeno stablo Odeljenje → Pododeljenje →
// Radno mesto (+ pozicije direktno pod odeljenjem). „✓ opisana" indikator.
// Struktura (dodaj/preimenuj/obriši) = SAMO admin; opis pozicije + bulk = org_profile
// (gating tab-a je na page-nivou). Modal „Opis" = 4 md taba + live preview; modal
// „Bulk import" = port parsera + fuzzy match + live preview + POTPUNA ZAMENA confirm.
// Casing: BE prima/vraća camelCase (JobPosition.summaryMd itd.) — bez snake_case.
// ============================================================================

/** Ima li pozicija ikakav opis (bar jedna md sekcija popunjena)? */
function posHasProfile(p: JobPosition): boolean {
  return !!(
    (p.summaryMd && p.summaryMd.trim()) ||
    (p.expectationsMd && p.expectationsMd.trim()) ||
    (p.responsibilitiesMd && p.responsibilitiesMd.trim()) ||
    (p.dutiesMd && p.dutiesMd.trim())
  );
}

const bySort = <T extends { sortOrder: number; name: string }>(a: T, b: T) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'sr');

type PromptState = {
  title: string;
  label: string;
  initial: string;
  onSubmit: (value: string) => void;
};

export function OrganizacijaTab() {
  const { user } = useAuth();
  const canStruct = (user?.role ?? '').trim().toLowerCase() === 'admin';

  const q = useOrgStructure();
  const s = q.data?.data;

  const createDept = useCreateDepartment();
  const updateDept = useUpdateDepartment();
  const deleteDept = useDeleteDepartment();
  const createSub = useCreateSubDepartment();
  const updateSub = useUpdateSubDepartment();
  const deleteSub = useDeleteSubDepartment();
  const createPos = useCreateJobPosition();
  const updatePos = useUpdateJobPosition();
  const deletePos = useDeleteJobPosition();

  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirm, setConfirm] = useState<{ message: string; danger?: boolean; onConfirm: () => void } | null>(null);
  const [descPos, setDescPos] = useState<JobPosition | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const depts = useMemo(() => [...(s?.departments ?? [])].sort(bySort), [s]);

  // Zajednički handler: pokreni mutaciju, mapiraj greške na toast (403/409/422).
  async function run(p: Promise<unknown>, okMsg: string) {
    try {
      await p;
      toast(okMsg);
    } catch (e) {
      toast(errToast(e));
    }
  }

  if (q.isLoading) return <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>;
  if (!s) return <EmptyState title="Struktura nije dostupna" />;

  // ---- struktura akcije (prompt/confirm modali) ----
  const addDept = () =>
    setPrompt({
      title: 'Novo odeljenje',
      label: 'Naziv odeljenja',
      initial: '',
      onSubmit: (name) => run(createDept.mutateAsync({ name }), '✅ Odeljenje dodato'),
    });
  const editDept = (d: Department) =>
    setPrompt({
      title: 'Preimenuj odeljenje',
      label: 'Novo ime odeljenja',
      initial: d.name,
      onSubmit: (name) => name !== d.name && run(updateDept.mutateAsync({ id: d.id, name }), '✅ Odeljenje preimenovano'),
    });
  const delDept = (d: Department) => {
    const hasChildren =
      s.subDepartments.some((x) => x.departmentId === d.id) || s.jobPositions.some((x) => x.departmentId === d.id);
    setConfirm({
      message: hasChildren
        ? `Odeljenje „${d.name}" ima pododeljenja ili radna mesta.\nBrisanjem odeljenja brišu se i sva pododeljenja i radna mesta ispod njega.\nNastaviti?`
        : `Obrisati odeljenje „${d.name}"?`,
      danger: true,
      onConfirm: () => run(deleteDept.mutateAsync({ id: d.id }), '🗑 Odeljenje obrisano'),
    });
  };

  const addSub = (d: Department) =>
    setPrompt({
      title: 'Novo pododeljenje',
      label: `Naziv pododeljenja u „${d.name}"`,
      initial: '',
      onSubmit: (name) => run(createSub.mutateAsync({ departmentId: d.id, name }), '✅ Pododeljenje dodato'),
    });
  const editSub = (sd: SubDepartment) =>
    setPrompt({
      title: 'Preimenuj pododeljenje',
      label: 'Novo ime pododeljenja',
      initial: sd.name,
      onSubmit: (name) => name !== sd.name && run(updateSub.mutateAsync({ id: sd.id, name }), '✅ Pododeljenje preimenovano'),
    });
  const delSub = (sd: SubDepartment) => {
    const hasPos = s.jobPositions.some((x) => x.subDepartmentId === sd.id);
    setConfirm({
      message: hasPos
        ? `Pododeljenje „${sd.name}" ima radna mesta.\nBrisanjem pododeljenja, radna mesta ostaju ali se odvajaju od pododeljenja.\nNastaviti?`
        : `Obrisati pododeljenje „${sd.name}"?`,
      danger: true,
      onConfirm: () => run(deleteSub.mutateAsync({ id: sd.id }), '🗑 Pododeljenje obrisano'),
    });
  };

  const addPos = (departmentId: number, subDepartmentId: number | null, parentName: string) =>
    setPrompt({
      title: 'Novo radno mesto',
      label: `Naziv radnog mesta u „${parentName}"`,
      initial: '',
      onSubmit: (name) => run(createPos.mutateAsync({ departmentId, subDepartmentId, name }), '✅ Radno mesto dodato'),
    });
  const editPos = (p: JobPosition) =>
    setPrompt({
      title: 'Preimenuj radno mesto',
      label: 'Novo ime radnog mesta',
      initial: p.name,
      onSubmit: (name) => name !== p.name && run(updatePos.mutateAsync({ id: p.id, name }), '✅ Radno mesto preimenovano'),
    });
  const delPos = (p: JobPosition) =>
    setConfirm({
      message: `Obrisati radno mesto „${p.name}"?`,
      danger: true,
      onConfirm: () => run(deletePos.mutateAsync({ id: p.id }), '🗑 Radno mesto obrisano'),
    });

  const renderPosRow = (p: JobPosition, direct: boolean) => {
    const has = posHasProfile(p);
    return (
      <div key={p.id} className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-surface-2">
        <span className={`flex items-center gap-1.5 text-sm ${direct ? 'text-ink' : 'text-ink'}`}>
          {has && <Check className="h-3.5 w-3.5 text-status-success" aria-label="Opis unet" />}
          {p.name}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setDescPos(p)}
            title={has ? 'Uredi opis pozicije' : 'Definiši opis pozicije'}
            className="rounded p-1 text-ink-secondary hover:bg-surface hover:text-ink"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {canStruct && (
            <>
              <button onClick={() => editPos(p)} title="Preimenuj" className="rounded px-1.5 py-0.5 text-xs text-ink-secondary hover:bg-surface hover:text-ink">
                Preimenuj
              </button>
              <button onClick={() => delPos(p)} title="Obriši" className="rounded p-1 text-ink-secondary hover:bg-surface hover:text-status-danger">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {canStruct && <Button onClick={addDept}>+ Novo odeljenje</Button>}
        <Button variant="secondary" onClick={() => setBulkOpen(true)}>
          <ClipboardList className="h-4 w-4" aria-hidden /> Bulk import opisa
        </Button>
        <p className="ml-auto max-w-md text-xs text-ink-secondary">
          {canStruct
            ? 'Strukturu menja admin. Opis pozicije: admin / menadžment / pm / lpm.'
            : 'Pregled strukture. Definišite opis pozicije (olovka) ili nalepite više odjednom (Bulk import).'}
        </p>
      </div>

      {depts.length === 0 ? (
        <EmptyState title="Nema unesenih odeljenja" />
      ) : (
        <div className="space-y-3">
          {depts.map((d) => {
            const subs = s.subDepartments.filter((x) => x.departmentId === d.id).sort(bySort);
            const directPos = s.jobPositions.filter((p) => p.departmentId === d.id && !p.subDepartmentId).sort(bySort);
            return (
              <div key={d.id} className="rounded-panel border border-line bg-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-ink">{d.name}</div>
                  {canStruct && (
                    <div className="flex shrink-0 items-center gap-1 text-xs">
                      <button onClick={() => addSub(d)} className="rounded px-1.5 py-0.5 text-ink-secondary hover:bg-surface-2 hover:text-ink">
                        + Pododeljenje
                      </button>
                      <button onClick={() => addPos(d.id, null, d.name)} className="rounded px-1.5 py-0.5 text-ink-secondary hover:bg-surface-2 hover:text-ink">
                        + Radno mesto
                      </button>
                      <button onClick={() => editDept(d)} className="rounded px-1.5 py-0.5 text-ink-secondary hover:bg-surface-2 hover:text-ink">
                        Preimenuj
                      </button>
                      <button onClick={() => delDept(d)} title="Obriši" className="rounded p-1 text-ink-secondary hover:bg-surface-2 hover:text-status-danger">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                <div className="mt-2 space-y-2 pl-2">
                  {subs.map((sd) => {
                    const positions = s.jobPositions.filter((p) => p.subDepartmentId === sd.id).sort(bySort);
                    return (
                      <div key={sd.id} className="rounded border border-line-soft bg-surface-2/40 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium text-ink">▸ {sd.name}</div>
                          {canStruct && (
                            <div className="flex shrink-0 items-center gap-1 text-xs">
                              <button onClick={() => addPos(d.id, sd.id, sd.name)} className="rounded px-1.5 py-0.5 text-ink-secondary hover:bg-surface hover:text-ink">
                                + Radno mesto
                              </button>
                              <button onClick={() => editSub(sd)} className="rounded px-1.5 py-0.5 text-ink-secondary hover:bg-surface hover:text-ink">
                                Preimenuj
                              </button>
                              <button onClick={() => delSub(sd)} title="Obriši" className="rounded p-1 text-ink-secondary hover:bg-surface hover:text-status-danger">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                        <div className="mt-1 space-y-0.5 pl-3">
                          {positions.length === 0 ? (
                            <p className="px-2 py-1 text-xs text-ink-disabled">— nema radnih mesta —</p>
                          ) : (
                            positions.map((p) => renderPosRow(p, false))
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {directPos.length > 0 && (
                    <div className="space-y-0.5">
                      {subs.length > 0 && <p className="px-2 pt-1 text-2xs uppercase text-ink-disabled">Direktno pod odeljenjem</p>}
                      {directPos.map((p) => renderPosRow(p, true))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {prompt && <PromptModal state={prompt} onClose={() => setPrompt(null)} />}
      {confirm && <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />}
      {descPos && <DescModal position={descPos} onClose={() => setDescPos(null)} />}
      {bulkOpen && <BulkImportModal positions={s.jobPositions} onClose={() => setBulkOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- error → toast
function errToast(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return '⚠ Nemate dozvolu za ovu radnju';
    if (e.status === 409) return '⚠ Već postoji stavka sa tim nazivom';
    if (e.status === 422) return '⚠ Neispravni podaci';
    return `⚠ ${e.message}`;
  }
  return '⚠ Radnja nije uspela — pokušajte ponovo';
}

// ---------------------------------------------------------------- Prompt (dodaj/preimenuj)
function PromptModal({ state, onClose }: { state: PromptState; onClose: () => void }) {
  const [value, setValue] = useState(state.initial);
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    state.onSubmit(v);
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={state.title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={submit} disabled={!value.trim()}>
            Sačuvaj
          </Button>
        </>
      }
    >
      <label className="block space-y-1.5">
        <span className="block text-base font-medium text-ink">{state.label}</span>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink focus-visible:border-accent focus-visible:outline-none"
        />
      </label>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Confirm (obriši)
function ConfirmModal({
  state,
  onClose,
}: {
  state: { message: string; danger?: boolean; onConfirm: () => void };
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="Potvrda"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button
            variant={state.danger ? 'danger' : 'primary'}
            onClick={() => {
              state.onConfirm();
              onClose();
            }}
          >
            Potvrdi
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-line text-sm text-ink">{state.message}</p>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Opis pozicije (4 md taba)
const DESC_TABS: { key: keyof DescForm; label: string }[] = [
  { key: 'summaryMd', label: 'Sažetak' },
  { key: 'expectationsMd', label: 'Očekivanja' },
  { key: 'responsibilitiesMd', label: 'Odgovornosti' },
  { key: 'dutiesMd', label: 'Obaveze' },
];
interface DescForm {
  summaryMd: string;
  expectationsMd: string;
  responsibilitiesMd: string;
  dutiesMd: string;
}

function DescModal({ position, onClose }: { position: JobPosition; onClose: () => void }) {
  const saveM = useSaveJobPositionProfile();
  const [form, setForm] = useState<DescForm>({
    summaryMd: position.summaryMd ?? '',
    expectationsMd: position.expectationsMd ?? '',
    responsibilitiesMd: position.responsibilitiesMd ?? '',
    dutiesMd: position.dutiesMd ?? '',
  });
  const [active, setActive] = useState<keyof DescForm>('summaryMd');
  const [err, setErr] = useState<string | null>(null);

  const cur = form[active];

  async function save() {
    setErr(null);
    try {
      await saveM.mutateAsync({
        id: position.id,
        summaryMd: form.summaryMd.trim() || null,
        expectationsMd: form.expectationsMd.trim() || null,
        responsibilitiesMd: form.responsibilitiesMd.trim() || null,
        dutiesMd: form.dutiesMd.trim() || null,
      });
      toast('✅ Opis pozicije snimljen');
      onClose();
    } catch (e) {
      const forbidden = e instanceof ApiError && e.status === 403;
      setErr(forbidden ? 'Nemate dozvolu (admin/menadžment/pm/lpm).' : e instanceof ApiError ? e.message : 'Snimanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={`Opis pozicije: ${position.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={save} loading={saveM.isPending}>
            Snimi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-secondary">
          Definišite sažetak, očekivanja, odgovornosti i obaveze. Tekst se prikazuje radnicima u <strong className="text-ink">Moj profil</strong>. Podržan je jednostavan markdown.
        </p>
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}

        <div className="flex gap-1 border-b border-line" role="tablist">
          {DESC_TABS.map((t) => {
            const on = active === t.key;
            const filled = !!form[t.key].trim();
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={on}
                onClick={() => setActive(t.key)}
                className={`flex items-center gap-1 border-b-2 px-3 py-2 text-sm ${
                  on ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-secondary hover:text-ink'
                }`}
              >
                {filled && <Check className="h-3 w-3 text-status-success" aria-hidden />}
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col">
            <label className="mb-1 text-xs text-ink-secondary">Markdown unos</label>
            <textarea
              value={cur}
              onChange={(e) => setForm((p) => ({ ...p, [active]: e.target.value }))}
              className="min-h-[280px] w-full resize-y rounded-control border border-line bg-surface px-3 py-2 font-mono text-sm text-ink focus-visible:border-accent focus-visible:outline-none"
            />
          </div>
          <div className="flex flex-col">
            <label className="mb-1 text-xs text-ink-secondary">Pregled</label>
            <div className="min-h-[280px] overflow-y-auto rounded-control border border-line bg-surface px-3 py-2 text-sm">
              {cur.trim() ? (
                <Markdown source={cur} className="text-sm leading-relaxed text-ink-secondary" />
              ) : (
                <span className="text-ink-disabled">(prazno — popunite levo polje)</span>
              )}
            </div>
          </div>
        </div>

        {position.profileUpdatedAt && (
          <p className="text-xs text-ink-disabled">
            Poslednja izmena: {formatDateTime(position.profileUpdatedAt)}
            {position.profileUpdatedBy && <> · {position.profileUpdatedBy}</>}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Bulk import
const BULK_TEMPLATE = `== Šef proizvodnje ==
[Opis]
Operativno vodi proizvodnju u smeni, prati realizaciju plana i raspoređuje radnike.

[Očekivanja]
- Realizacija dnevnog plana proizvodnje
- Komunikacija sa odeljenjem kvaliteta i logistike
- Mentorstvo mlađih kolega

[Odgovornosti]
- Bezbednost zaposlenih na liniji
- Kvalitet i rok isporuke
- Tačnost prijava u sistemu praćenja

[Obaveze]
- Dnevni izveštaj smene
- Predaja smene sa pisanim brifingom
- Eskalacija zastoja > 30 min

== Vođa smene ==
[Opis]
...
`;

function BulkImportModal({ positions, onClose }: { positions: JobPosition[]; onClose: () => void }) {
  const bulkM = useBulkJobPositionProfiles();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Debounce parsiranja (200ms) — ne opterećuj na svaki keystroke.
  const onText = (v: string) => {
    setText(v);
  };
  // useMemo nad `debounced` state-om koji se setuje sa zakašnjenjem.
  useDebounce(text, 200, setDebounced);

  const { matched, unmatched } = useMemo(() => {
    if (!debounced.trim()) return { matched: [] as { parsed: ParsedPosition; db: JobPosition }[], unmatched: [] as ParsedPosition[] };
    const parsed = parsePositionDescriptions(debounced);
    return matchPositions(parsed, positions);
  }, [debounced, positions]);

  const withContent = useMemo(() => matched.filter((m) => parsedHasContent(m.parsed)), [matched]);
  const noContent = useMemo(() => matched.filter((m) => !parsedHasContent(m.parsed)), [matched]);

  async function apply() {
    setConfirmOpen(false);
    setErr(null);
    const items = withContent.map((m) => ({
      id: m.db.id,
      summaryMd: m.parsed.summaryMd || null,
      expectationsMd: m.parsed.expectationsMd || null,
      responsibilitiesMd: m.parsed.responsibilitiesMd || null,
      dutiesMd: m.parsed.dutiesMd || null,
    }));
    try {
      const res = await bulkM.mutateAsync({ items });
      const r = res.data;
      if (r.fail > 0) {
        setErr(`Snimljeno ${r.ok}, neuspeh ${r.fail}. Proverite konzolu.`);
        // eslint-disable-next-line no-console
        console.error('[orgBulk] failures:', r.results.filter((x) => !x.ok));
        return;
      }
      toast(`✅ Upisano ${r.ok} pozicija`);
      onClose();
    } catch (e) {
      setErr(errToast(e).replace(/^⚠ /, ''));
    }
  }

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        size="2xl"
        title="Bulk import opisa pozicija"
        footer={
          <>
            <span className="mr-auto text-xs text-ink-secondary">
              Za upis: {withContent.length} · Bez sadržaja: {noContent.length} · Nespareno: {unmatched.length}
            </span>
            <Button variant="secondary" onClick={onClose}>
              Zatvori
            </Button>
            <Button onClick={() => setConfirmOpen(true)} loading={bulkM.isPending} disabled={withContent.length === 0}>
              Primeni
            </Button>
          </>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          {/* LEVO: unos */}
          <div className="flex min-h-0 flex-col">
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-semibold text-ink">Tekst za uvoz</label>
              <button
                type="button"
                onClick={() => {
                  if (text.trim() && !window.confirm('Zameniti trenutni sadržaj primerom?')) return;
                  setText(BULK_TEMPLATE);
                }}
                className="rounded border border-line px-2 py-0.5 text-xs text-ink-secondary hover:bg-surface-2 hover:text-ink"
              >
                Ubaci primer
              </button>
            </div>
            <textarea
              value={text}
              onChange={(e) => onText(e.target.value)}
              placeholder="Nalepi ovde — pogledaj primer formata..."
              className="min-h-[340px] w-full resize-y rounded-control border border-line bg-surface px-3 py-2 font-mono text-xs text-ink focus-visible:border-accent focus-visible:outline-none"
            />
            <details className="mt-2 text-xs text-ink-secondary">
              <summary className="cursor-pointer text-accent">Pravila formata</summary>
              <div className="mt-1.5 space-y-1 leading-relaxed">
                <p>
                  <strong className="text-ink">Naziv pozicije:</strong> red koji počinje sa <code className="rounded bg-surface-2 px-1">==</code> (npr.{' '}
                  <code className="rounded bg-surface-2 px-1">== Šef proizvodnje ==</code>). Poklapa se sa nazivom u bazi (tolerantno na razmake/velika slova/dijakritike).
                </p>
                <p>
                  <strong className="text-ink">Sekcije:</strong> <code className="rounded bg-surface-2 px-1">[Opis]</code>/<code className="rounded bg-surface-2 px-1">[Sažetak]</code>,{' '}
                  <code className="rounded bg-surface-2 px-1">[Očekivanja]</code>, <code className="rounded bg-surface-2 px-1">[Odgovornosti]</code>,{' '}
                  <code className="rounded bg-surface-2 px-1">[Obaveze]</code>/<code className="rounded bg-surface-2 px-1">[Dužnosti]</code>.
                </p>
                <p>
                  <strong className="text-ink">Sadržaj:</strong> obična linija = pasus; <code className="rounded bg-surface-2 px-1">- ...</code> = bullet;{' '}
                  <code className="rounded bg-surface-2 px-1">**bold**</code>, <code className="rounded bg-surface-2 px-1">*italic*</code>.
                </p>
              </div>
            </details>
          </div>

          {/* DESNO: live preview */}
          <div className="flex min-h-0 flex-col">
            <label className="mb-1 text-sm font-semibold text-ink">Pregled (live)</label>
            <div className="min-h-[340px] flex-1 space-y-1.5 overflow-y-auto rounded-control border border-line bg-surface px-2 py-2 text-sm">
              {!debounced.trim() ? (
                <p className="text-ink-disabled">Nalepi tekst sa leve strane — ovde će se pojaviti mapiranje pozicija.</p>
              ) : (
                <>
                  {withContent.length > 0 && (
                    <>
                      <p className="text-xs font-semibold text-status-success">Za upis ({withContent.length}):</p>
                      {withContent.map((m) => {
                        const secs = [
                          m.parsed.summaryMd && 'Opis',
                          m.parsed.expectationsMd && 'Očekivanja',
                          m.parsed.responsibilitiesMd && 'Odgovornosti',
                          m.parsed.dutiesMd && 'Obaveze',
                        ].filter(Boolean);
                        return (
                          <div key={m.db.id} className="rounded border-l-2 border-status-success bg-status-success-bg/40 px-2 py-1">
                            <div className="flex items-center gap-1 font-medium text-ink">
                              <Check className="h-3 w-3 text-status-success" aria-hidden /> {m.db.name}
                            </div>
                            <div className="text-2xs text-ink-secondary">{secs.join(' + ') || '(nema sekcija)'}</div>
                            {(m.parsed.warnings ?? []).map((w, i) => (
                              <div key={i} className="flex items-center gap-1 text-2xs text-status-warn">
                                <AlertTriangle className="h-3 w-3" aria-hidden /> {w}
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </>
                  )}
                  {noContent.length > 0 && (
                    <>
                      <p className="pt-1 text-xs font-semibold text-ink-secondary">Bez sadržaja ({noContent.length}):</p>
                      {noContent.map((m) => (
                        <div key={m.db.id} className="rounded border-l-2 border-line bg-surface-2 px-2 py-1">
                          <div className="flex items-center gap-1 font-medium text-ink-secondary">
                            <Ban className="h-3 w-3" aria-hidden /> {m.db.name}
                          </div>
                          <div className="text-2xs text-ink-secondary">Pronađena u bazi ali bez sekcija — biće preskočena.</div>
                        </div>
                      ))}
                    </>
                  )}
                  {unmatched.length > 0 && (
                    <>
                      <p className="pt-1 text-xs font-semibold text-status-danger">Nesparene ({unmatched.length}):</p>
                      {unmatched.map((p, i) => (
                        <div key={i} className="rounded border-l-2 border-status-danger bg-status-danger-bg/40 px-2 py-1">
                          <div className="flex items-center gap-1 font-medium text-status-danger">
                            <XIcon className="h-3 w-3" aria-hidden /> „{p.name}"
                          </div>
                          <div className="text-2xs text-ink-secondary">Nema u bazi pod tim nazivom — preimenuj u tekstu ili dodaj poziciju u strukturu.</div>
                        </div>
                      ))}
                    </>
                  )}
                  {withContent.length === 0 && noContent.length === 0 && unmatched.length === 0 && (
                    <p className="text-ink-disabled">
                      Nije pronađena nijedna pozicija. Proveri da svaka počinje sa <code className="rounded bg-surface-2 px-1">== Naziv ==</code>.
                    </p>
                  )}
                </>
              )}
            </div>
            {err && <p className="mt-2 rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
          </div>
        </div>
      </Dialog>

      {confirmOpen && (
        <ConfirmModal
          state={{
            danger: true,
            message: `Upisati ${withContent.length} opisa pozicija u bazu?\n\n⚠ POTPUNA ZAMENA: sve 4 sekcije (Opis/Očekivanja/Odgovornosti/Obaveze) se prepisuju. Sekcije koje NISU u nalepljenom tekstu biće OBRISANE na tim pozicijama.`,
            onConfirm: apply,
          }}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- debounce helper
function useDebounce(value: string, delayMs: number, apply: (v: string) => void) {
  useEffect(() => {
    const t = setTimeout(() => apply(value), delayMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delayMs]);
}

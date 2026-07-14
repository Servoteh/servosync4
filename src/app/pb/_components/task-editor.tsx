'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, Trash2, X } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { ApiError } from '@/api/client';
import { formatDate } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  PB_STATUSI,
  PB_VRSTE,
  PB_PRIORITETI,
  newClientEventId,
  useProjects,
  useEngineers,
  useTask,
  useTaskComments,
  useTaskDeps,
  useTaskFiles,
  useTasks,
  useCreateTask,
  useUpdateTask,
  useUpdateProgress,
  useCreateComment,
  useDeleteComment,
  useAddDep,
  useDeleteDep,
  useUploadTaskFile,
  useDeleteTaskFile,
  signTaskFile,
  type TaskFields,
} from '@/api/projektni-biro';
import { TaskStatusBadge, statusTone } from './shared';

type FormState = {
  naziv: string;
  opis: string;
  problem: string;
  projectId: string;
  employeeId: string;
  vrsta: string;
  prioritet: string;
  status: string;
  datumPocetkaPlan: string;
  datumZavrsetkaPlan: string;
  datumPocetkaReal: string;
  datumZavrsetkaReal: string;
  procenatZavrsenosti: number;
  normaSatiDan: number;
};

const EMPTY: FormState = {
  naziv: '',
  opis: '',
  problem: '',
  projectId: '',
  employeeId: '',
  vrsta: '',
  prioritet: 'Srednji',
  status: 'Nije počelo',
  datumPocetkaPlan: '',
  datumZavrsetkaPlan: '',
  datumPocetkaReal: '',
  datumZavrsetkaReal: '',
  procenatZavrsenosti: 0,
  normaSatiDan: 4,
};

/** dd.MM.yyyy value iz ISO date (input type=date očekuje yyyy-MM-dd). */
function toDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  return String(iso).slice(0, 10);
}

export function TaskEditor({
  taskId,
  initialStatus,
  onClose,
}: {
  taskId: string | null; // null = novi zadatak
  initialStatus?: string;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const canEdit = can(PERMISSIONS.PB_EDIT);
  const canProgress = can(PERMISSIONS.PB_PROGRESS);
  const restricted = !canEdit && canProgress && !!taskId; // inzenjer: samo status/procenat

  const projectsQ = useProjects();
  const engineersQ = useEngineers();
  const taskQ = useTask(taskId);
  const [form, setForm] = useState<FormState>({ ...EMPTY, status: initialStatus || EMPTY.status });
  const [err, setErr] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);

  const createM = useCreateTask();
  const updateM = useUpdateTask();
  const progressM = useUpdateProgress();

  useEffect(() => {
    const t = taskQ.data?.data;
    if (t && loadedFor.current !== t.id) {
      loadedFor.current = t.id;
      setForm({
        naziv: t.naziv ?? '',
        opis: t.opis ?? '',
        problem: t.problem ?? '',
        projectId: t.project_id ?? '',
        employeeId: t.employee_id ?? '',
        vrsta: t.vrsta ?? '',
        prioritet: t.prioritet ?? 'Srednji',
        status: t.status ?? 'Nije počelo',
        datumPocetkaPlan: toDateInput(t.datum_pocetka_plan),
        datumZavrsetkaPlan: toDateInput(t.datum_zavrsetka_plan),
        datumPocetkaReal: toDateInput(t.datum_pocetka_real),
        datumZavrsetkaReal: toDateInput(t.datum_zavrsetka_real),
        procenatZavrsenosti: t.procenat_zavrsenosti ?? 0,
        normaSatiDan: t.norma_sati_dan ?? 4,
      });
    }
  }, [taskQ.data]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const pending = createM.isPending || updateM.isPending || progressM.isPending;

  async function save() {
    setErr(null);
    try {
      if (restricted && taskId) {
        await progressM.mutateAsync({ id: taskId, status: form.status, procenat: form.procenatZavrsenosti });
        onClose();
        return;
      }
      if (!form.naziv.trim()) {
        setErr('Naziv je obavezan.');
        return;
      }
      const fields: TaskFields = {
        naziv: form.naziv.trim(),
        opis: form.opis,
        problem: form.problem,
        projectId: form.projectId || undefined,
        employeeId: form.employeeId || undefined,
        vrsta: form.vrsta || undefined,
        prioritet: form.prioritet || undefined,
        status: form.status || undefined,
        datumPocetkaPlan: form.datumPocetkaPlan || undefined,
        datumZavrsetkaPlan: form.datumZavrsetkaPlan || undefined,
        datumPocetkaReal: form.datumPocetkaReal || undefined,
        datumZavrsetkaReal: form.datumZavrsetkaReal || undefined,
        procenatZavrsenosti: form.procenatZavrsenosti,
        normaSatiDan: form.normaSatiDan,
      };
      if (taskId) {
        await updateM.mutateAsync({
          id: taskId,
          patch: { ...fields, expectedUpdatedAt: taskQ.data?.data.updated_at },
        });
      } else {
        await createM.mutateAsync({ clientEventId: newClientEventId(), naziv: fields.naziv!, ...fields });
      }
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 409) setErr('Zadatak je u međuvremenu izmenjen. Osveži pregled i pokušaj ponovo.');
        else if (e.status === 403) setErr('Nemate pravo za ovu izmenu.');
        else setErr(e.message);
      } else setErr('Greška pri čuvanju.');
    }
  }

  const projects = projectsQ.data?.data ?? [];
  const engineers = engineersQ.data?.data ?? [];
  const dis = restricted; // u restriktovanom modu polja (osim status/%) su zaključana

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        Otkaži
      </Button>
      <Button onClick={save} loading={pending} disabled={!canEdit && !restricted}>
        {taskId ? 'Snimi' : 'Kreiraj'}
      </Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title={taskId ? 'Izmena zadatka' : 'Novi zadatak'} footer={footer}>
      <div className="space-y-3">
        {restricted && (
          <p className="rounded-control bg-accent-subtle px-3 py-2 text-xs text-ink-secondary">
            Ograničen unos (inženjer): možete menjati samo <b>status</b> i <b>završenost %</b>.
          </p>
        )}
        {err && (
          <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger" role="alert">
            {err}
          </p>
        )}

        <FormField label="Naziv" required>
          <Input value={form.naziv} onChange={(e) => set('naziv', e.target.value)} disabled={dis} maxLength={300} />
        </FormField>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Projekat">
            <select
              value={form.projectId}
              onChange={(e) => set('projectId', e.target.value)}
              disabled={dis}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink disabled:opacity-60"
            >
              <option value="">— nije izabran —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {[p.project_code, p.project_name].filter(Boolean).join(' — ')}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Inženjer">
            <select
              value={form.employeeId}
              onChange={(e) => set('employeeId', e.target.value)}
              disabled={dis}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink disabled:opacity-60"
            >
              <option value="">— nije dodeljen —</option>
              {engineers.map((en) => (
                <option key={en.id} value={en.id}>
                  {en.full_name}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Vrsta">
            <select
              value={form.vrsta}
              onChange={(e) => set('vrsta', e.target.value)}
              disabled={dis}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink disabled:opacity-60"
            >
              <option value="">—</option>
              {PB_VRSTE.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Prioritet">
            <select
              value={form.prioritet}
              onChange={(e) => set('prioritet', e.target.value)}
              disabled={dis}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink disabled:opacity-60"
            >
              {PB_PRIORITETI.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Status">
            <select
              value={form.status}
              onChange={(e) => set('status', e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink"
            >
              {PB_STATUSI.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <FormField label="Plan početak">
            <Input type="date" value={form.datumPocetkaPlan} onChange={(e) => set('datumPocetkaPlan', e.target.value)} disabled={dis} />
          </FormField>
          <FormField label="Plan rok">
            <Input type="date" value={form.datumZavrsetkaPlan} onChange={(e) => set('datumZavrsetkaPlan', e.target.value)} disabled={dis} />
          </FormField>
          <FormField label="Ostvaren poč.">
            <Input type="date" value={form.datumPocetkaReal} onChange={(e) => set('datumPocetkaReal', e.target.value)} disabled={dis} />
          </FormField>
          <FormField label="Ostvaren zavr.">
            <Input type="date" value={form.datumZavrsetkaReal} onChange={(e) => set('datumZavrsetkaReal', e.target.value)} disabled={dis} />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Norma (h/dan)" hint="1–7">
            <Input
              type="number"
              min={1}
              max={7}
              value={form.normaSatiDan}
              onChange={(e) => set('normaSatiDan', Number(e.target.value))}
              disabled={dis}
            />
          </FormField>
          <FormField label="Završenost %" hint="0–100">
            <Input
              type="number"
              min={0}
              max={100}
              value={form.procenatZavrsenosti}
              onChange={(e) => set('procenatZavrsenosti', Number(e.target.value))}
            />
          </FormField>
        </div>

        <FormField label="Opis zadatka">
          <Textarea value={form.opis} onChange={(e) => set('opis', e.target.value)} disabled={dis} rows={3} />
        </FormField>
        <FormField label="Problem / prepreka" hint={'Ako postoji problem, razmotri status „Blokirano".'}>
          <Textarea value={form.problem} onChange={(e) => set('problem', e.target.value)} disabled={dis} rows={2} />
        </FormField>

        {taskId && (
          <div className="space-y-4 border-t border-line pt-4">
            <CommentsSection taskId={taskId} canEdit={canEdit || canProgress} />
            <DepsSection taskId={taskId} canEdit={canEdit} />
            <FilesSection taskId={taskId} canEdit={canEdit} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Komentari

function CommentsSection({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const q = useTaskComments(taskId);
  const createM = useCreateComment();
  const delM = useDeleteComment();
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const rows = q.data?.data ?? [];

  async function add() {
    if (!body.trim()) return;
    setErr(null);
    try {
      await createM.mutateAsync({ taskId, clientEventId: newClientEventId(), body: body.trim() });
      setBody('');
    } catch {
      setErr('Slanje nije uspelo.');
    }
  }
  async function remove(cid: string) {
    setErr(null);
    try {
      await delM.mutateAsync({ cid });
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'Brisanje nije uspelo (istekao je prozor od 60 min).' : 'Brisanje nije uspelo.');
    }
  }

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-ink">💬 Komentari</h3>
      {err && <p className="mb-1 text-xs text-status-danger">{err}</p>}
      <div className="space-y-2">
        {rows.map((c) => (
          <div key={c.id} className="rounded-control border border-line-soft bg-surface-2 px-3 py-2">
            <div className="flex items-center justify-between text-xs text-ink-secondary">
              <span>
                {c.createdBy ?? 'korisnik'}
                {c.editedAt && ' · izmenjeno'}
              </span>
              <div className="flex items-center gap-2">
                <span className="tnums">{formatDate(c.createdAt)}</span>
                {canEdit && (
                  <button onClick={() => remove(c.id)} className="text-ink-disabled hover:text-status-danger" aria-label="Obriši komentar">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{c.body}</p>
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs text-ink-disabled">Još nema komentara.</p>}
      </div>
      <div className="mt-2 flex gap-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder="Dodaj komentar… (@email za mention)"
          className="min-h-0"
        />
        <Button variant="secondary" onClick={add} loading={createM.isPending}>
          Pošalji
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Zavisnosti

function DepsSection({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const q = useTaskDeps(taskId);
  const addM = useAddDep();
  const delM = useDeleteDep();
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const searchQ = useTasks(picking ? { q: search || undefined, pageSize: 50 } : {});
  const deps = q.data?.data ?? [];
  const depIds = useMemo(() => new Set(deps.map((d) => d.dependsOnTaskId)), [deps]);

  async function add(dependsOnTaskId: string) {
    setErr(null);
    try {
      await addM.mutateAsync({ taskId, dependsOnTaskId });
      setPicking(false);
      setSearch('');
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 409 ? e.message : 'Dodavanje zavisnosti nije uspelo.');
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">🔗 Zavisi od</h3>
        {canEdit && (
          <Button variant="ghost" onClick={() => setPicking((p) => !p)} className="h-7 px-2 text-xs">
            ＋ Dodaj zavisnost
          </Button>
        )}
      </div>
      {err && <p className="mb-1 text-xs text-status-danger">{err}</p>}
      <div className="space-y-1">
        {deps.map((d) => (
          <DepRow key={d.id} depId={d.id} dependsOn={d.dependsOnTaskId} canEdit={canEdit} onRemove={(id) => delM.mutate({ depId: id })} />
        ))}
        {deps.length === 0 && <p className="text-xs text-ink-disabled">Nema zavisnosti.</p>}
      </div>
      {picking && (
        <div className="mt-2 rounded-control border border-line p-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Pretraži zadatke…" className="mb-2" />
          <div className="max-h-40 space-y-1 overflow-auto">
            {(searchQ.data?.data ?? [])
              .filter((t) => t.id !== taskId && !depIds.has(t.id))
              .slice(0, 50)
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => add(t.id)}
                  className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-surface-2"
                >
                  <span className="truncate">{t.naziv}</span>
                  <StatusBadge tone={statusTone(t.status)} label={t.status} />
                </button>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

function DepRow({
  depId,
  dependsOn,
  canEdit,
  onRemove,
}: {
  depId: string;
  dependsOn: string;
  canEdit: boolean;
  onRemove: (id: string) => void;
}) {
  const t = useTask(dependsOn);
  const row = t.data?.data;
  return (
    <div className="flex items-center justify-between rounded-control border border-line-soft bg-surface-2 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm text-ink">{row?.naziv ?? '…'}</span>
        {row && <TaskStatusBadge status={row.status} />}
      </div>
      {canEdit && (
        <button onClick={() => onRemove(depId)} className="text-ink-disabled hover:text-status-danger" aria-label="Ukloni zavisnost">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Prilozi

function FilesSection({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const q = useTaskFiles(taskId);
  const upM = useUploadTaskFile();
  const delM = useDeleteTaskFile();
  const inputRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const rows = q.data?.data ?? [];

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    setErr(null);
    try {
      for (const f of Array.from(files)) {
        await upM.mutateAsync({ taskId, file: f, clientEventId: newClientEventId() });
      }
    } catch {
      setErr('Otpremanje nije uspelo.');
    }
    if (inputRef.current) inputRef.current.value = '';
  }
  async function open(fileId: string) {
    try {
      const res = await signTaskFile(fileId);
      window.open(res.data.url, '_blank', 'noopener');
    } catch {
      setErr('Otvaranje priloga nije uspelo.');
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">📎 Prilozi</h3>
        {canEdit && (
          <>
            <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => onPick(e.target.files)} />
            <Button variant="ghost" onClick={() => inputRef.current?.click()} loading={upM.isPending} className="h-7 px-2 text-xs">
              ＋ Dodaj fajl
            </Button>
          </>
        )}
      </div>
      {err && <p className="mb-1 text-xs text-status-danger">{err}</p>}
      <div className="space-y-1">
        {rows.map((f) => (
          <div key={f.id} className="flex items-center justify-between rounded-control border border-line-soft bg-surface-2 px-3 py-1.5">
            <button onClick={() => open(f.id)} className="flex min-w-0 items-center gap-2 text-left">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-disabled" aria-hidden />
              <span className="truncate text-sm text-ink hover:underline">{f.fileName}</span>
              <span className="shrink-0 text-xs text-ink-disabled">{formatDate(f.uploadedAt)}</span>
            </button>
            {canEdit && (
              <button onClick={() => delM.mutate({ fileId: f.id })} className="text-ink-disabled hover:text-status-danger" aria-label="Obriši prilog">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
        {rows.length === 0 && <p className="text-xs text-ink-disabled">Nema priloga.</p>}
      </div>
    </section>
  );
}

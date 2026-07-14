'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  useOnboarding,
  useOnboardingTemplates,
  useOffboardingReversi,
  useOnboardingStart,
  useOnboardingTask,
  useOnboardingRunStatus,
  useCreateOnbTemplate,
  useDeleteOnbTemplate,
  useCreateOnbItem,
  useDeleteOnbItem,
  newClientEventId,
  type OnboardingRun,
  type OnboardingTask,
  type OnboardingTemplate,
  type OnboardingTemplateItem,
} from '@/api/kadrovska';
import { SummaryChips, sv } from './common';
import { ProgressBar, EmployeeSelect, Select, DateField, WideModal, useNameMap, todayIso } from './razvoj/shared';

const KIND_LABEL: Record<string, string> = { onboarding: 'Uvođenje', offboarding: 'Izlazak' };

export function OnboardingTab() {
  const runsQ = useOnboarding({}, true);
  const tmplQ = useOnboardingTemplates(true);
  const { nm } = useNameMap();

  const runs = runsQ.data?.data?.runs ?? [];
  const tasks = runsQ.data?.data?.tasks ?? [];
  const templates = tmplQ.data?.data?.templates ?? [];
  const items = tmplQ.data?.data?.items ?? [];

  const tasksByRun = useMemo(() => {
    const m = new Map<string, OnboardingTask[]>();
    for (const t of tasks) (m.get(t.runId) ?? m.set(t.runId, []).get(t.runId)!).push(t);
    return m;
  }, [tasks]);
  const itemsByTmpl = useMemo(() => {
    const m = new Map<string, OnboardingTemplateItem[]>();
    for (const it of items) (m.get(it.templateId) ?? m.set(it.templateId, []).get(it.templateId)!).push(it);
    for (const arr of m.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);
    return m;
  }, [items]);

  const active = runs.filter((r) => r.status === 'active');
  const [expRun, setExpRun] = useState<string | null>(null);
  const [expTmpl, setExpTmpl] = useState<string | null>(null);
  const [newTmpl, setNewTmpl] = useState(false);
  const [startTmpl, setStartTmpl] = useState<OnboardingTemplate | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <SummaryChips items={[{ label: 'Aktivnih tokova', value: active.length }, { label: 'Šablona', value: templates.length }]} />
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => runsQ.refetch()} title="Osveži">↻</Button>
        <Button onClick={() => setNewTmpl(true)}>+ Novi šablon</Button>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Aktivni tokovi</h3>
        {runsQ.isLoading ? (
          <p className="text-sm text-ink-disabled">Učitavanje…</p>
        ) : active.length === 0 ? (
          <EmptyState title="Nema aktivnih tokova" hint="Pokreni iz šablona ispod." />
        ) : (
          <div className="space-y-2">
            {active
              .slice()
              .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
              .map((r) => (
                <RunCard key={r.id} run={r} tasks={tasksByRun.get(r.id) ?? []} name={nm(r.employeeId)} open={expRun === r.id} onToggle={() => setExpRun((e) => (e === r.id ? null : r.id))} />
              ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Šabloni</h3>
        {templates.length === 0 ? (
          <EmptyState title="Nema šablona" hint={'„+ Novi šablon" da napraviš prvi (npr. Standardni onboarding).'} />
        ) : (
          <div className="space-y-2">
            {templates.map((t) => (
              <TemplateCard key={t.id} tmpl={t} items={itemsByTmpl.get(t.id) ?? []} open={expTmpl === t.id} onToggle={() => setExpTmpl((e) => (e === t.id ? null : t.id))} onStart={() => setStartTmpl(t)} />
            ))}
          </div>
        )}
      </section>

      {newTmpl && <NewTemplateModal onClose={() => setNewTmpl(false)} />}
      {startTmpl && <StartRunModal tmpl={startTmpl} onClose={() => setStartTmpl(null)} onStarted={(runId) => { setStartTmpl(null); if (runId) setExpRun(runId); }} />}
    </div>
  );
}

function progress(tasks: OnboardingTask[]) {
  const done = tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  return { done, total: tasks.length, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0 };
}

function RunCard({ run, tasks, name, open, onToggle }: { run: OnboardingRun; tasks: OnboardingTask[]; name: string; open: boolean; onToggle: () => void }) {
  const taskMut = useOnboardingTask();
  const runMut = useOnboardingRunStatus();
  const p = progress(tasks);
  const isOff = run.kind === 'offboarding';

  function toggle(t: OnboardingTask, target: 'done' | 'skipped') {
    if (t.status === target) taskMut.mutate({ id: t.id, status: 'open' });
    else if (target === 'done') taskMut.mutate({ id: t.id, done: true });
    else taskMut.mutate({ id: t.id, status: 'skipped' });
  }
  function finish() {
    runMut.mutate({ id: run.id, status: 'done', clientEventId: newClientEventId() }, { onSuccess: () => toast('✅ Tok završen'), onError: () => toast('⚠ Nije uspelo') });
  }
  function cancel() {
    if (!confirm('Otkazati ovaj tok uvođenja/izlaska?')) return;
    runMut.mutate({ id: run.id, status: 'canceled', clientEventId: newClientEventId() }, { onSuccess: () => toast('Tok otkazan'), onError: () => toast('⚠ Nije uspelo') });
  }

  return (
    <div className="rounded-panel border border-line bg-surface">
      <button className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2" onClick={onToggle}>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-subtle text-2xs font-semibold text-accent">{name.slice(0, 2).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 font-medium text-ink">
            {name}
            <span className={`rounded-full px-1.5 py-0.5 text-2xs font-semibold ${isOff ? 'bg-status-warn-bg text-status-warn' : 'bg-status-info-bg text-status-info'}`}>{KIND_LABEL[run.kind] || run.kind}</span>
          </span>
          <span className="text-2xs text-ink-secondary">Početak: {run.startDate ? formatDate(run.startDate) : '—'} · {p.done}/{p.total} završeno</span>
        </span>
        <span className="w-24 shrink-0"><ProgressBar pct={p.pct} /></span>
        <span className="text-ink-secondary">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2">
          <div className="space-y-1.5">
            {tasks.map((t) => {
              const done = t.status === 'done';
              const skipped = t.status === 'skipped';
              const overdue = !done && !skipped && t.dueDate && t.dueDate < todayIso();
              return (
                <div key={t.id} className={`flex items-start gap-2 rounded-control px-2 py-1.5 ${done ? 'opacity-60' : ''}`}>
                  <button className="mt-0.5 text-lg leading-none" onClick={() => toggle(t, 'done')} title={done ? 'Vrati u otvoreno' : 'Označi kao urađeno'}>{done ? '☑' : '☐'}</button>
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm text-ink ${skipped ? 'line-through' : ''}`}>
                      {t.title}
                      {t.assigneeHint && <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">{t.assigneeHint}</span>}
                    </div>
                    {t.description && <div className="text-2xs text-ink-secondary">{t.description}</div>}
                    <div className="text-2xs text-ink-secondary">
                      {t.dueDate ? <>Rok: <span className={overdue ? 'text-status-danger' : ''}>{formatDate(t.dueDate)}</span></> : 'bez roka'}
                      {done && t.doneBy ? ` · ✓ ${t.doneBy}` : ''}
                    </div>
                  </div>
                  {!done && <button className="text-2xs text-ink-secondary hover:underline" onClick={() => toggle(t, 'skipped')}>preskoči</button>}
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex gap-2">
            {p.total > 0 && p.done === p.total && <Button className="h-7 px-2 text-xs" onClick={finish}>✓ Završi tok</Button>}
            <Button variant="ghost" className="h-7 px-2 text-xs" onClick={cancel}>Otkaži tok</Button>
          </div>
          {isOff && <OffboardingReversi employeeId={run.employeeId} />}
        </div>
      )}
    </div>
  );
}

function OffboardingReversi({ employeeId }: { employeeId: string }) {
  const q = useOffboardingReversi(employeeId, true);
  const items = q.data?.data ?? [];
  return (
    <div className="mt-3 rounded-panel border border-line bg-surface-2/40 p-2.5">
      <div className="flex items-center justify-between text-sm font-medium text-ink">
        <span>🔧 Zaduženja za vraćanje ({q.isLoading ? '…' : items.length})</span>
        <a href="/reversi" className="text-xs text-accent hover:underline">otvori REVERSI →</a>
      </div>
      {q.isLoading ? (
        <p className="mt-1 text-2xs text-ink-secondary">Učitavanje zaduženja…</p>
      ) : items.length === 0 ? (
        <p className="mt-1 text-2xs text-ink-secondary">Sva zaduženja vraćena ✓</p>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          {items.map((it, i) => {
            const name = sv(it, 'oznaka') ? `${sv(it, 'oznaka')}${sv(it, 'naziv') ? ' — ' + sv(it, 'naziv') : ''}` : sv(it, 'naziv') || '—';
            const meta = [sv(it, 'doc_number'), sv(it, 'issued_at') ? `izdato ${formatDate(sv(it, 'issued_at'))}` : '', sv(it, 'pribor') ? `pribor: ${sv(it, 'pribor')}` : ''].filter(Boolean).join(' · ');
            return (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-2xs font-semibold text-ink">{sv(it, 'qty')} {sv(it, 'unit') || 'kom'}</span>
                <div>
                  <div className="text-ink">{name}</div>
                  {meta && <div className="text-2xs text-ink-secondary">{meta}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ tmpl, items, open, onToggle, onStart }: { tmpl: OnboardingTemplate; items: OnboardingTemplateItem[]; open: boolean; onToggle: () => void; onStart: () => void }) {
  const delTmpl = useDeleteOnbTemplate();
  const createItem = useCreateOnbItem();
  const delItem = useDeleteOnbItem();
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [offset, setOffset] = useState('0');
  const isOff = tmpl.kind === 'offboarding';

  function addItem() {
    if (!title.trim()) return toast('⚠ Unesi naziv zadatka');
    createItem.mutate(
      { templateId: tmpl.id, title: title.trim(), assigneeHint: assignee.trim() || undefined, offsetDays: Number(offset) || 0, sortOrder: items.length, clientEventId: newClientEventId() },
      { onSuccess: () => { setTitle(''); setAssignee(''); setOffset('0'); }, onError: () => toast('⚠ Dodavanje nije uspelo') },
    );
  }

  return (
    <div className="rounded-panel border border-line bg-surface">
      <div className="flex items-center justify-between px-3 py-2.5">
        <button className="flex items-center gap-2 text-left" onClick={onToggle}>
          <span className="text-ink-secondary">{open ? '▾' : '▸'}</span>
          <span className="font-medium text-ink">{tmpl.name}</span>
          <span className={`rounded-full px-1.5 py-0.5 text-2xs font-semibold ${isOff ? 'bg-status-warn-bg text-status-warn' : 'bg-status-info-bg text-status-info'}`}>{KIND_LABEL[tmpl.kind] || tmpl.kind}</span>
          <span className="text-2xs text-ink-secondary">{items.length} stavki</span>
        </button>
        <div className="flex gap-2">
          <Button className="h-7 px-2 text-xs" onClick={onStart}>▶ Pokreni</Button>
          <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => { if (confirm('Obrisati šablon i sve njegove stavke? (Pokrenuti tokovi ostaju.)')) delTmpl.mutate({ id: tmpl.id }, { onSuccess: () => toast('🗑 Šablon obrisan'), onError: () => toast('⚠ Brisanje nije uspelo') }); }}>🗑</Button>
        </div>
      </div>
      {open && (
        <div className="border-t border-line px-3 py-2">
          <div className="space-y-1.5">
            {items.length === 0 ? (
              <p className="text-2xs text-ink-secondary">Nema stavki — dodaj ispod.</p>
            ) : (
              items.map((it) => (
                <div key={it.id} className="flex items-center justify-between rounded-control px-2 py-1 text-sm">
                  <span>
                    {it.title}
                    {it.assigneeHint && <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">{it.assigneeHint}</span>}
                    <span className="ml-1.5 text-2xs text-ink-secondary">rok +{it.offsetDays ?? 0}d</span>
                  </span>
                  <button className="text-2xs text-status-danger hover:underline" onClick={() => delItem.mutate({ id: it.id }, { onSuccess: () => {}, onError: () => toast('⚠ Brisanje nije uspelo') })}>✕</button>
                </div>
              ))
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Input className="flex-[2] min-w-40" value={title} placeholder="Naziv zadatka (npr. Potpis ugovora)" onChange={(e) => setTitle(e.target.value)} />
            <Input className="flex-1 min-w-28" value={assignee} placeholder="Zaduženi (HR/Šef/IT)" onChange={(e) => setAssignee(e.target.value)} />
            <input type="number" value={offset} title="Rok = početak + N dana" onChange={(e) => setOffset(e.target.value)} className="h-9 w-20 rounded-control border border-line bg-surface px-2 text-base text-ink" />
            <Button variant="secondary" className="h-9" loading={createItem.isPending} onClick={addItem}>+ Dodaj</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewTemplateModal({ onClose }: { onClose: () => void }) {
  const create = useCreateOnbTemplate();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('onboarding');
  function submit() {
    if (!name.trim()) return toast('⚠ Unesi naziv');
    create.mutate({ name: name.trim(), kind, clientEventId: newClientEventId() }, { onSuccess: () => { toast('✅ Šablon napravljen'); onClose(); }, onError: () => toast('⚠ Čuvanje nije uspelo') });
  }
  return (
    <WideModal open onClose={onClose} maxWidth="520px" title="Novi šablon" footer={<><Button variant="secondary" onClick={onClose}>Otkaži</Button><Button loading={create.isPending} onClick={submit}>Sačuvaj</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><FormField label="Naziv" required><Input value={name} placeholder="npr. Standardni onboarding" onChange={(e) => setName(e.target.value)} /></FormField></div>
        <FormField label="Tip">
          <Select value={kind} onChange={setKind}>
            <option value="onboarding">Uvođenje</option>
            <option value="offboarding">Izlazak</option>
          </Select>
        </FormField>
      </div>
    </WideModal>
  );
}

function StartRunModal({ tmpl, onClose, onStarted }: { tmpl: OnboardingTemplate; onClose: () => void; onStarted: (runId?: string) => void }) {
  const start = useOnboardingStart();
  const [empId, setEmpId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [err, setErr] = useState('');
  function submit() {
    setErr('');
    if (!empId) return setErr('Izaberi zaposlenog.');
    start.mutate(
      { employeeId: empId, templateId: tmpl.id, startDate: date || null, clientEventId: newClientEventId() },
      { onSuccess: (res) => { toast('✅ Tok pokrenut'); onStarted(typeof res.data === 'string' ? res.data : undefined); }, onError: () => setErr('Pokretanje nije uspelo (dozvola?).') },
    );
  }
  return (
    <WideModal open onClose={onClose} maxWidth="520px" title={`Pokreni: ${tmpl.name}`} footer={<><Button variant="secondary" onClick={onClose}>Otkaži</Button><Button loading={start.isPending} onClick={submit}>Pokreni</Button></>}>
      {err && <p className="mb-3 rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><FormField label="Zaposleni" required><EmployeeSelect value={empId} onChange={setEmpId} /></FormField></div>
        <FormField label="Datum početka"><DateField value={date} onChange={setDate} /></FormField>
      </div>
    </WideModal>
  );
}

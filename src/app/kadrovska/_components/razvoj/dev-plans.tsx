'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { Markdown } from '@/lib/markdown';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  useDevPlans,
  useExpectations,
  useDevPlanCheckins,
  useReport,
  useCreateDevPlan,
  useUpdateDevPlan,
  useDeleteDevPlan,
  useCreateExpectation,
  useUpdateExpectation,
  useDeleteExpectation,
  useCreateCheckin,
  useDeleteCheckin,
  newClientEventId,
  type DevCheckin,
  type DevPlanInput,
} from '@/api/kadrovska';
import { SummaryChips, sv, svNum } from '../common';
import {
  DEV_CATEGORY_LABEL,
  DEV_PLAN_STATUS_LABEL,
  CATEGORY_ORDER,
  PRIO_LABEL,
  ProgressBar,
  EmployeeSelect,
  Select,
  DateField,
  WideModal,
  DevBlock,
  useNameMap,
  todayIso,
} from './shared';
import { Assessment360Modal } from './assessments';

type Row = Record<string, unknown>;

const STATUS_TONE: Record<string, Tone> = { nacrt: 'neutral', aktivan: 'info', zavrsen: 'success', arhiviran: 'neutral' };

export function DevPlansSection() {
  const { can } = useAuth();
  const isAdmin = can(PERMISSIONS.KADROVSKA_ADMIN);
  const { nm } = useNameMap();

  const [empFilter, setEmpFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('aktivan');
  const plansQ = useDevPlans(statusFilter === 'all' ? {} : { status: statusFilter }, true);
  const del = useDeleteDevPlan();

  const [editPlan, setEditPlan] = useState<{ open: boolean; plan: Row | null }>({ open: false, plan: null });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [a360Emp, setA360Emp] = useState<{ employeeId: string; name: string; period?: string } | null>(null);

  const all = plansQ.data?.data ?? [];
  const plans = empFilter ? all.filter((p) => sv(p, 'employee_id') === empFilter) : all;
  const detailPlan = detailId ? all.find((p) => sv(p, 'id') === detailId) ?? null : null;

  const active = all.filter((p) => sv(p, 'status') === 'aktivan');
  const avgProg = active.length ? Math.round(active.reduce((s, p) => s + svNum(p, 'overall_progress'), 0) / active.length) : 0;

  const cols: Column<Row>[] = [
    { key: 'emp', header: 'Zaposleni', render: (r) => <span className="font-medium">{sv(r, 'employee_name') || nm(sv(r, 'employee_id'))}</span> },
    { key: 'period', header: 'Period', render: (r) => sv(r, 'period_label') || '—' },
    {
      key: 'goal',
      header: 'Karijerni cilj',
      render: (r) => <span className="text-ink-secondary">{sv(r, 'career_goal_md').replace(/\s+/g, ' ').slice(0, 60) || '—'}</span>,
    },
    { key: 'prog', header: 'Napredak', render: (r) => <ProgressBar pct={svNum(r, 'overall_progress')} width="110px" /> },
    { key: 'goals', header: 'Ciljeva', align: 'right', render: (r) => `${svNum(r, 'goals_done')}/${svNum(r, 'goals_total')}` },
    { key: 'last', header: 'Poslednji 1-na-1', render: (r) => (sv(r, 'last_checkin_date') ? formatDate(sv(r, 'last_checkin_date')) : '—') },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusBadge tone={STATUS_TONE[sv(r, 'status')] ?? 'neutral'} label={DEV_PLAN_STATUS_LABEL[sv(r, 'status')] || sv(r, 'status')} />,
    },
    {
      key: 'act',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => setDetailId(sv(r, 'id'))}>
            Detalji
          </Button>
          {isAdmin && (
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => {
                if (confirm(`Obrisati razvojni plan „${sv(r, 'period_label')}"?\nCiljevi ostaju ali se odvezuju od plana.`))
                  del.mutate({ id: sv(r, 'id') }, { onSuccess: () => toast('🗑 Plan obrisan'), onError: () => toast('⚠ Brisanje nije uspelo') });
              }}
            >
              Obriši
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <section className="space-y-3">
      <SummaryChips
        items={[
          { label: 'Aktivni planovi', value: active.length, tone: 'accent' },
          { label: 'Prosečan napredak', value: `${avgProg}%`, tone: avgProg >= 66 ? undefined : 'warn' },
          { label: 'Ukupno planova', value: all.length },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">Planovi razvoja</h3>
        <EmployeeSelectFilter value={empFilter} onChange={setEmpFilter} />
        <Select value={statusFilter} onChange={setStatusFilter} className="h-8 w-auto">
          <option value="aktivan">Aktivni</option>
          <option value="all">Svi</option>
          <option value="nacrt">Nacrt</option>
          <option value="zavrsen">Završeni</option>
          <option value="arhiviran">Arhivirani</option>
        </Select>
        <span className="text-sm text-ink-secondary">{plans.length} {plans.length === 1 ? 'plan' : 'planova'}</span>
        <div className="flex-1" />
        <Button onClick={() => setEditPlan({ open: true, plan: null })}>+ Novi plan razvoja</Button>
      </div>

      <DataTable
        columns={cols}
        rows={plans}
        rowKey={(r) => sv(r, 'id') || Math.random().toString()}
        onRowActivate={(r) => setDetailId(sv(r, 'id'))}
        loading={plansQ.isLoading}
        empty={<EmptyState title="Nema razvojnih planova po trenutnom filteru" />}
      />

      {editPlan.open && <PlanModal plan={editPlan.plan} onClose={() => setEditPlan({ open: false, plan: null })} onSaved={(id) => { setEditPlan({ open: false, plan: null }); if (id) setDetailId(id); }} />}

      {detailPlan && (
        <PlanDetailModal
          plan={detailPlan}
          isAdmin={isAdmin}
          onClose={() => setDetailId(null)}
          onEdit={() => { setEditPlan({ open: true, plan: detailPlan }); setDetailId(null); }}
          onOpen360={() => setA360Emp({ employeeId: sv(detailPlan, 'employee_id'), name: sv(detailPlan, 'employee_name') || nm(sv(detailPlan, 'employee_id')), period: sv(detailPlan, 'period_label') })}
        />
      )}

      {a360Emp && (
        <Assessment360Modal
          employeeId={a360Emp.employeeId}
          employeeName={a360Emp.name}
          period={a360Emp.period}
          onClose={() => setA360Emp(null)}
        />
      )}
    </section>
  );
}

function EmployeeSelectFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { list } = useNameMap();
  return (
    <Select value={value} onChange={onChange} className="h-8 w-auto">
      <option value="">Svi zaposleni</option>
      {list.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name}
        </option>
      ))}
    </Select>
  );
}

/* ── Plan create/edit modal ── */
function PlanModal({ plan, onClose, onSaved }: { plan: Row | null; onClose: () => void; onSaved: (id?: string) => void }) {
  const isNew = !plan;
  const create = useCreateDevPlan();
  const update = useUpdateDevPlan();
  const orgQ = useReport<{ jobPositions: Row[] }>('org', {}, true);
  const positions = orgQ.data?.data?.jobPositions ?? [];

  const [form, setForm] = useState({
    employeeId: plan ? sv(plan, 'employee_id') : '',
    periodLabel: plan ? sv(plan, 'period_label') : '',
    status: plan ? sv(plan, 'status') : 'aktivan',
    periodStart: plan ? sv(plan, 'period_start') : '',
    periodEnd: plan ? sv(plan, 'period_end') : '',
    targetPositionId: plan ? sv(plan, 'target_position_id') : '',
    mentorEmployeeId: plan ? sv(plan, 'mentor_employee_id') : '',
    careerGoalMd: plan ? sv(plan, 'career_goal_md') : '',
    summaryMd: plan ? sv(plan, 'summary_md') : '',
  });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  function submit() {
    setErr('');
    if (!form.employeeId) return setErr('Izaberite zaposlenog.');
    if (!form.periodLabel.trim()) return setErr('Period je obavezan.');
    const base: DevPlanInput = {
      employeeId: form.employeeId,
      periodLabel: form.periodLabel.trim(),
      periodStart: form.periodStart || null,
      periodEnd: form.periodEnd || null,
      targetPositionId: form.targetPositionId ? Number(form.targetPositionId) : null,
      mentorEmployeeId: form.mentorEmployeeId || null,
      careerGoalMd: form.careerGoalMd.trim() || null,
      status: form.status,
    };
    if (isNew) {
      create.mutate(
        { ...base, summaryMd: undefined, clientEventId: newClientEventId() } as never,
        {
          onSuccess: (res) => { toast('✅ Plan kreiran'); onSaved(sv((res as { data?: Row }).data ?? null, 'id') || undefined); },
          onError: () => setErr('Snimanje nije uspelo. Proverite dozvolu.'),
        },
      );
    } else {
      update.mutate(
        { id: sv(plan!, 'id'), patch: { ...base, summaryMd: form.summaryMd.trim() || null } },
        { onSuccess: () => { toast('✅ Plan sačuvan'); onSaved(sv(plan!, 'id')); }, onError: () => setErr('Snimanje nije uspelo. Proverite dozvolu.') },
      );
    }
  }

  return (
    <WideModal
      open
      onClose={onClose}
      title={isNew ? 'Novi plan razvoja' : 'Uredi plan razvoja'}
      maxWidth="820px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={create.isPending || update.isPending} onClick={submit}>{isNew ? 'Kreiraj' : 'Snimi'}</Button>
        </>
      }
    >
      {err && <p className="mb-3 rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormField label="Zaposleni" required>
            <EmployeeSelect value={form.employeeId} onChange={(v) => set('employeeId', v)} disabled={!isNew} />
          </FormField>
        </div>
        <FormField label="Period" required>
          <Input value={form.periodLabel} maxLength={60} placeholder="npr. 2026 H2" onChange={(e) => set('periodLabel', e.target.value)} />
        </FormField>
        <FormField label="Status">
          <Select value={form.status} onChange={(v) => set('status', v)}>
            {Object.entries(DEV_PLAN_STATUS_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </Select>
        </FormField>
        <FormField label="Početak"><DateField value={form.periodStart} onChange={(v) => set('periodStart', v)} /></FormField>
        <FormField label="Kraj"><DateField value={form.periodEnd} onChange={(v) => set('periodEnd', v)} /></FormField>
        <FormField label="Ciljna pozicija (karijerni put)">
          <Select value={form.targetPositionId} onChange={(v) => set('targetPositionId', v)}>
            <option value="">— bez ciljne pozicije —</option>
            {positions.map((jp) => (
              <option key={sv(jp, 'id')} value={sv(jp, 'id')}>{sv(jp, 'name')}</option>
            ))}
          </Select>
        </FormField>
        <FormField label="Mentor">
          <EmployeeSelect value={form.mentorEmployeeId} onChange={(v) => set('mentorEmployeeId', v)} blankLabel="— bez mentora —" />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Karijerni cilj (markdown)">
            <Textarea rows={3} value={form.careerGoalMd} placeholder="Gde želimo da zaposleni stigne u ovom periodu..." onChange={(e) => set('careerGoalMd', e.target.value)} />
          </FormField>
        </div>
        {!isNew && (
          <div className="sm:col-span-2">
            <FormField label="Sažetak plana (markdown)">
              <Textarea rows={3} value={form.summaryMd} placeholder="Kontekst, prioriteti, fokus..." onChange={(e) => set('summaryMd', e.target.value)} />
            </FormField>
          </div>
        )}
      </div>
    </WideModal>
  );
}

/* ── Plan detail modal ── */
function PlanDetailModal({
  plan,
  isAdmin,
  onClose,
  onEdit,
  onOpen360,
}: {
  plan: Row;
  isAdmin: boolean;
  onClose: () => void;
  onEdit: () => void;
  onOpen360: () => void;
}) {
  const planId = sv(plan, 'id');
  const { nm } = useNameMap();
  const goalsQ = useExpectations({ planId }, true);
  const checkinsQ = useDevPlanCheckins(planId, true);
  const goals = goalsQ.data?.data ?? [];
  const checkins = checkinsQ.data?.data ?? [];

  const [goalModal, setGoalModal] = useState<{ open: boolean; goal: Row | null }>({ open: false, goal: null });
  const [checkinModal, setCheckinModal] = useState(false);
  const delGoal = useDeleteExpectation();
  const delCheckin = useDeleteCheckin();

  const empName = sv(plan, 'employee_name') || nm(sv(plan, 'employee_id'));
  const byCat = useMemo(() => {
    const m: Record<string, Row[]> = {};
    for (const g of goals) (m[sv(g, 'category')] ||= []).push(g);
    return m;
  }, [goals]);

  return (
    <>
      <WideModal
        open
        onClose={onClose}
        maxWidth="1000px"
        title={`📚 Plan razvoja — ${empName} · ${sv(plan, 'period_label')}`}
        titleExtra={
          <>
            <Button variant="secondary" className="h-7 px-2 text-xs" onClick={onOpen360}>📊 360° procena</Button>
            <Button variant="secondary" className="h-7 px-2 text-xs" onClick={onEdit}>✎ Uredi</Button>
          </>
        }
        footer={<Button variant="secondary" onClick={onClose}>Zatvori</Button>}
      >
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-secondary">
          {sv(plan, 'target_position_name') && <span>🎯 Cilj: <strong className="text-ink">{sv(plan, 'target_position_name')}</strong></span>}
          {sv(plan, 'mentor_name') && <span>🤝 Mentor: {sv(plan, 'mentor_name')}</span>}
          <StatusBadge tone={STATUS_TONE[sv(plan, 'status')] ?? 'neutral'} label={DEV_PLAN_STATUS_LABEL[sv(plan, 'status')] || sv(plan, 'status')} />
        </div>
        <ProgressBar pct={svNum(plan, 'overall_progress')} />

        {sv(plan, 'career_goal_md') && <DevBlock title="Karijerni cilj"><Markdown source={sv(plan, 'career_goal_md')} /></DevBlock>}
        {sv(plan, 'summary_md') && <DevBlock title="Sažetak"><Markdown source={sv(plan, 'summary_md')} /></DevBlock>}
        {sv(plan, 'self_assessment_md') && <DevBlock title="Samoprocena zaposlenog"><Markdown source={sv(plan, 'self_assessment_md')} /></DevBlock>}

        <DevBlock title="Razvojni ciljevi" action={<Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => setGoalModal({ open: true, goal: null })}>+ Novi cilj</Button>}>
          {goalsQ.isLoading ? (
            <p className="text-sm text-ink-disabled">Učitavanje…</p>
          ) : goals.length === 0 ? (
            <p className="text-sm text-ink-secondary">Još nema definisanih ciljeva.</p>
          ) : (
            CATEGORY_ORDER.filter((c) => byCat[c]).map((cat) => (
              <div key={cat} className="mb-3">
                <span className="inline-block rounded-full bg-surface-2 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{DEV_CATEGORY_LABEL[cat]}</span>
                <div className="mt-1.5 space-y-2">
                  {byCat[cat].map((g) => (
                    <GoalRow key={sv(g, 'id')} goal={g} isAdmin={isAdmin} onEdit={() => setGoalModal({ open: true, goal: g })} onDelete={() => {
                      if (confirm(`Obrisati cilj „${sv(g, 'title')}"?`)) delGoal.mutate({ id: sv(g, 'id') }, { onSuccess: () => toast('🗑 Cilj obrisan'), onError: () => toast('⚠ Brisanje nije uspelo') });
                    }} />
                  ))}
                </div>
              </div>
            ))
          )}
        </DevBlock>

        <DevBlock title="Dnevnik 1-na-1" action={<Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => setCheckinModal(true)}>+ Beleška</Button>}>
          {checkins.length === 0 ? (
            <p className="text-sm text-ink-secondary">Još nema beleški.</p>
          ) : (
            <div className="space-y-2">
              {checkins.map((c) => (
                <CheckinRow key={c.id} c={c} onDelete={() => {
                  if (confirm('Obrisati ovu belešku?')) delCheckin.mutate({ id: c.id }, { onSuccess: () => toast('🗑 Beleška obrisana'), onError: () => toast('⚠ Brisanje nije uspelo') });
                }} />
              ))}
            </div>
          )}
        </DevBlock>
      </WideModal>

      {goalModal.open && (
        <GoalModal
          plan={plan}
          goal={goalModal.goal}
          onClose={() => setGoalModal({ open: false, goal: null })}
        />
      )}
      {checkinModal && <CheckinModal plan={plan} onClose={() => setCheckinModal(false)} />}
    </>
  );
}

function GoalRow({ goal, isAdmin, onEdit, onDelete }: { goal: Row; isAdmin: boolean; onEdit: () => void; onDelete: () => void }) {
  const overdue = goal['is_overdue'] === true;
  const status = sv(goal, 'status');
  const border = overdue ? 'var(--status-danger)' : status === 'ispunjeno' ? 'var(--status-success)' : 'var(--accent)';
  const due = sv(goal, 'due_date') ? formatDate(sv(goal, 'due_date')) : 'bez roka';
  return (
    <div className="rounded-panel border border-line bg-surface p-2.5" style={{ borderLeft: `4px solid ${border}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="font-medium text-ink">{sv(goal, 'title')}</div>
        <div className="flex items-center gap-2">
          <ProgressBar pct={svNum(goal, 'progress')} width="90px" />
          <Button variant="secondary" className="h-6 px-2 text-2xs" onClick={onEdit}>Uredi</Button>
          {isAdmin && <Button variant="ghost" className="h-6 px-2 text-2xs" onClick={onDelete}>✕</Button>}
        </div>
      </div>
      {sv(goal, 'description_md') && <Markdown source={sv(goal, 'description_md')} className="mt-1 text-sm text-ink-secondary" />}
      <div className={`mt-1 text-2xs ${overdue ? 'text-status-danger' : 'text-ink-secondary'}`}>
        {overdue ? '⚠ Probijen rok: ' : '📅 '}{due} · Prioritet: {PRIO_LABEL[sv(goal, 'priority')] || sv(goal, 'priority')}
      </div>
    </div>
  );
}

function CheckinRow({ c, onDelete }: { c: DevCheckin; onDelete: () => void }) {
  const who = c.authorKind === 'zaposleni' ? '👤 Zaposleni' : '👔 Nadređeni';
  return (
    <div className="rounded-panel border border-line bg-surface p-2.5">
      <div className="flex items-center justify-between text-2xs text-ink-secondary">
        <span>{who} · {c.authorEmail || ''}</span>
        <span className="flex items-center gap-2">
          {c.checkinDate ? formatDate(c.checkinDate) : ''}
          <button className="text-status-danger hover:underline" onClick={onDelete}>✕</button>
        </span>
      </div>
      <Markdown source={c.noteMd} className="mt-1 text-sm text-ink" />
    </div>
  );
}

/* ── Goal add/edit modal ── */
function GoalModal({ plan, goal, onClose }: { plan: Row; goal: Row | null; onClose: () => void }) {
  const isNew = !goal;
  const create = useCreateExpectation();
  const update = useUpdateExpectation();
  const [form, setForm] = useState({
    title: goal ? sv(goal, 'title') : '',
    category: goal ? sv(goal, 'category') : 'strucni',
    priority: goal ? sv(goal, 'priority') : 'srednja',
    dueDate: goal ? sv(goal, 'due_date') : '',
    progress: goal ? svNum(goal, 'progress') : 0,
    descriptionMd: goal ? sv(goal, 'description_md') : '',
  });
  const [err, setErr] = useState('');
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  function submit() {
    setErr('');
    if (!form.title.trim()) return setErr('Naslov je obavezan.');
    const status = form.progress >= 100 ? 'ispunjeno' : form.progress > 0 ? 'u_toku' : 'aktivno';
    if (isNew) {
      create.mutate(
        {
          employeeId: sv(plan, 'employee_id'),
          planId: sv(plan, 'id'),
          title: form.title.trim(),
          category: form.category,
          priority: form.priority,
          dueDate: form.dueDate || null,
          descriptionMd: form.descriptionMd.trim() || null,
          clientEventId: newClientEventId(),
        },
        {
          onSuccess: (res) => {
            toast('✅ Cilj dodat');
            // progress upisujemo update-om (Create DTO ne prima progress).
            const id = sv((res as { data?: Row }).data ?? null, 'id');
            if (id && form.progress > 0) update.mutate({ id, patch: { progress: form.progress, status } });
            onClose();
          },
          onError: () => setErr('Snimanje nije uspelo. Proverite dozvolu.'),
        },
      );
    } else {
      update.mutate(
        {
          id: sv(goal!, 'id'),
          patch: {
            title: form.title.trim(),
            category: form.category,
            priority: form.priority,
            dueDate: form.dueDate || null,
            descriptionMd: form.descriptionMd.trim() || null,
            progress: form.progress,
            status,
          },
        },
        { onSuccess: () => { toast('✅ Cilj sačuvan'); onClose(); }, onError: () => setErr('Snimanje nije uspelo.') },
      );
    }
  }

  return (
    <WideModal
      open
      onClose={onClose}
      maxWidth="680px"
      title={isNew ? 'Novi razvojni cilj' : 'Uredi cilj'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={create.isPending || update.isPending} onClick={submit}>{isNew ? 'Dodaj' : 'Snimi'}</Button>
        </>
      }
    >
      {err && <p className="mb-3 rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormField label="Naslov" required>
            <Input value={form.title} maxLength={200} placeholder="npr. Položiti sertifikat EN ISO 9606-1" onChange={(e) => set('title', e.target.value)} />
          </FormField>
        </div>
        <FormField label="Kategorija">
          <Select value={form.category} onChange={(v) => set('category', v)}>
            {CATEGORY_ORDER.map((c) => (<option key={c} value={c}>{DEV_CATEGORY_LABEL[c]}</option>))}
          </Select>
        </FormField>
        <FormField label="Prioritet">
          <Select value={form.priority} onChange={(v) => set('priority', v)}>
            <option value="niska">Niska</option>
            <option value="srednja">Srednja</option>
            <option value="visoka">Visoka</option>
          </Select>
        </FormField>
        <FormField label="Rok"><DateField value={form.dueDate} onChange={(v) => set('dueDate', v)} /></FormField>
        <FormField label={`Napredak: ${form.progress}%`}>
          <input type="range" min={0} max={100} step={5} value={form.progress} onChange={(e) => set('progress', Number(e.target.value))} className="w-full" />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Opis (markdown)">
            <Textarea rows={3} value={form.descriptionMd} placeholder="- korak 1&#10;- korak 2" onChange={(e) => set('descriptionMd', e.target.value)} />
          </FormField>
        </div>
      </div>
    </WideModal>
  );
}

/* ── Checkin add modal ── */
function CheckinModal({ plan, onClose }: { plan: Row; onClose: () => void }) {
  const create = useCreateCheckin();
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  function submit() {
    setErr('');
    if (!note.trim()) return setErr('Beleška je obavezna.');
    create.mutate(
      { planId: sv(plan, 'id'), employeeId: sv(plan, 'employee_id'), authorKind: 'upravljac', noteMd: note.trim(), checkinDate: date || null, clientEventId: newClientEventId() },
      { onSuccess: () => { toast('✅ Beleška dodata'); onClose(); }, onError: () => setErr('Snimanje nije uspelo.') },
    );
  }

  return (
    <WideModal
      open
      onClose={onClose}
      maxWidth="620px"
      title="Nova beleška (1-na-1)"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={create.isPending} onClick={submit}>Sačuvaj</Button>
        </>
      }
    >
      {err && <p className="mb-3 rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
      <div className="space-y-4">
        <FormField label="Datum"><DateField value={date} onChange={setDate} /></FormField>
        <FormField label="Beleška (markdown)" required>
          <Textarea rows={5} value={note} placeholder="Šta je dogovoreno, prepreke, naredni koraci..." onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </div>
    </WideModal>
  );
}

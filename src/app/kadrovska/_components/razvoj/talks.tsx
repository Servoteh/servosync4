'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { DictateButton, RefineButton } from '@/components/voice-controls';
import { Markdown } from '@/lib/markdown';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  useTalks,
  useKadrMe,
  useCreateTalk,
  useUpdateTalk,
  useDeleteTalk,
  useShareTalk,
  useUnshareTalk,
  useCreateCorrectivePlan,
  useUpdateCorrectivePlan,
  useCreateMeasure,
  useUpdateMeasure,
  useDeleteMeasure,
  newClientEventId,
  type EmployeeTalk,
  type CorrectivePlan,
  type CorrectiveMeasure,
} from '@/api/kadrovska';
import { SummaryChips } from '../common';
import {
  TALK_TYPE_LABEL,
  TALK_STATUS_LABEL,
  RAISE_DECISION_LABEL,
  CPLAN_STATUS_LABEL,
  MEASURE_STATUS_LABEL,
  EmployeeSelect,
  Select,
  DateField,
  WideModal,
  DevBlock,
  useNameMap,
  todayIso,
} from './shared';

const TALK_TONE: Record<string, Tone> = { nacrt: 'neutral', podeljen: 'info', potvrdjen: 'success' };

export function TalksSection() {
  const { can } = useAuth();
  const isAdmin = can(PERMISSIONS.KADROVSKA_ADMIN);
  const meQ = useKadrMe();
  const myEmpId = meQ.data?.data?.employeeId ?? null;
  const { nm } = useNameMap();
  const talksQ = useTalks({}, true);

  const [typeFilter, setTypeFilter] = useState('');
  const [editTalk, setEditTalk] = useState<{ open: boolean; talk: EmployeeTalk | null }>({ open: false, talk: null });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [planEditorId, setPlanEditorId] = useState<string | null>(null);

  const bundle = talksQ.data?.data;
  const talks = bundle?.talks ?? [];
  const plans = bundle?.correctivePlans ?? [];
  const measures = bundle?.correctiveMeasures ?? [];
  const measuresByPlan = useMemo(() => {
    const m = new Map<string, CorrectiveMeasure[]>();
    for (const x of measures) (m.get(x.planId) ?? m.set(x.planId, []).get(x.planId)!).push(x);
    return m;
  }, [measures]);
  const activePlans = plans.filter((p) => !p.status.startsWith('zatvoren'));

  const shown = typeFilter ? talks.filter((t) => t.talkType === typeFilter) : talks;
  const waiting = talks.filter((t) => t.status === 'podeljen').length;
  const detailTalk = detailId ? talks.find((t) => t.id === detailId) ?? null : null;
  const editorPlan = planEditorId ? plans.find((p) => p.id === planEditorId) ?? null : null;

  const cols: Column<EmployeeTalk>[] = [
    { key: 'date', header: 'Datum', render: (t) => (t.talkDate ? formatDate(t.talkDate) : '—') },
    { key: 'emp', header: 'Zaposleni', render: (t) => <span className="font-medium">{nm(t.employeeId)}</span> },
    { key: 'type', header: 'Tip', render: (t) => TALK_TYPE_LABEL[t.talkType] || t.talkType },
    { key: 'title', header: 'Naslov', render: (t) => <span className="text-ink-secondary">{t.title || '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (t) => (
        <span className="flex items-center gap-1.5">
          <StatusBadge tone={TALK_TONE[t.status] ?? 'neutral'} label={TALK_STATUS_LABEL[t.status] || t.status} />
          {t.status === 'potvrdjen' && t.acknowledgedAt && <span className="text-2xs text-ink-secondary">{formatDate(t.acknowledgedAt)}</span>}
        </span>
      ),
    },
    {
      key: 'raise',
      header: 'Odluka o zaradi',
      render: (t) =>
        t.talkType === 'godisnji' && t.raiseDecision
          ? `${RAISE_DECISION_LABEL[t.raiseDecision] || t.raiseDecision}${t.raisePercent ? ` (${t.raisePercent}%)` : ''}`
          : '—',
    },
    { key: 'act', header: '', render: (t) => <div onClick={(e) => e.stopPropagation()}><Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => setDetailId(t.id)}>Otvori</Button></div> },
  ];

  const planCols: Column<CorrectivePlan>[] = [
    { key: 'emp', header: 'Zaposleni', render: (p) => <span className="font-medium">{nm(p.employeeId)}</span> },
    { key: 'status', header: 'Status', render: (p) => CPLAN_STATUS_LABEL[p.status] || p.status },
    {
      key: 'measures',
      header: 'Mere (ispunjeno)',
      align: 'right',
      render: (p) => {
        const ms = measuresByPlan.get(p.id) ?? [];
        const done = ms.filter((m) => m.status === 'ispunjeno').length;
        const overdue = ms.some((m) => m.dueDate && m.status !== 'ispunjeno' && m.dueDate < todayIso());
        return <span className={overdue ? 'font-semibold text-status-danger' : ''}>{done}/{ms.length}{overdue ? ' ⚠' : ''}</span>;
      },
    },
    { key: 'follow', header: 'Follow-up', render: (p) => (p.followupDate ? formatDate(p.followupDate) : '—') },
    { key: 'act', header: '', render: (p) => <div onClick={(e) => e.stopPropagation()}><Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => setPlanEditorId(p.id)}>Otvori plan</Button></div> },
  ];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">🗣 Razgovori i korektivne mere</h3>
        <Select value={typeFilter} onChange={setTypeFilter} className="h-8 w-auto">
          <option value="">Svi tipovi</option>
          {Object.entries(TALK_TYPE_LABEL).map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
        </Select>
        <div className="flex-1" />
        <Button onClick={() => setEditTalk({ open: true, talk: null })}>+ Novi razgovor</Button>
      </div>
      <SummaryChips
        items={[
          { label: 'Zapisnika', value: talks.length },
          { label: 'Čeka potvrdu', value: waiting, tone: waiting ? 'warn' : undefined },
          { label: 'Aktivnih kor. planova', value: activePlans.length },
        ]}
      />

      <DataTable
        columns={cols}
        rows={shown}
        rowKey={(t) => t.id}
        onRowActivate={(t) => setDetailId(t.id)}
        loading={talksQ.isLoading}
        empty={<EmptyState title="Nema zapisnika" hint={'Razgovor upisujete dugmetom „+ Novi razgovor" (podržava 🎤 diktiranje).'} />}
      />

      {activePlans.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-ink">⚠ Aktivni korektivni planovi</h4>
          <DataTable columns={planCols} rows={activePlans} rowKey={(p) => p.id} onRowActivate={(p) => setPlanEditorId(p.id)} empty={<EmptyState title="—" />} />
        </div>
      )}

      {editTalk.open && (
        <TalkModal
          talk={editTalk.talk}
          excludeSelf={myEmpId}
          onClose={() => setEditTalk({ open: false, talk: null })}
          onSaved={(id) => { setEditTalk({ open: false, talk: null }); if (id) setDetailId(id); }}
        />
      )}
      {detailTalk && (
        <TalkDetailModal
          talk={detailTalk}
          plans={plans.filter((p) => p.talkId === detailTalk.id)}
          measuresByPlan={measuresByPlan}
          isAdmin={isAdmin}
          onClose={() => setDetailId(null)}
          onEdit={() => { setEditTalk({ open: true, talk: detailTalk }); setDetailId(null); }}
          onOpenPlan={(pid) => { setDetailId(null); setPlanEditorId(pid); }}
        />
      )}
      {editorPlan && <PlanEditorModal plan={editorPlan} measures={measuresByPlan.get(editorPlan.id) ?? []} onClose={() => setPlanEditorId(null)} />}
    </section>
  );
}

/* ── Talk create/edit modal (STT + AI refine) ── */
function TalkModal({ talk, excludeSelf, onClose, onSaved }: { talk: EmployeeTalk | null; excludeSelf: string | null; onClose: () => void; onSaved: (id?: string) => void }) {
  const isNew = !talk;
  const create = useCreateTalk();
  const update = useUpdateTalk();
  const [form, setForm] = useState({
    employeeId: talk?.employeeId ?? '',
    talkType: talk?.talkType ?? 'jedan_na_jedan',
    talkDate: talk?.talkDate ?? todayIso(),
    title: talk?.title ?? '',
    zapisnikMd: talk?.zapisnikMd ?? '',
    raiseDecision: talk?.raiseDecision ?? '',
    raisePercent: talk?.raisePercent ?? '',
    raiseEffectiveFrom: talk?.raiseEffectiveFrom ?? '',
    raiseNote: talk?.raiseNote ?? '',
  });
  const [err, setErr] = useState('');
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const isGodisnji = form.talkType === 'godisnji';

  function submit() {
    setErr('');
    if (!form.employeeId) return setErr('Izaberite zaposlenog.');
    const payload = {
      employeeId: form.employeeId,
      talkType: form.talkType,
      talkDate: form.talkDate || todayIso(),
      title: form.title.trim() || null,
      zapisnikMd: form.zapisnikMd.trim() || null,
      raiseDecision: isGodisnji ? (form.raiseDecision || null) : null,
      raisePercent: isGodisnji && form.raisePercent !== '' ? Number(form.raisePercent) : null,
      raiseEffectiveFrom: isGodisnji ? (form.raiseEffectiveFrom || null) : null,
      raiseNote: isGodisnji ? (form.raiseNote.toString().trim() || null) : null,
    };
    if (isNew) {
      create.mutate(
        { ...payload, clientEventId: newClientEventId() },
        { onSuccess: (res) => { toast('✅ Zapisnik sačuvan (nacrt)'); onSaved(res.data?.id); }, onError: () => setErr('Snimanje nije uspelo (svoje zapisnike ne možete voditi).') },
      );
    } else {
      update.mutate(
        { id: talk!.id, patch: payload },
        { onSuccess: () => { toast('✅ Sačuvano'); onSaved(talk!.id); }, onError: () => setErr('Snimanje nije uspelo.') },
      );
    }
  }

  return (
    <WideModal
      open
      onClose={onClose}
      maxWidth="760px"
      title={isNew ? '🗣 Novi razgovor' : '✎ Uredi razgovor'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={create.isPending || update.isPending} onClick={submit}>{isNew ? 'Sačuvaj nacrt' : 'Snimi'}</Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-secondary">Zapisnik ostaje u nacrtu dok ga ne podelite; zaposleni ga tada vidi u „Moj profil" i potvrđuje da je upoznat.</p>
      {err && <p className="mb-3 rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Zaposleni" required>
          <EmployeeSelect value={form.employeeId} onChange={(v) => set('employeeId', v)} excludeId={excludeSelf} disabled={!isNew} />
        </FormField>
        <FormField label="Tip razgovora" required>
          <Select value={form.talkType} onChange={(v) => set('talkType', v)}>
            {Object.entries(TALK_TYPE_LABEL).map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
          </Select>
        </FormField>
        <FormField label="Datum razgovora"><DateField value={form.talkDate} onChange={(v) => set('talkDate', v)} /></FormField>
        <FormField label="Naslov (opciono)">
          <Input value={form.title} maxLength={160} placeholder="npr. Godišnji razgovor 2026" onChange={(e) => set('title', e.target.value)} />
        </FormField>
        <div className="sm:col-span-2">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-base font-medium text-ink">Zapisnik (markdown)</label>
            <div className="flex gap-1">
              <DictateButton context="zapisnik" onText={(t) => set('zapisnikMd', (form.zapisnikMd ? form.zapisnikMd + ' ' : '') + t)} />
              <RefineButton profil="zapisnik" getText={() => form.zapisnikMd} onText={(t) => set('zapisnikMd', t)} />
            </div>
          </div>
          <Textarea rows={8} value={form.zapisnikMd} placeholder="Tok razgovora, zaključci, dogovori..." onChange={(e) => set('zapisnikMd', e.target.value)} />
        </div>
        {isGodisnji && (
          <div className="rounded-panel border border-line p-3 sm:col-span-2">
            <div className="text-sm font-semibold text-ink">💰 Odluka o zaradi (godišnji razgovor)</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Select value={form.raiseDecision} onChange={(v) => set('raiseDecision', v)} className="w-auto">
                <option value="">— bez odluke —</option>
                {Object.entries(RAISE_DECISION_LABEL).map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
              </Select>
              <input type="number" step={0.1} min={0} max={500} value={String(form.raisePercent)} placeholder="%" onChange={(e) => set('raisePercent', e.target.value)} className="h-9 w-24 rounded-control border border-line bg-surface px-2 text-base text-ink" />
              <span className="flex items-center gap-2 text-sm text-ink-secondary">važi od <DateField value={form.raiseEffectiveFrom} onChange={(v) => set('raiseEffectiveFrom', v)} /></span>
            </div>
            <Input className="mt-2" value={String(form.raiseNote)} maxLength={300} placeholder="Obrazloženje odluke (opciono)" onChange={(e) => set('raiseNote', e.target.value)} />
            <p className="mt-1.5 text-2xs text-ink-secondary">Zaposleni vidi odluku kad podelite zapisnik. Povećanje se sprovodi u modulu Zarade.</p>
          </div>
        )}
      </div>
    </WideModal>
  );
}

/* ── Talk detail modal ── */
function TalkDetailModal({
  talk,
  plans,
  measuresByPlan,
  isAdmin,
  onClose,
  onEdit,
  onOpenPlan,
}: {
  talk: EmployeeTalk;
  plans: CorrectivePlan[];
  measuresByPlan: Map<string, CorrectiveMeasure[]>;
  isAdmin: boolean;
  onClose: () => void;
  onEdit: () => void;
  onOpenPlan: (planId: string) => void;
}) {
  const { nm } = useNameMap();
  const share = useShareTalk();
  const unshare = useUnshareTalk();
  const del = useDeleteTalk();
  const createPlan = useCreateCorrectivePlan();
  const isDraft = talk.status === 'nacrt';
  const empName = nm(talk.employeeId);
  const hasRaise = talk.talkType === 'godisnji' && (talk.raiseDecision || talk.raiseNote);

  function doShare() {
    share.mutate({ id: talk.id, clientEventId: newClientEventId() }, {
      onSuccess: (res) => { toast(res.data?.emailed ? '📨 Podeljeno — zaposleni je obavešten mejlom' : '📨 Podeljeno (zaposleni nema email — videće u Moj profil)'); onClose(); },
      onError: () => toast('⚠ Deljenje nije uspelo'),
    });
  }
  function doUnshare() {
    unshare.mutate({ id: talk.id, clientEventId: newClientEventId() }, {
      onSuccess: (res) => { if (res.data?.status === 'already_acknowledged') toast('⚠ Zaposleni je već potvrdio — nema povlačenja'); else { toast('🙈 Vraćeno u nacrt'); onClose(); } },
      onError: () => toast('⚠ Nije uspelo'),
    });
  }
  function doDelete() {
    if (!confirm(`Obrisati zapisnik razgovora za ${empName}?`)) return;
    del.mutate({ id: talk.id }, { onSuccess: () => { toast('🗑 Zapisnik obrisan'); onClose(); }, onError: () => toast('⚠ Brisanje nije uspelo') });
  }
  function newCorrectivePlan() {
    createPlan.mutate(
      { employeeId: talk.employeeId, talkId: talk.id, visibleToEmployee: talk.status !== 'nacrt', clientEventId: newClientEventId() },
      { onSuccess: (res) => { toast('✅ Plan mera otvoren'); onOpenPlan(res.data.id); }, onError: () => toast('⚠ Plan nije kreiran') },
    );
  }

  return (
    <WideModal
      open
      onClose={onClose}
      maxWidth="860px"
      title={`🗣 ${TALK_TYPE_LABEL[talk.talkType] || 'Razgovor'} — ${empName}`}
      titleExtra={
        <>
          {isDraft && <Button variant="secondary" className="h-7 px-2 text-xs" onClick={onEdit}>✎ Uredi</Button>}
          {(isDraft || isAdmin) && <Button variant="ghost" className="h-7 px-2 text-xs" onClick={doDelete}>🗑</Button>}
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Zatvori</Button>
          {isDraft && <Button loading={share.isPending} onClick={doShare}>📨 Podeli sa zaposlenim</Button>}
          {talk.status === 'podeljen' && <Button variant="secondary" loading={unshare.isPending} onClick={doUnshare}>🙈 Vrati u nacrt</Button>}
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-secondary">
        <span>{talk.talkDate ? formatDate(talk.talkDate) : ''}</span>
        <span>· Vodio: {talk.conductedBy || '—'}</span>
        <StatusBadge tone={TALK_TONE[talk.status] ?? 'neutral'} label={TALK_STATUS_LABEL[talk.status] || talk.status} />
        {talk.sharedAt && <span>· podeljeno {formatDate(talk.sharedAt)}</span>}
      </div>
      {talk.title && <h3 className="text-md font-semibold text-ink">{talk.title}</h3>}
      <DevBlock title="Zapisnik">
        {talk.zapisnikMd ? <Markdown source={talk.zapisnikMd} /> : <p className="text-sm text-ink-secondary">Zapisnik je prazan.</p>}
      </DevBlock>
      {hasRaise && (
        <DevBlock title="💰 Odluka o zaradi">
          <p className="text-sm text-ink">
            <strong>{RAISE_DECISION_LABEL[talk.raiseDecision ?? ''] || '—'}</strong>
            {talk.raisePercent ? ` · ${talk.raisePercent}%` : ''}
            {talk.raiseEffectiveFrom ? ` · važi od ${formatDate(talk.raiseEffectiveFrom)}` : ''}
          </p>
          {talk.raiseNote && <p className="mt-1 text-sm text-ink-secondary">{talk.raiseNote}</p>}
          {talk.raiseDecision === 'da' && <p className="mt-1 text-2xs text-ink-secondary">Sprovođenje: Kadrovska → Zarade → zaposleni → „Nova izmena" ugovorne zarade.</p>}
        </DevBlock>
      )}
      {talk.talkType === 'korektivni' && (
        <DevBlock
          title="⚠ Plan korektivnih mera"
          action={plans.length === 0 ? <Button variant="secondary" className="h-7 px-2 text-xs" loading={createPlan.isPending} onClick={newCorrectivePlan}>+ Otvori plan mera</Button> : undefined}
        >
          {plans.length === 0 ? (
            <p className="text-sm text-ink-secondary">Još nema plana mera.</p>
          ) : (
            <div className="space-y-2">
              {plans.map((p) => {
                const ms = measuresByPlan.get(p.id) ?? [];
                const done = ms.filter((m) => m.status === 'ispunjeno').length;
                return (
                  <div key={p.id} className="flex items-center justify-between rounded-panel border border-line px-3 py-2 text-sm">
                    <span>{CPLAN_STATUS_LABEL[p.status] || p.status} · mere {done}/{ms.length}{p.followupDate ? ` · follow-up ${formatDate(p.followupDate)}` : ''}</span>
                    <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => onOpenPlan(p.id)}>Otvori plan</Button>
                  </div>
                );
              })}
            </div>
          )}
        </DevBlock>
      )}
    </WideModal>
  );
}

/* ── Corrective plan editor ── */
function PlanEditorModal({ plan, measures, onClose }: { plan: CorrectivePlan; measures: CorrectiveMeasure[]; onClose: () => void }) {
  const { nm } = useNameMap();
  const update = useUpdateCorrectivePlan();
  const delMeasure = useDeleteMeasure();
  const [reason, setReason] = useState(plan.reasonMd ?? '');
  const [status, setStatus] = useState(plan.status);
  const [followup, setFollowup] = useState(plan.followupDate ?? '');
  const [measureModal, setMeasureModal] = useState<{ open: boolean; measure: CorrectiveMeasure | null }>({ open: false, measure: null });

  function save() {
    const patch: { reasonMd: string | null; status: string; followupDate: string | null; closedAt?: string } = {
      reasonMd: reason.trim() || null,
      status,
      followupDate: followup || null,
    };
    if (status.startsWith('zatvoren') && !plan.closedAt) patch.closedAt = new Date().toISOString();
    update.mutate({ id: plan.id, patch }, { onSuccess: () => { toast('💾 Plan sačuvan'); onClose(); }, onError: () => toast('⚠ Snimanje nije uspelo') });
  }

  return (
    <>
      <WideModal
        open
        onClose={onClose}
        maxWidth="860px"
        title={`⚠ Plan korektivnih mera — ${nm(plan.employeeId)}`}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>Zatvori</Button>
            <Button loading={update.isPending} onClick={save}>💾 Sačuvaj plan</Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-base font-medium text-ink">Razlog / kontekst (markdown)</label>
              <div className="flex gap-1">
                <DictateButton context="zapisnik" onText={(t) => setReason((r) => (r ? r + ' ' : '') + t)} />
                <RefineButton profil="napomena" getText={() => reason} onText={setReason} />
              </div>
            </div>
            <Textarea rows={3} value={reason} placeholder="Šta je dovelo do korektivnog plana..." onChange={(e) => setReason(e.target.value)} />
          </div>
          <FormField label="Status plana">
            <Select value={status} onChange={setStatus}>
              {Object.entries(CPLAN_STATUS_LABEL).map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
            </Select>
          </FormField>
          <FormField label="Follow-up razgovor (datum)"><DateField value={followup} onChange={setFollowup} /></FormField>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Mere</h4>
          <Button variant="secondary" className="h-7 px-2 text-xs" onClick={() => setMeasureModal({ open: true, measure: null })}>+ Nova mera</Button>
        </div>
        <div className="mt-2 space-y-2">
          {measures.length === 0 ? (
            <p className="text-sm text-ink-secondary">Još nema mera.</p>
          ) : (
            measures.map((m) => {
              const overdue = m.dueDate && m.status !== 'ispunjeno' && m.dueDate < todayIso();
              const border = m.status === 'ispunjeno' ? 'var(--status-success)' : m.status === 'neispunjeno' ? 'var(--status-danger)' : m.status === 'u_toku' ? 'var(--accent)' : 'var(--line)';
              return (
                <div key={m.id} className="rounded-panel border border-line p-2.5" style={{ borderLeft: `4px solid ${border}` }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-sm font-medium text-ink">{(m.descriptionMd || '').replace(/\s+/g, ' ').slice(0, 140)}</div>
                    <div className="flex gap-1.5">
                      <Button variant="secondary" className="h-6 px-2 text-2xs" onClick={() => setMeasureModal({ open: true, measure: m })}>Uredi</Button>
                      <Button variant="ghost" className="h-6 px-2 text-2xs" onClick={() => { if (confirm('Obrisati ovu meru?')) delMeasure.mutate({ id: m.id }, { onSuccess: () => toast('🗑 Mera obrisana'), onError: () => toast('⚠ Brisanje nije uspelo') }); }}>✕</Button>
                    </div>
                  </div>
                  <div className={`mt-1 text-2xs ${overdue ? 'text-status-danger' : 'text-ink-secondary'}`}>
                    {MEASURE_STATUS_LABEL[m.status] || m.status}
                    {m.dueDate ? ` · rok ${formatDate(m.dueDate)}${overdue ? ' ⚠ probijen' : ''}` : ''}
                    {m.responsibleEmployeeId ? ` · odgovoran: ${nm(m.responsibleEmployeeId)}` : ''}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <p className="mt-2 text-2xs text-ink-secondary">Probijen rok mere automatski šalje mejl vama i administraciji (jednom po meri). Promena roka daje novu šansu za podsetnik.</p>
      </WideModal>
      {measureModal.open && <MeasureModal plan={plan} measure={measureModal.measure} onClose={() => setMeasureModal({ open: false, measure: null })} />}
    </>
  );
}

/* ── Measure add/edit modal ── */
function MeasureModal({ plan, measure, onClose }: { plan: CorrectivePlan; measure: CorrectiveMeasure | null; onClose: () => void }) {
  const isNew = !measure;
  const create = useCreateMeasure();
  const update = useUpdateMeasure();
  const [desc, setDesc] = useState(measure?.descriptionMd ?? '');
  const [due, setDue] = useState(measure?.dueDate ?? '');
  const [resp, setResp] = useState(measure?.responsibleEmployeeId ?? plan.employeeId);
  const [status, setStatus] = useState(measure?.status ?? 'otvoreno');
  const [note, setNote] = useState(measure?.note ?? '');
  const [err, setErr] = useState('');

  function submit() {
    setErr('');
    if (!desc.trim()) return setErr('Opis mere je obavezan.');
    if (isNew) {
      create.mutate(
        { planId: plan.id, descriptionMd: desc.trim(), dueDate: due || null, responsibleEmployeeId: resp || null, status, note: note.trim() || null, clientEventId: newClientEventId() },
        { onSuccess: () => { toast('✅ Mera dodata'); onClose(); }, onError: () => setErr('Snimanje nije uspelo.') },
      );
    } else {
      update.mutate(
        { id: measure!.id, patch: { descriptionMd: desc.trim(), dueDate: due || null, responsibleEmployeeId: resp || null, status, note: note.trim() || null } },
        { onSuccess: () => { toast('✅ Mera sačuvana'); onClose(); }, onError: () => setErr('Snimanje nije uspelo.') },
      );
    }
  }

  return (
    <WideModal
      open
      onClose={onClose}
      maxWidth="620px"
      title={isNew ? 'Nova mera' : 'Uredi meru'}
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
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-base font-medium text-ink">Mera <span className="text-status-danger">*</span></label>
            <div className="flex gap-1">
              <DictateButton context="zapisnik" onText={(t) => setDesc((d) => (d ? d + ' ' : '') + t)} />
              <RefineButton profil="napomena" getText={() => desc} onText={setDesc} />
            </div>
          </div>
          <Textarea rows={3} value={desc} placeholder="Šta konkretno treba da se uradi..." onChange={(e) => setDesc(e.target.value)} />
        </div>
        <FormField label="Rok"><DateField value={due} onChange={setDue} /></FormField>
        <FormField label="Odgovoran">
          <EmployeeSelect value={resp} onChange={setResp} blankLabel="— zaposleni sam —" />
        </FormField>
        <FormField label="Status">
          <Select value={status} onChange={setStatus}>
            {Object.entries(MEASURE_STATUS_LABEL).map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
          </Select>
        </FormField>
        <FormField label="Napomena">
          <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </div>
    </WideModal>
  );
}

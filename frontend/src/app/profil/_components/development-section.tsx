'use client';

// Plan razvoja (P3) — self-write. Paritet 1.0 `src/ui/mojProfil/index.js`
// (~2487-2630 _myDevPlanCardHtml / _mpGoalRowHtml / _wireDevPlan) + `services/devPlans.js`.
// BE agregira plan + ciljeve (employee_expectations sa plan_id) + dnevnik 1-na-1.
// FE piše: progres cilja (slider), samoprocenu (textarea), belešku (check-in).

import { useEffect, useState } from 'react';
import { BookOpen, Target, Handshake, Calendar, AlertTriangle, User, Briefcase } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { Markdown } from '@/lib/markdown';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import {
  newClientEventId,
  useDevPlan,
  useSaveSelfAssessment,
  useAddCheckin,
  useUpdateMyExpectation,
  type DevPlan,
  type DevCheckin,
  type Expectation,
} from '@/api/moj-profil';
import { Section } from './section';

/** Kategorija cilja → srpska labela (paritet 1.0 DEV_CATEGORY_LABEL). */
const DEV_CATEGORY_LABEL: Record<string, string> = {
  strucni: 'Stručni razvoj',
  sertifikat: 'Sertifikat / obuka',
  soft_skill: 'Soft-skill',
  liderstvo: 'Liderstvo',
  ostalo: 'Ostalo',
};
const DEV_CAT_ORDER = ['strucni', 'sertifikat', 'soft_skill', 'liderstvo', 'ostalo'];

/** Čita polje plana tolerantno na camelCase alias (paralelni BE) — snake je kanon iz kontrakta. */
function planStr(p: DevPlan, snake: string, camel: string): string | null {
  const v = (p[snake] ?? p[camel]) as unknown;
  return v == null ? null : String(v);
}
function planNum(p: DevPlan, snake: string, camel: string): number | null {
  const v = (p[snake] ?? p[camel]) as unknown;
  return v == null ? null : Number(v);
}

function isOverdue(due: string | null): boolean {
  if (!due) return false;
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

export function DevelopmentSection() {
  const q = useDevPlan();
  const data = q.data?.data ?? null;

  // Prazno stanje: sekcija se prikazuje samo kad plan postoji (paritet 1.0 — kartica se
  // renderuje tek kad `myDevPlan` postoji). Bez plana → ne renderuj ništa.
  if (q.isLoading || q.isError || !data?.plan) return null;

  const { plan, goals, checkins } = data;
  const period = planStr(plan, 'period_label', 'periodLabel') ?? '—';
  const targetPos = planStr(plan, 'target_position', 'targetPosition');
  const mentor = planStr(plan, 'mentor', 'mentor');
  const careerGoal = planStr(plan, 'career_goal_md', 'careerGoalMd');
  const summary = planStr(plan, 'summary_md', 'summaryMd');
  const selfAssessInit = planStr(plan, 'self_assessment_md', 'selfAssessmentMd') ?? '';
  const progress = Math.max(0, Math.min(100, Math.round(planNum(plan, 'progress', 'progress') ?? 0)));

  // Grupiši ciljeve po kategoriji, u fiksnom redosledu.
  const byCat = new Map<string, Expectation[]>();
  for (const g of goals) {
    const cat = g.category || 'ostalo';
    const arr = byCat.get(cat) ?? [];
    arr.push(g);
    byCat.set(cat, arr);
  }
  const orderedCats = [
    ...DEV_CAT_ORDER.filter((c) => byCat.has(c)),
    ...[...byCat.keys()].filter((c) => !DEV_CAT_ORDER.includes(c)),
  ];

  return (
    <Section icon={<BookOpen className="h-4 w-4 text-ink-secondary" />} title="Moj plan razvoja">
      <div className="space-y-4">
        {/* Zaglavlje plana */}
        <div className="rounded-control border border-line-soft bg-surface-2 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm font-semibold text-ink">
              {period}
              {targetPos && <span className="ml-1 inline-flex items-center gap-1 font-normal text-ink-secondary">· <Target className="h-3.5 w-3.5" aria-hidden /> cilj: {targetPos}</span>}
            </div>
            {mentor && <div className="flex items-center gap-1 text-xs text-ink-secondary"><Handshake className="h-3.5 w-3.5" aria-hidden /> Mentor: {mentor}</div>}
          </div>
          <ProgressBar pct={progress} className="mt-3" />
          {careerGoal && (
            <MdBlock title="Karijerni cilj" md={careerGoal} />
          )}
          {summary && <MdBlock title="Sažetak" md={summary} />}
        </div>

        {/* Razvojni ciljevi */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Razvojni ciljevi</h3>
          {goals.length === 0 ? (
            <p className="text-sm text-ink-disabled">Vaš nadređeni još nije definisao ciljeve.</p>
          ) : (
            <div className="space-y-3">
              {orderedCats.map((cat) => (
                <div key={cat}>
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                    {DEV_CATEGORY_LABEL[cat] || cat}
                  </div>
                  <div className="space-y-2">
                    {byCat.get(cat)!.map((g) => (
                      <GoalRow key={g.id} goal={g} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Moja samoprocena */}
        <SelfAssessmentBlock planId={plan.id} initial={selfAssessInit} />

        {/* Dnevnik 1-na-1 */}
        <CheckinBlock planId={plan.id} checkins={checkins} />
      </div>
    </Section>
  );
}

function ProgressBar({ pct, className }: { pct: number; className?: string }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const tone = p >= 100 ? 'bg-status-success' : p > 0 ? 'bg-accent' : 'bg-line';
  return (
    <div className={className}>
      <div className="relative h-4 overflow-hidden rounded-full bg-surface-2 ring-1 ring-inset ring-line" title={`${p}%`}>
        <div className={`h-full rounded-full ${tone} transition-[width]`} style={{ width: `${p}%` }} />
        <span className="absolute inset-0 grid place-items-center text-2xs font-semibold text-ink">{p}%</span>
      </div>
    </div>
  );
}

function MdBlock({ title, md }: { title: string; md: string }) {
  return (
    <div className="mt-3">
      <h4 className="mb-1 text-sm font-semibold text-ink">{title}</h4>
      <Markdown source={md} className="text-sm text-ink-secondary" />
    </div>
  );
}

function GoalRow({ goal }: { goal: Expectation }) {
  const done = goal.status === 'ispunjeno' || goal.status === 'otkazano';
  const overdue = isOverdue(goal.dueDate);
  const [prog, setProg] = useState(goal.progress ?? 0);
  const upd = useUpdateMyExpectation();

  // Sinhronizuj lokalni slider kad server pošalje novu vrednost.
  useEffect(() => {
    setProg(goal.progress ?? 0);
  }, [goal.progress]);

  const border = overdue ? 'border-l-status-danger' : done ? 'border-l-status-success' : 'border-l-accent';

  async function commit(value: number) {
    try {
      await upd.mutateAsync({ id: goal.id, progress: value });
      toast('Napredak sačuvan');
    } catch (e) {
      setProg(goal.progress ?? 0); // rollback lokalno
      toast(e instanceof ApiError ? e.message : 'Snimanje napretka nije uspelo');
    }
  }

  return (
    <div className={`rounded-control border border-line-soft border-l-4 ${border} bg-surface-2 p-3`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink">{goal.title}</span>
        <span className={`inline-flex items-center gap-1 text-xs ${overdue ? 'text-status-danger' : 'text-ink-secondary'}`}>
          {overdue ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : <Calendar className="h-3.5 w-3.5" aria-hidden />}
          {goal.dueDate ? formatDate(goal.dueDate) : 'bez roka'}
        </span>
      </div>
      {goal.descriptionMd && <Markdown source={goal.descriptionMd} className="mt-1 text-sm text-ink-secondary" />}
      <div className="mt-2 flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={prog}
          disabled={done || upd.isPending}
          onChange={(e) => setProg(Number(e.target.value))}
          onMouseUp={() => prog !== (goal.progress ?? 0) && commit(prog)}
          onTouchEnd={() => prog !== (goal.progress ?? 0) && commit(prog)}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
              if (prog !== (goal.progress ?? 0)) commit(prog);
            }
          }}
          className="flex-1 accent-accent disabled:opacity-50"
          aria-label={`Napredak cilja: ${goal.title}`}
        />
        <span className="min-w-10 text-right text-sm tnums text-ink">{prog}%</span>
      </div>
    </div>
  );
}

function SelfAssessmentBlock({ planId, initial }: { planId: string; initial: string }) {
  const [text, setText] = useState(initial);
  const save = useSaveSelfAssessment();

  // Osveži polje kad server vrati novu vrednost (posle snimanja / refetch-a).
  useEffect(() => {
    setText(initial);
  }, [initial]);

  async function commit() {
    try {
      await save.mutateAsync({ id: planId, selfAssessmentMd: text.trim() || null });
      toast('Samoprocena sačuvana');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Snimanje nije uspelo');
    }
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-ink">Moja samoprocena</h3>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Kako Vi vidite svoj napredak, izazove, potrebe…"
      />
      <div className="mt-2 flex justify-end">
        <Button onClick={commit} loading={save.isPending}>
          Sačuvaj samoprocenu
        </Button>
      </div>
    </div>
  );
}

function CheckinBlock({ planId, checkins }: { planId: string; checkins: DevCheckin[] }) {
  const [note, setNote] = useState('');
  const add = useAddCheckin();

  async function commit() {
    const n = note.trim();
    if (!n) {
      toast('Beleška je prazna');
      return;
    }
    try {
      await add.mutateAsync({ id: planId, clientEventId: newClientEventId(), noteMd: n });
      setNote('');
      toast('Beleška dodata');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Snimanje nije uspelo');
    }
  }

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-ink">Dnevnik 1-na-1</h3>
      {checkins.length === 0 ? (
        <p className="text-sm text-ink-disabled">Još nema beleški sa 1-na-1 razgovora.</p>
      ) : (
        <ul className="space-y-2">
          {checkins.map((c) => (
            <li key={c.id} className="rounded-control border border-line-soft bg-surface-2 p-3">
              <div className="mb-1 flex items-center justify-between text-xs text-ink-secondary">
                <span className="inline-flex items-center gap-1">
                  {c.kind === 'zaposleni' ? <><User className="h-3.5 w-3.5" aria-hidden /> Ja</> : <><Briefcase className="h-3.5 w-3.5" aria-hidden /> Nadređeni</>}
                </span>
                <span className="tnums">{c.checkin_date ? formatDate(c.checkin_date) : ''}</span>
              </div>
              <Markdown source={c.note_md} className="text-sm text-ink" />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Dodajte svoju belešku / refleksiju…" />
        <div className="mt-2 flex justify-end">
          <Button variant="secondary" onClick={commit} loading={add.isPending}>
            + Dodaj belešku
          </Button>
        </div>
      </div>
    </div>
  );
}

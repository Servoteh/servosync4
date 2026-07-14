'use client';

import { useMemo } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { useDevPlans, useTalks, useAssessments, useDirectory, type EmployeeTalk, type Assessment } from '@/api/kadrovska';
import { SummaryChips, sv } from './common';

type ViewRow = Record<string, unknown>;

const TALK_TYPE: Record<string, string> = {
  godisnji: 'Godišnji (učinak i zarada)',
  korektivni: 'Korektivni',
  jedan_na_jedan: '1-na-1',
};
const TALK_STATUS: Record<string, { tone: Tone; label: string }> = {
  nacrt: { tone: 'neutral', label: 'Nacrt' },
  podeljen: { tone: 'info', label: 'Podeljen' },
  potvrdjen: { tone: 'success', label: 'Potvrđen' },
};
const ASSESS_STATUS: Record<string, { tone: Tone; label: string }> = {
  draft: { tone: 'neutral', label: 'Nacrt' },
  collecting: { tone: 'info', label: 'Prikupljanje' },
  closed: { tone: 'warn', label: 'Zatvorena' },
  shared: { tone: 'success', label: 'Podeljena' },
};

export function RazvojTab() {
  const plansQ = useDevPlans({}, true);
  const talksQ = useTalks({}, true);
  const assessQ = useAssessments({}, true);
  const dirQ = useDirectory();

  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of dirQ.data?.data ?? []) m.set(sv(r, 'id'), sv(r, 'full_name'));
    return m;
  }, [dirQ.data]);
  const nm = (id: string | null) => (id ? nameMap.get(id) || id.slice(0, 8) : '—');

  const plans = plansQ.data?.data ?? [];
  const talks = talksQ.data?.data?.talks ?? [];
  const measures = talksQ.data?.data?.correctiveMeasures ?? [];
  const assessments = assessQ.data?.data ?? [];

  const planCols: Column<ViewRow>[] = [
    { key: 'emp', header: 'Zaposleni', render: (r) => sv(r, 'employee_name') || nm(sv(r, 'employee_id')) },
    { key: 'period', header: 'Period', render: (r) => sv(r, 'period_label') || '—' },
    { key: 'goal', header: 'Karijerni cilj', render: (r) => sv(r, 'career_goal_md').slice(0, 60) || '—' },
    { key: 'progress', header: 'Ciljeva', align: 'right', render: (r) => `${sv(r, 'goals_done') || 0}/${sv(r, 'goals_total') || 0}` },
    { key: 'status', header: 'Status', render: (r) => sv(r, 'status') || '—' },
  ];

  const talkCols: Column<EmployeeTalk>[] = [
    { key: 'date', header: 'Datum', render: (r) => (r.talkDate ? formatDate(r.talkDate) : '—') },
    { key: 'emp', header: 'Zaposleni', render: (r) => nm(r.employeeId) },
    { key: 'type', header: 'Tip', render: (r) => TALK_TYPE[r.talkType] || r.talkType },
    { key: 'title', header: 'Naslov', render: (r) => r.title || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const s = TALK_STATUS[r.status] ?? { tone: 'neutral' as Tone, label: r.status };
        return <StatusBadge tone={s.tone} label={s.label} />;
      },
    },
  ];

  const assessCols: Column<Assessment>[] = [
    { key: 'emp', header: 'Zaposleni', render: (r) => nm(r.employeeId) },
    { key: 'period', header: 'Period', render: (r) => r.periodLabel || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const s = ASSESS_STATUS[r.status] ?? { tone: 'neutral' as Tone, label: r.status };
        return <StatusBadge tone={s.tone} label={s.label} />;
      },
    },
    { key: 'vis', header: 'Vidljivo zaposlenom', render: (r) => (r.visibleToEmployee ? 'Da' : 'Ne') },
  ];

  return (
    <div className="space-y-6">
      <SummaryChips
        items={[
          { label: 'Planovi razvoja', value: plans.length },
          { label: 'Razgovori', value: talks.length },
          { label: 'Korektivne mere', value: measures.length },
          { label: '360° procene', value: assessments.length },
        ]}
      />

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Planovi razvoja</h3>
        <DataTable columns={planCols} rows={plans} rowKey={(r) => sv(r, 'id') || Math.random().toString()} loading={plansQ.isLoading} empty={<EmptyState title="Nema planova razvoja" />} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">Razgovori i korektivne mere</h3>
        <DataTable columns={talkCols} rows={talks} rowKey={(r) => r.id} loading={talksQ.isLoading} empty={<EmptyState title="Nema razgovora" />} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-ink">360° procene</h3>
        <DataTable columns={assessCols} rows={assessments} rowKey={(r) => r.id} loading={assessQ.isLoading} empty={<EmptyState title="Nema 360° procena" />} />
      </section>
    </div>
  );
}

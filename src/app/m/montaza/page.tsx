'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { useProjectsTree, useReports, MONTAZA_STATUS_LABELS } from '@/api/plan-montaze';
import { ReportDetail } from '../../montaza/_components/report-detail';
import { CHECK_SHORT, checks8, statusLabel } from '../../montaza/_components/phase-util';
import { cn } from '@/lib/cn';

type Tab = 'plan' | 'izvestaji';
const TABS: TabItem<Tab>[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'izvestaji', label: 'Izveštaji' },
];

/** Mobilni Plan montaže (/m/montaza) — Plan kartice + Izveštaji. Vidljivost = montaza.read. */
export default function MobileMontazaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('plan');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  return (
    <main className="min-h-screen bg-app p-3">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-md font-semibold text-ink">Plan montaže</h1>
        <Tabs tabs={TABS} value={tab} onChange={setTab} ariaLabel="Montaža" />
      </div>
      {tab === 'plan' ? <PlanCards /> : <ReportsMobile />}
    </main>
  );
}

function PlanCards() {
  const q = useProjectsTree();
  const projects = q.data?.data ?? [];
  if (q.isLoading) return <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>;
  if (projects.length === 0) return <p className="py-8 text-center text-sm text-ink-disabled">Nema projekata.</p>;
  return (
    <div className="space-y-3">
      {projects.map((p) => (
        <div key={p.id} className="rounded-panel border border-line bg-surface p-3">
          <div className="text-sm font-semibold text-ink">{p.project_code}</div>
          <div className="mb-2 text-xs text-ink-secondary">{p.project_name}</div>
          {p.workPackages.flatMap((w) => w.phases).length === 0 ? (
            <p className="text-xs text-ink-disabled">Nema faza.</p>
          ) : (
            <ul className="space-y-1.5">
              {p.workPackages.flatMap((w) => w.phases).map((ph) => {
                const c = checks8(ph);
                return (
                  <li key={ph.id} className="rounded-control border border-line-soft px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-ink">{ph.phaseName}</span>
                      <StatusBadge tone={ph.status === 2 ? 'success' : ph.status === 3 ? 'warn' : ph.status === 1 ? 'info' : 'neutral'} label={statusLabel(ph.status)} />
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      {CHECK_SHORT.map((s, i) => (
                        <span key={s} title={s} className={cn('h-2 w-2 rounded-full', c[i] ? 'bg-status-success' : 'bg-status-neutral/40')} />
                      ))}
                      <span className="ml-auto text-xs text-ink-disabled">
                        {formatDate(ph.startDate)}–{formatDate(ph.endDate)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function ReportsMobile() {
  const router = useRouter();
  const q = useReports();
  const rows = q.data?.data ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <button
        onClick={() => router.push('/m/izvestaj')}
        className="flex w-full items-center justify-center gap-2 rounded-control bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg"
      >
        <Plus className="h-4 w-4" /> Novi izveštaj
      </button>
      {q.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Nema izveštaja.</p>
      ) : (
        rows.map((r) => (
          <button
            key={r.id}
            onClick={() => setOpenId(r.id)}
            className="block w-full rounded-panel border border-line bg-surface p-3 text-left"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">{r.broj_izvestaja ?? 'Izveštaj'}</span>
              <StatusBadge tone="info" label={MONTAZA_STATUS_LABELS[r.status] ?? r.status} />
            </div>
            <div className="mt-0.5 text-xs text-ink-secondary">
              {formatDate(r.datum_rada)} · {r.predmet_broj ?? '—'} · {r.lokacija ?? ''}
            </div>
          </button>
        ))
      )}
      {openId && <ReportDetail id={openId} onClose={() => setOpenId(null)} canManage={false} />}
    </div>
  );
}

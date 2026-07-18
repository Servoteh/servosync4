'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  fetchOpenWoForTask,
  useBoard,
  useCreatePreventiveWo,
  useTasksDue,
  type MaintMe,
  type ViewRow,
} from '@/api/odrzavanje';
import {
  deadlineTone,
  f,
  fnum,
  PREV_SEVERITY_LABEL,
  prevSeverityTone,
  relDays,
  type DashNavTab,
} from './common';

type Bucket = 'all' | 'overdue' | 'today' | 'week';

const SEVERITIES: { id: string; label: string }[] = [
  { id: 'all', label: 'Sve ozbiljnosti' },
  { id: 'critical', label: 'Kritično' },
  { id: 'important', label: 'Važno' },
  { id: 'normal', label: 'Normalno' },
];

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfDayPlus(days: number): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  d.setDate(d.getDate() + days);
  return d.getTime();
}
function bucketOf(iso: string | null): Bucket | 'later' | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  if (t < startOfToday()) return 'overdue';
  if (t <= endOfDayPlus(0)) return 'today';
  if (t <= endOfDayPlus(7)) return 'week';
  if (t <= endOfDayPlus(30)) return 'later';
  return null; // dalje od 30 dana — van KPI opsega, ali ostaje u „Do 30 dana"=svi
}

/** Preventiva na redu — KPI kofice, filteri (ozbiljnost/kofica/pretraga), tabela + anti-duplikat WO. */
export function PreventivaTab({
  me,
  onNavigate,
}: {
  me: MaintMe | undefined;
  onNavigate?: (tab: DashNavTab) => void;
}) {
  const router = useRouter();
  const due = useTasksDue();
  const board = useBoard();
  const createWo = useCreatePreventiveWo();
  const canCreate = me?.gates.canCreateWo ?? false;

  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState('all');
  const [bucket, setBucket] = useState<Bucket>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  // Ime mašine + PAUZA (override) iz /board (machineNames = sve mašine; overrides = pod ručnim statusom).
  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of board.data?.data.machineNames ?? []) m.set(n.machineCode, n.name);
    return m;
  }, [board.data]);
  const overrideByCode = useMemo(() => {
    const m = new Map<string, { status: string; reason: string | null }>();
    for (const o of board.data?.data.overrides ?? []) m.set(o.machineCode, { status: o.status, reason: o.reason });
    return m;
  }, [board.data]);

  const rows = due.data?.data ?? [];

  const buckets = useMemo(() => {
    const c = { overdue: 0, today: 0, week: 0, later: 0 };
    for (const r of rows) {
      const b = bucketOf(f(r, 'next_due_at', 'due_at'));
      if (b === 'overdue') c.overdue += 1;
      else if (b === 'today') c.today += 1;
      else if (b === 'week') c.week += 1;
      else if (b === 'later') c.later += 1;
    }
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      const sev = f(r, 'severity') ?? 'normal';
      if (severity !== 'all' && sev !== severity) return false;
      if (bucket !== 'all') {
        const b = bucketOf(f(r, 'next_due_at', 'due_at'));
        if (b !== bucket) return false;
      }
      if (!needle) return true;
      const code = f(r, 'machine_code') ?? '';
      const name = nameByCode.get(code) ?? code;
      const title = f(r, 'title', 'task_title') ?? '';
      return `${code} ${name} ${title}`.toLowerCase().includes(needle);
    });
  }, [rows, q, severity, bucket, nameByCode]);

  function openMachine(code: string) {
    router.push(`/odrzavanje/masine?code=${encodeURIComponent(code)}&tab=zadaci`);
  }

  async function createFor(r: ViewRow) {
    const taskId = f(r, 'task_id', 'id');
    if (!taskId) return;
    setBusyId(taskId);
    // Anti-duplikat (paritet 1.0 maintPreventivePanel.js:261-274): BE due-red NE nosi
    // has_open_wo, pa zasebnim upitom (fetchOpenWoForTask) proverimo postoji li već otvoren
    // nalog za ovaj zadatak; ako da — pitaj korisnika (kao 1.0 fetchOpenWoForPreventiveTask).
    let existing: Awaited<ReturnType<typeof fetchOpenWoForTask>> = null;
    try {
      existing = await fetchOpenWoForTask(taskId);
    } catch {
      // Pre-provera nije kritična — DB RPC svejedno dedupe-uje; nastavi na kreiranje.
    }
    if (existing) {
      const makeNew = window.confirm(
        `Za ovaj zadatak već postoji otvoren radni nalog ${existing.woNumber ?? ''}.\n\n` +
          'OK = ipak napravi NOVI nalog\nOtkaži = otvori postojeće naloge',
      );
      if (!makeNew) {
        setBusyId(null);
        onNavigate?.('nalozi');
        return;
      }
    }
    createWo.mutate(
      { id: taskId },
      {
        onSuccess: () => {
          toast('Radni nalog je kreiran');
          onNavigate?.('nalozi');
        },
        onError: (e) => toast((e as Error).message || 'Kreiranje naloga nije uspelo'),
        onSettled: () => setBusyId(null),
      },
    );
  }

  const kpis: { key: Bucket; label: string; value: number; tone: 'danger' | 'warn' | 'info' | 'neutral' }[] = [
    { key: 'overdue', label: 'Kasni rokovi', value: buckets.overdue, tone: 'danger' },
    { key: 'today', label: 'Danas', value: buckets.today, tone: 'warn' },
    { key: 'week', label: 'Narednih 7 dana', value: buckets.week, tone: 'info' },
    { key: 'all', label: 'Do 30 dana', value: buckets.later, tone: 'neutral' },
  ];

  return (
    <div className="space-y-4">
      {/* KPI kofice (klik = filter) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {kpis.map((k) => {
          const active = bucket === k.key && (k.key !== 'all' || bucket === 'all');
          const ring: Record<string, string> = {
            danger: 'text-status-danger', warn: 'text-status-warn', info: 'text-status-info', neutral: 'text-ink',
          };
          return (
            <button
              key={k.label}
              type="button"
              onClick={() => setBucket(k.key)}
              aria-pressed={active}
              className={cn(
                'rounded-panel border bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-surface-2',
                active ? 'border-accent' : 'border-line',
              )}
            >
              <div className={cn('tnums text-2xl font-semibold', k.value ? ring[k.tone] : 'text-ink-disabled')}>{k.value}</div>
              <div className="mt-1 text-2xs uppercase tracking-wider text-ink-secondary">{k.label}</div>
            </button>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Pretraga mašine ili kontrole…"
          className="h-9 min-w-52 flex-1 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        />
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          {SEVERITIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <select value={bucket} onChange={(e) => setBucket(e.target.value as Bucket)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          <option value="all">Svi rokovi</option>
          <option value="overdue">Kasni</option>
          <option value="today">Danas</option>
          <option value="week">Narednih 7 dana</option>
        </select>
        <span className="tnums text-xs text-ink-secondary">{filtered.length} od {rows.length}</span>
      </div>

      {due.isError ? (
        <EmptyState title="Greška pri učitavanju" hint="Preventiva trenutno nije dostupna." />
      ) : due.isLoading ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Nema preventive na redu" hint="Sve kontrole su u roku." />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="h-9 px-4">Mašina</th>
                <th className="px-4">Zadatak</th>
                <th className="px-4">Ozbiljnost</th>
                <th className="px-4">Interval</th>
                <th className="px-4">Poslednje</th>
                <th className="px-4">Rok</th>
                <th className="px-4"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-ink-secondary">Nema stavki za izabrane filtere.</td></tr>
              ) : filtered.map((r, i) => {
                const taskId = f(r, 'task_id', 'id');
                const code = f(r, 'machine_code') ?? '';
                const name = nameByCode.get(code) ?? code;
                const nextDue = f(r, 'next_due_at', 'due_at', 'next_due', 'due_date');
                const sev = f(r, 'severity') ?? 'normal';
                const iv = fnum(r, 'interval_value');
                const unit = f(r, 'interval_unit') ?? '';
                const grace = fnum(r, 'grace_period_days');
                const last = f(r, 'last_performed_at', 'last_done_at');
                const ovr = overrideByCode.get(code);
                return (
                  <tr key={taskId ?? i} className={cn('border-b border-line-soft', ovr && 'opacity-70')}>
                    <td className="px-4 py-2">
                      <button type="button" onClick={() => openMachine(code)} className="text-left font-medium text-accent hover:underline">{name}</button>
                      <div className="flex items-center gap-1.5">
                        <span className="tnums text-2xs text-ink-secondary">{code}</span>
                        {ovr && (
                          <span title={ovr.reason ?? ''} className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs font-medium text-ink-secondary">PAUZA</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-ink">{f(r, 'title', 'task_title') ?? '—'}</td>
                    <td className="px-4 py-2"><StatusBadge tone={prevSeverityTone(sev)} label={PREV_SEVERITY_LABEL[sev] ?? sev} /></td>
                    <td className="px-4 py-2 text-2xs text-ink-secondary">
                      {iv != null ? `${iv} ${unit}` : '—'}
                      {grace != null && grace > 0 && <div>grace {grace} d</div>}
                    </td>
                    <td className="px-4 py-2 text-2xs text-ink-secondary">{last ? formatDateTime(last) : '—'}</td>
                    <td className="px-4 py-2">
                      {nextDue ? (
                        <>
                          <StatusBadge tone={deadlineTone(nextDue)} label={formatDateTime(nextDue)} />
                          <div className="mt-0.5 text-2xs text-ink-secondary">{relDays(nextDue)}</div>
                        </>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {canCreate && taskId && (
                        <Button variant="secondary" disabled={busyId === taskId} onClick={() => void createFor(r)}>
                          Kreiraj nalog
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Download, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  PB_STATUSI,
  PB_VRSTE,
  PB_PRIORITETI,
  useTasks,
  useLoadStats,
  useTeamLoadStats,
  useEngineers,
  useBulkUpdateTasks,
  useBulkSoftDeleteTasks,
  type PbTask,
  type PbLoadStat,
} from '@/api/projektni-biro';
import { TaskStatusBadge, PrioBadge, shortDate, workDaysBetween, ProgressBar } from './shared';

export interface PlanFilters {
  projectId?: string;
  employeeId?: string;
  q?: string;
}

/** Broj (load_pct) iz raznih mogućih naziva kolone RPC-a. */
function loadPct(r: PbLoadStat): number {
  const v = (r.load_pct ?? r.loadPct ?? r.avg_load_pct ?? r.avgLoadPct ?? 0) as number;
  return Number(v) || 0;
}
function loadBarTone(pct: number): string {
  if (pct > 100) return 'bg-status-danger';
  if (pct >= 80) return 'bg-status-warn';
  return 'bg-status-success';
}

export function PlanTab({ filters, onOpenTask }: { filters: PlanFilters; onOpenTask: (id: string | null, status?: string) => void }) {
  const { can } = useAuth();
  const canEdit = can(PERMISSIONS.PB_EDIT);

  const [status, setStatus] = useState('');
  const [prioritet, setPrioritet] = useState('');
  const [vrsta, setVrsta] = useState('');
  const [problemOnly, setProblemOnly] = useState(false);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [alarmsOpen, setAlarmsOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const tasksQ = useTasks({ ...filters, status: status || undefined, vrsta: vrsta || undefined, pageSize: 500 });
  const loadQ = useLoadStats(20);
  const teamQ = useTeamLoadStats(20);
  const engineersQ = useEngineers();
  const bulkM = useBulkUpdateTasks();
  const bulkDelM = useBulkSoftDeleteTasks();

  const all = tasksQ.data?.data ?? [];
  const rows = useMemo(() => {
    return all.filter((t) => {
      if (prioritet && t.prioritet !== prioritet) return false;
      if (problemOnly && !t.problem) return false;
      if (unassignedOnly && t.employee_id) return false;
      if (!showDone && t.status === 'Završeno') return false;
      return true;
    });
  }, [all, prioritet, problemOnly, unassignedOnly, showDone]);

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; rows: PbTask[] }>();
    for (const t of rows) {
      const key = t.project_id ?? '—';
      const label = [t.project_code, t.project_name].filter(Boolean).join(' ') || 'Bez projekta';
      if (!map.has(key)) map.set(key, { label, rows: [] });
      map.get(key)!.rows.push(t);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'sr'));
  }, [rows]);
  const multiProject = grouped.length > 1;

  const alarms = useMemo(() => buildAlarms(all, loadQ.data?.data ?? []), [all, loadQ.data]);
  const anyFilter = !!(status || prioritet || vrsta || problemOnly || unassignedOnly || showDone);

  function toggleSel(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    setSelected((s) => (s.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));
  }
  async function bulk(patch: { status?: string; prioritet?: string; employeeId?: string }) {
    if (!selected.size) return;
    await bulkM.mutateAsync({ ids: [...selected], ...patch });
    setSelected(new Set());
  }
  async function bulkDelete() {
    if (!selected.size) return;
    if (!confirm(`Obrisati ${selected.size} zadataka?`)) return;
    await bulkDelM.mutateAsync({ ids: [...selected] });
    setSelected(new Set());
  }

  function exportCsv() {
    const header = [
      '#',
      'Naziv',
      'Projekat (šifra)',
      'Projekat (naziv)',
      'Inženjer',
      'Vrsta',
      'Prioritet',
      'Status',
      'Plan početak',
      'Plan rok',
      'Ostvaren početak',
      'Ostvaren završetak',
      'Trajanje (rd)',
      'Norma (h/dan)',
      'Završenost %',
      'Problem',
    ];
    const lines = rows.map((t, i) =>
      [
        i + 1,
        t.naziv,
        t.project_code ?? '',
        t.project_name ?? '',
        t.employee_name ?? '',
        t.vrsta ?? '',
        t.prioritet ?? '',
        t.status,
        t.datum_pocetka_plan ?? '',
        t.datum_zavrsetka_plan ?? '',
        t.datum_pocetka_real ?? '',
        t.datum_zavrsetka_real ?? '',
        workDaysBetween(t.datum_pocetka_plan, t.datum_zavrsetka_plan) ?? '',
        t.norma_sati_dan ?? '',
        t.procenat_zavrsenosti ?? '',
        (t.problem ?? '').replace(/\n/g, ' '),
      ]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(','),
    );
    const csv = '﻿' + [header.join(','), ...lines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pb-plan-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const selCls = 'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink';

  return (
    <div className="space-y-4">
      {/* Filter traka */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={selCls} aria-label="Status">
          <option value="">Svi statusi</option>
          {PB_STATUSI.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={prioritet} onChange={(e) => setPrioritet(e.target.value)} className={selCls} aria-label="Prioritet">
          <option value="">Svi prioriteti</option>
          {PB_PRIORITETI.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={vrsta} onChange={(e) => setVrsta(e.target.value)} className={selCls} aria-label="Vrsta">
          <option value="">Sve vrste</option>
          {PB_VRSTE.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <ToggleBtn active={problemOnly} onClick={() => setProblemOnly((v) => !v)}>
          ⚠ Problemi
        </ToggleBtn>
        <ToggleBtn active={unassignedOnly} onClick={() => setUnassignedOnly((v) => !v)}>
          ⊘ Nedodeljen
        </ToggleBtn>
        <ToggleBtn active={showDone} onClick={() => setShowDone((v) => !v)}>
          ☐ Završeni
        </ToggleBtn>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={exportCsv} className="h-9 px-2 text-xs">
            <Download className="h-4 w-4" aria-hidden /> CSV
          </Button>
          {anyFilter && (
            <Button
              variant="ghost"
              onClick={() => {
                setStatus('');
                setPrioritet('');
                setVrsta('');
                setProblemOnly(false);
                setUnassignedOnly(false);
                setShowDone(false);
              }}
              className="h-9 px-2 text-xs"
            >
              ✕ Reset
            </Button>
          )}
          {canEdit && <Button onClick={() => onOpenTask(null)}>＋ Novi zadatak</Button>}
        </div>
      </div>

      {/* Alarmi */}
      <Collapsible
        open={alarmsOpen}
        onToggle={() => setAlarmsOpen((o) => !o)}
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-status-warn" aria-hidden />
            {alarms.length ? `${alarms.length} alarma` : 'Nema alarma'}
            {alarms.some((a) => a.tone === 'danger') && (
              <span className="rounded-full bg-status-danger-bg px-2 py-0.5 text-2xs text-status-danger">
                {alarms.filter((a) => a.tone === 'danger').length} kritično
              </span>
            )}
          </span>
        }
      >
        <ul className="space-y-1">
          {alarms.map((a, i) => (
            <li key={i} className={cn('text-sm', a.tone === 'danger' ? 'text-status-danger' : 'text-status-warn')}>
              • {a.text}
            </li>
          ))}
          {alarms.length === 0 && <li className="text-sm text-ink-secondary">Sve pod kontrolom.</li>}
        </ul>
      </Collapsible>

      {/* Opterećenost */}
      <Collapsible open={loadOpen} onToggle={() => setLoadOpen((o) => !o)} title="Opterećenost narednih 20 radnih dana">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">Po inženjeru</h4>
            {(loadQ.data?.data ?? []).map((r, i) => {
              const pct = loadPct(r);
              const name = (r.full_name ?? r.employee_name ?? '—') as string;
              return (
                <LoadRow key={i} label={name} pct={pct} />
              );
            })}
            {(loadQ.data?.data ?? []).length === 0 && <p className="text-xs text-ink-disabled">Nema podataka.</p>}
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">Po timu</h4>
            {(teamQ.data?.data ?? []).map((r, i) => {
              const pct = loadPct(r);
              const label = `${(r.sub_department_name ?? r.team ?? '—') as string}${r.member_count ? ` (${r.member_count})` : ''}`;
              return <LoadRow key={i} label={label} pct={pct} />;
            })}
            {(teamQ.data?.data ?? []).length === 0 && <p className="text-xs text-ink-disabled">Nema podataka.</p>}
          </div>
        </div>
      </Collapsible>

      {/* Bulk traka */}
      {canEdit && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-panel border border-accent/40 bg-accent-subtle px-3 py-2">
          <span className="text-sm font-medium text-ink">{selected.size} selektovano</span>
          <select className={selCls} defaultValue="" onChange={(e) => e.target.value && bulk({ status: e.target.value })} aria-label="Bulk status">
            <option value="">Status ▾</option>
            {PB_STATUSI.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className={selCls} defaultValue="" onChange={(e) => e.target.value && bulk({ prioritet: e.target.value })} aria-label="Bulk prioritet">
            <option value="">Prioritet ▾</option>
            {PB_PRIORITETI.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className={selCls} defaultValue="" onChange={(e) => e.target.value && bulk({ employeeId: e.target.value })} aria-label="Bulk inženjer">
            <option value="">Inženjer ▾</option>
            {(engineersQ.data?.data ?? []).map((en) => (
              <option key={en.id} value={en.id}>
                {en.full_name}
              </option>
            ))}
          </select>
          <Button variant="danger" onClick={bulkDelete} className="h-9">
            ✕ Briši
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())} className="h-9">
            Otkaži
          </Button>
        </div>
      )}

      {/* Tabela */}
      {tasksQ.isLoading ? (
        <p className="py-10 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Nema zadataka za prikaz" hint="Promeni filtere ili dodaj novi zadatak." />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wide text-ink-secondary">
                {canEdit && (
                  <th className="w-8 px-3 py-2">
                    <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} aria-label="Selektuj sve" />
                  </th>
                )}
                <th className="px-3 py-2">Naziv</th>
                {!multiProject && <th className="px-3 py-2">Projekat</th>}
                <th className="px-3 py-2">Inženjer</th>
                <th className="px-3 py-2">Vrsta</th>
                <th className="px-3 py-2">Datumi</th>
                <th className="px-3 py-2 text-right">Trajanje</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">%</th>
                <th className="px-3 py-2">Prioritet</th>
                <th className="w-20 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => (
                <GroupBlock
                  key={g.label}
                  group={g}
                  multiProject={multiProject}
                  canEdit={canEdit}
                  selected={selected}
                  onToggleSel={toggleSel}
                  onOpen={(id) => onOpenTask(id)}
                  onDelete={(id) => bulkDelM.mutate({ ids: [id] })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GroupBlock({
  group,
  multiProject,
  canEdit,
  selected,
  onToggleSel,
  onOpen,
  onDelete,
}: {
  group: { label: string; rows: PbTask[] };
  multiProject: boolean;
  canEdit: boolean;
  selected: Set<string>;
  onToggleSel: (id: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const colspan = 11;
  return (
    <>
      {multiProject && (
        <tr className="bg-surface-2/60">
          <td colSpan={colspan} className="px-3 py-1.5 text-xs font-semibold text-ink">
            {group.label} · {group.rows.length} {group.rows.length === 1 ? 'zadatak' : 'zadataka'}
          </td>
        </tr>
      )}
      {group.rows.map((t) => {
        const done = t.status === 'Završeno';
        return (
          <tr key={t.id} className={cn('border-b border-line-soft hover:bg-surface-2', done && 'opacity-60')}>
            {canEdit && (
              <td className="px-3 py-2">
                <input type="checkbox" checked={selected.has(t.id)} onChange={() => onToggleSel(t.id)} aria-label="Selektuj" />
              </td>
            )}
            <td className="px-3 py-2">
              <button onClick={() => onOpen(t.id)} className={cn('text-left font-medium text-ink hover:underline', done && 'line-through')}>
                {t.naziv}
              </button>
              {t.problem && <span title="Ima problem" className="ml-1 text-status-warn">⚠</span>}
            </td>
            {!multiProject && <td className="px-3 py-2 text-ink-secondary">{[t.project_code, t.project_name].filter(Boolean).join(' ') || '—'}</td>}
            <td className="px-3 py-2 text-ink-secondary">{t.employee_name ?? '—'}</td>
            <td className="px-3 py-2 text-ink-secondary">{t.vrsta ?? '—'}</td>
            <td className="px-3 py-2 text-xs text-ink-secondary">
              <div>
                {shortDate(t.datum_pocetka_plan)} → {shortDate(t.datum_zavrsetka_plan)}
              </div>
              {(t.datum_pocetka_real || t.datum_zavrsetka_real) && (
                <div className="text-ink-disabled">
                  ostv. {shortDate(t.datum_pocetka_real)} → {shortDate(t.datum_zavrsetka_real)}
                </div>
              )}
            </td>
            <td className="px-3 py-2 text-right tnums text-ink-secondary">
              {workDaysBetween(t.datum_pocetka_plan, t.datum_zavrsetka_plan) ?? '—'}
            </td>
            <td className="px-3 py-2">
              <TaskStatusBadge status={t.status} />
            </td>
            <td className="px-3 py-2">
              <ProgressBar value={t.procenat_zavrsenosti} />
            </td>
            <td className="px-3 py-2">
              <PrioBadge prio={t.prioritet} />
            </td>
            <td className="px-3 py-2">
              <div className="flex justify-end gap-1">
                <button onClick={() => onOpen(t.id)} className="rounded p-1 text-ink-secondary hover:bg-surface-2" aria-label="Izmeni">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {canEdit && (
                  <button
                    onClick={() => confirm('Obrisati zadatak?') && onDelete(t.id)}
                    className="rounded p-1 text-ink-secondary hover:bg-surface-2 hover:text-status-danger"
                    aria-label="Briši"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'h-9 rounded-control border px-2.5 text-sm',
        active ? 'border-accent bg-accent-subtle text-ink' : 'border-line bg-surface text-ink-secondary hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  );
}

function Collapsible({ open, onToggle, title, children }: { open: boolean; onToggle: () => void; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-panel border border-line bg-surface">
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-ink">
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        {title}
      </button>
      {open && <div className="border-t border-line px-4 py-3">{children}</div>}
    </div>
  );
}

function LoadRow({ label, pct }: { label: string; pct: number }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="w-40 shrink-0 truncate text-sm text-ink">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className={cn('h-full rounded-full', loadBarTone(pct))} style={{ width: `${Math.min(150, pct)}%` }} />
      </div>
      <span className="tnums w-12 text-right text-xs text-ink-secondary">{Math.round(pct)}%</span>
    </div>
  );
}

// -------------------------------------------------- alarmi (klijentski, paritet 1.0 buildAlarms)

interface Alarm {
  tone: 'danger' | 'warn';
  text: string;
}
function buildAlarms(tasks: PbTask[], load: PbLoadStat[]): Alarm[] {
  const out: Alarm[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayDiff = (iso: string) => Math.round((new Date(iso).getTime() - today.getTime()) / 86400000);
  for (const t of tasks) {
    if (t.deleted_at || t.status === 'Završeno') continue;
    if (t.datum_zavrsetka_plan) {
      const d = dayDiff(t.datum_zavrsetka_plan);
      if (d < 0) out.push({ tone: 'danger', text: `„${t.naziv}" — rok prošao` });
      else if (d <= 3) out.push({ tone: 'warn', text: `„${t.naziv}" — rok za ≤${d}d` });
    }
    if (!t.employee_id) {
      if (t.datum_pocetka_plan && dayDiff(t.datum_pocetka_plan) < 0) out.push({ tone: 'danger', text: `„${t.naziv}" — počelo bez inženjera` });
      else if (t.datum_pocetka_plan && dayDiff(t.datum_pocetka_plan) <= 3) out.push({ tone: 'warn', text: `„${t.naziv}" — nema inženjera (uskoro početak)` });
    }
  }
  for (const r of load) {
    const pct = loadPct(r);
    if (pct > 100) out.push({ tone: 'danger', text: `Prekoračenje kapaciteta (${Math.round(pct)}%): ${(r.full_name ?? r.employee_name ?? '—') as string}` });
  }
  return out;
}

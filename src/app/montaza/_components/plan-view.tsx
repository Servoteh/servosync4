'use client';

import { useMemo, useState } from 'react';
import { Plus, Pencil, Building2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { type PmProjectTree, type PmWorkPackage, type PmPhase } from '@/api/plan-montaze';
import {
  CHECK_SHORT,
  calcReadiness,
  calcRisk,
  checks8,
  statusLabel,
  type RiskLevel,
} from './phase-util';
import { PhaseModal } from './phase-modal';
import { ProjectModal, WorkPackageModal } from './meta-modal';

const STATUS_TONE: Record<number, Tone> = { 0: 'neutral', 1: 'info', 2: 'success', 3: 'warn' };
const RISK_TONE: Record<RiskLevel, Tone> = { none: 'success', low: 'neutral', med: 'warn', high: 'danger' };
const RISK_LABEL: Record<RiskLevel, string> = { none: 'OK', low: 'Nizak', med: 'Srednji', high: 'Visok' };

export function PlanView({
  projects,
  canEdit,
  selectedId,
  onSelect,
}: {
  projects: PmProjectTree[];
  canEdit: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [locFilter, setLocFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [hideDone, setHideDone] = useState(false);
  const [riskOnly, setRiskOnly] = useState(false);

  const [phaseEdit, setPhaseEdit] = useState<{ wp: PmWorkPackage; phase: PmPhase | null } | null>(null);
  const [projEdit, setProjEdit] = useState<{ open: boolean }>({ open: false });
  const [wpEdit, setWpEdit] = useState<PmWorkPackage | null | 'new'>(null);

  const selected = projects.find((p) => p.id === selectedId) ?? projects[0] ?? null;

  const locations = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) for (const w of p.workPackages) for (const ph of w.phases) if (ph.location) set.add(ph.location);
    return [...set].sort();
  }, [projects]);

  function phasePass(ph: PmPhase): boolean {
    const term = q.trim().toLowerCase();
    if (term && !`${ph.phaseName} ${ph.montageLead ?? ''} ${ph.responsibleEngineer ?? ''} ${ph.blocker ?? ''}`.toLowerCase().includes(term)) return false;
    if (locFilter && ph.location !== locFilter) return false;
    if (statusFilter !== '' && String(ph.status ?? 0) !== statusFilter) return false;
    if (hideDone && ph.status === 2) return false;
    if (riskOnly && calcRisk(ph).level === 'none') return false;
    return true;
  }

  return (
    <div className="space-y-4">
      {/* Filter traka */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Pretraga faza…" />
        <select
          value={locFilter}
          onChange={(e) => setLocFilter(e.target.value)}
          className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="">Sve lokacije</option>
          {locations.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="">Svi statusi</option>
          {[0, 1, 2, 3].map((s) => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Sakrij završene
        </label>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={riskOnly} onChange={(e) => setRiskOnly(e.target.checked)} /> Samo rizične
        </label>
        {canEdit && (
          <Button variant="secondary" onClick={() => setProjEdit({ open: true })} className="ml-auto">
            <Plus className="h-4 w-4" /> Projekat
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
        {/* Lista projekata */}
        <div className="space-y-1 rounded-panel border border-line bg-surface p-1.5">
          {projects.length === 0 ? (
            <EmptyState title="Nema aktivnih projekata" />
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                onClick={() => onSelect(p.id)}
                className={cn(
                  'flex w-full flex-col items-start rounded-control px-3 py-2 text-left text-sm',
                  selected?.id === p.id ? 'bg-accent-subtle text-ink' : 'text-ink-secondary hover:bg-surface-2',
                )}
              >
                <span className="font-medium text-ink">{p.project_code}</span>
                <span className="truncate text-xs text-ink-secondary">{p.project_name}</span>
              </button>
            ))
          )}
        </div>

        {/* Detalj projekta */}
        {selected ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <h2 className="text-md font-semibold text-ink">
                {selected.project_code} — {selected.project_name}
              </h2>
              {selected.project_deadline && (
                <span className="text-xs text-ink-secondary">rok {formatDate(selected.project_deadline)}</span>
              )}
              {canEdit && (
                <div className="ml-auto flex gap-2">
                  <Button variant="ghost" onClick={() => setProjEdit({ open: true })}>
                    <Pencil className="h-4 w-4" /> Meta
                  </Button>
                  <Button variant="secondary" onClick={() => setWpEdit('new')}>
                    <Plus className="h-4 w-4" /> Nalog
                  </Button>
                </div>
              )}
            </div>

            {selected.workPackages.length === 0 ? (
              <EmptyState title="Projekat nema naloge montaže" />
            ) : (
              selected.workPackages.map((wp) => {
                const phases = wp.phases.filter(phasePass);
                return (
                  <div key={wp.id} className="rounded-panel border border-line bg-surface">
                    <div className="flex items-center gap-2 border-b border-line px-4 py-2">
                      <Building2 className="h-4 w-4 text-ink-secondary" aria-hidden />
                      <span className="text-sm font-medium text-ink">
                        {wp.rnCode ? `${wp.rnCode} · ` : ''}{wp.name}
                      </span>
                      <span className="text-xs text-ink-secondary">{wp.location}</span>
                      {wp.assemblyDrawingNo && (
                        <span className="text-xs text-ink-disabled">sklop {wp.assemblyDrawingNo}</span>
                      )}
                      {canEdit && (
                        <div className="ml-auto flex gap-1">
                          <Button variant="ghost" onClick={() => setWpEdit(wp)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" onClick={() => setPhaseEdit({ wp, phase: null })}>
                            <Plus className="h-3.5 w-3.5" /> Faza
                          </Button>
                        </div>
                      )}
                    </div>
                    {phases.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-ink-disabled">Nema faza (za dati filter).</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                              <th className="px-3 py-1.5">Faza</th>
                              <th className="px-3 py-1.5">Status</th>
                              <th className="px-3 py-1.5">%</th>
                              <th className="px-3 py-1.5">Vođa</th>
                              <th className="px-3 py-1.5">Termin</th>
                              <th className="px-3 py-1.5">Spremnost</th>
                              <th className="px-3 py-1.5">Rizik</th>
                              <th className="px-3 py-1.5" />
                            </tr>
                          </thead>
                          <tbody>
                            {phases.map((ph) => {
                              const rd = calcReadiness(ph);
                              const rk = calcRisk(ph);
                              const c = checks8(ph);
                              return (
                                <tr key={ph.id} className="border-b border-line-soft hover:bg-surface-2">
                                  <td className="px-3 py-1.5">
                                    <div className="font-medium text-ink">{ph.phaseName}</div>
                                    <div className="text-xs text-ink-disabled">
                                      {ph.phaseType === 'electrical' ? 'Električna' : 'Mašinska'} · {ph.location}
                                    </div>
                                  </td>
                                  <td className="px-3 py-1.5">
                                    <StatusBadge tone={STATUS_TONE[ph.status ?? 0]} label={statusLabel(ph.status)} />
                                  </td>
                                  <td className="tnums px-3 py-1.5">{ph.pct ?? 0}%</td>
                                  <td className="px-3 py-1.5">{ph.montageLead || '—'}</td>
                                  <td className="tnums px-3 py-1.5 text-xs">
                                    {formatDate(ph.startDate)} – {formatDate(ph.endDate)}
                                  </td>
                                  <td className="px-3 py-1.5">
                                    <div className="flex gap-0.5" title={rd.reasons.join(', ')}>
                                      {CHECK_SHORT.map((s, i) => (
                                        <span
                                          key={s}
                                          title={s}
                                          className={cn(
                                            'h-2 w-2 rounded-full',
                                            c[i] ? 'bg-status-success' : 'bg-status-neutral/40',
                                          )}
                                        />
                                      ))}
                                    </div>
                                  </td>
                                  <td className="px-3 py-1.5">
                                    {rk.level === 'none' ? (
                                      <span className="text-xs text-ink-disabled">—</span>
                                    ) : (
                                      <span title={rk.reasons.join('\n')}>
                                        <StatusBadge tone={RISK_TONE[rk.level]} label={RISK_LABEL[rk.level]} />
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5 text-right">
                                    <button
                                      onClick={() => setPhaseEdit({ wp, phase: ph })}
                                      className="rounded-control p-1 text-ink-secondary hover:bg-surface-2"
                                      aria-label="Izmena faze"
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
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
              })
            )}
          </div>
        ) : (
          <EmptyState title="Izaberi projekat" hint={<AlertTriangle className="mx-auto h-5 w-5" />} />
        )}
      </div>

      {phaseEdit && (
        <PhaseModal
          open
          onClose={() => setPhaseEdit(null)}
          phase={phaseEdit.phase}
          projectId={phaseEdit.wp.projectId}
          workPackageId={phaseEdit.wp.id}
          canEdit={canEdit}
        />
      )}
      <ProjectModal open={projEdit.open} onClose={() => setProjEdit({ open: false })} project={selected} canEdit={canEdit} />
      {wpEdit !== null && selected && (
        <WorkPackageModal
          open
          onClose={() => setWpEdit(null)}
          projectId={selected.id}
          wp={wpEdit === 'new' ? null : wpEdit}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}

'use client';

import { useMemo } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate } from '@/lib/format';
import { grossToNet } from '@/lib/salary-tax';
import { useSalaryTerms, useDeleteSalaryTerm, type SalaryTerm } from '@/api/kadrovska';
import { fmtMoney, fmtRsd2, salaryTypeLabel } from './calc';

/** Uporediva NETO osnova reda: snapshot → mesečni RSD iznos → izvedeno iz bruto. */
function termNetoBasis(t: SalaryTerm): number | null {
  if (Number(t.netoRsd) > 0) return Number(t.netoRsd);
  if ((t.currency || 'RSD') === 'RSD' && t.salaryType !== 'satnica' && Number(t.amount) > 0) {
    if (t.amountType === 'neto') return Number(t.amount);
    if (t.amountType === 'bruto') return grossToNet(Number(t.amount)).neto;
  }
  return null;
}
function growthBasis(t: SalaryTerm): { v: number; kind: string } | null {
  const neto = termNetoBasis(t);
  if (neto != null) return { v: neto, kind: 'neto' };
  if (t.salaryType === 'satnica' && Number(t.amount) > 0) return { v: Number(t.amount), kind: 'satnica:' + (t.currency || 'RSD') };
  return null;
}

/** SVG grafikon rasta (NETO osnova kroz vreme). */
function Sparkline({ list }: { list: SalaryTerm[] }) {
  const pts = list
    .slice()
    .reverse()
    .map((t) => ({ d: t.effectiveFrom, v: termNetoBasis(t) }))
    .filter((p): p is { d: string; v: number } => !!p.d && (p.v ?? 0) > 0);
  if (pts.length < 2) return null;
  const w = 520, h = 64, pad = 8;
  const vals = pts.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => pad + (w - 2 * pad) * (i / (pts.length - 1));
  const y = (v: number) => h - pad - (h - 2 * pad) * ((v - min) / span);
  const poly = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return (
    <div>
      <div className="mb-1 text-xs text-ink-secondary">📈 Rast zarade (NETO osnova):</div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" role="img" aria-label="Grafikon rasta zarade">
        <polyline points={poly} fill="none" stroke="var(--accent)" strokeWidth={2} />
        {pts.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.v)} r={2.5} fill="var(--accent)">
            <title>{`${formatDate(p.d)}: ${fmtRsd2(p.v)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="mt-0.5 flex justify-between text-xs text-ink-secondary tnums">
        <span>{formatDate(pts[0].d)} · {fmtRsd2(pts[0].v)}</span>
        <span>{formatDate(pts[pts.length - 1].d)} · {fmtRsd2(pts[pts.length - 1].v)}</span>
      </div>
    </div>
  );
}

function GrowthCell({ list, i }: { list: SalaryTerm[]; i: number }) {
  const cur = growthBasis(list[i]);
  const prev = i + 1 < list.length ? growthBasis(list[i + 1]) : null;
  if (!cur || !prev || cur.kind !== prev.kind || !(prev.v > 0)) return <span className="text-ink-secondary">—</span>;
  const pct = (cur.v / prev.v - 1) * 100;
  if (Math.abs(pct) < 0.005) return <span className="text-ink-secondary">0%</span>;
  const txt = (pct > 0 ? '+' : '−') + Math.abs(pct).toLocaleString('sr-RS', { maximumFractionDigits: 1 }) + '%';
  return <span className={pct > 0 ? 'font-semibold text-status-success' : 'font-semibold text-status-danger'}>{txt}</span>;
}

export function HistoryModal({
  open,
  onClose,
  employeeId,
  employeeName,
  onEditTerm,
  onNewChange,
  onNewBlank,
}: {
  open: boolean;
  onClose: () => void;
  employeeId: string;
  employeeName: string;
  onEditTerm: (t: SalaryTerm) => void;
  onNewChange: (t: SalaryTerm) => void;
  onNewBlank: () => void;
}) {
  const q = useSalaryTerms({ employeeId }, open && !!employeeId);
  const del = useDeleteSalaryTerm();
  const list = useMemo(() => (q.data?.data ?? []).slice(), [q.data]);

  const todayIso = new Date().toISOString().slice(0, 10);
  const activeTerm = list.find((t) => !t.effectiveTo || t.effectiveTo >= todayIso) || null;

  async function onDelete(id: string) {
    if (!window.confirm('Obrisati ovaj unos zarade? Akcija je trajna.')) return;
    await del.mutateAsync({ id });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl2"
      title={`📜 Istorija zarada — ${employeeName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Zatvori</Button>
          <Button variant="secondary" onClick={onNewBlank}>+ Novi unos (prazan)</Button>
          {activeTerm && <Button onClick={() => onNewChange(activeTerm)}>✏️ Nova izmena zarade</Button>}
        </>
      }
    >
      <p className="mb-3 text-xs text-ink-secondary">
        Poslednji aktivan red je trenutno važeći. <strong>Nova izmena</strong> pravi novi red („važi od" zatvara prethodni);
        {' '}<strong>Ispravi</strong> menja postojeći red u mestu.
      </p>
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : !list.length ? (
        <EmptyState title="Nema istorije unosa." />
      ) : (
        <div className="space-y-3">
          <Sparkline list={list} />
          <div className="overflow-x-auto rounded-panel border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                  <th className="px-3 py-2">Važi od</th>
                  <th className="px-3 py-2">Važi do</th>
                  <th className="px-3 py-2">Tip</th>
                  <th className="px-3 py-2 text-right">Iznos</th>
                  <th className="px-3 py-2 text-right">NETO</th>
                  <th className="px-3 py-2 text-right">Δ%</th>
                  <th className="px-3 py-2">Uneo</th>
                  <th className="px-3 py-2">Odobrio</th>
                  <th className="px-3 py-2 text-right">Akcije</th>
                </tr>
              </thead>
              <tbody>
                {list.map((t, i) => {
                  const neto = termNetoBasis(t);
                  return (
                    <tr key={t.id} className="border-b border-line-soft">
                      <td className="px-3 py-2">{formatDate(t.effectiveFrom)}</td>
                      <td className="px-3 py-2">{t.effectiveTo ? formatDate(t.effectiveTo) : <em className="text-ink-secondary">aktivno</em>}</td>
                      <td className="px-3 py-2">{salaryTypeLabel(t.salaryType)}</td>
                      <td className="px-3 py-2 text-right tnums">{fmtMoney(t.amount, t.currency || 'RSD')}</td>
                      <td className="px-3 py-2 text-right tnums">{neto != null ? fmtMoney(neto, 'RSD') : <span className="text-ink-secondary">—</span>}</td>
                      <td className="px-3 py-2 text-right tnums"><GrowthCell list={list} i={i} /></td>
                      <td className="px-3 py-2 text-ink-secondary" title={t.createdBy || ''}>{(t.createdBy || '—').split('@')[0]}</td>
                      <td className="px-3 py-2">
                        {t.approvedBy ? (
                          <>{t.approvedBy}{t.approvedAt && <span className="text-ink-secondary"> ({formatDate(t.approvedAt)})</span>}</>
                        ) : <span className="text-ink-secondary">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => onEditTerm(t)} title="Ispravka postojećeg reda U MESTU" className="rounded-control px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2">Ispravi</button>
                          <button onClick={() => onDelete(t.id)} className="rounded-control px-2 py-1 text-xs text-status-danger hover:bg-status-danger/10">Obriši</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  );
}

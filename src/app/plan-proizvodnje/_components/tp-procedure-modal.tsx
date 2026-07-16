'use client';

import { useState } from 'react';
import { FileText, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Dialog } from '@/components/ui-kit/dialog';
import { toast } from '@/lib/toast';
import {
  useTechProcedure,
  fetchBigtehnDrawingSignUrl,
  type OpRow,
  type TechLog,
} from '@/api/plan-proizvodnje';
import {
  plannedSeconds,
  formatSecondsHm,
  rokUrgencyClass,
  urgencyPillClass,
  customerLabel,
  sanitizeDrawingNo,
  num,
} from './shared';
import { formatDate } from '@/lib/format';

/**
 * TP procedura modal — pun tehnološki postupak RN-a (port 1.0 techProcedureModal.js).
 * RN header grid + status badge + tabela operacija (done/total, Plan/Real totali,
 * „(orig:)", ne-mašinske) + expand prijava rada po operaciji iz logs[]. PDF crteža
 * iz keša (bigtehn sign). Read-only — samo prikaz.
 */
export function TpProcedureModal({ workOrderId, onClose }: { workOrderId: string; onClose: () => void }) {
  const q = useTechProcedure(workOrderId);
  const operations = q.data?.data.operations ?? [];
  const logs = q.data?.data.logs ?? [];
  const header = q.data?.data.header ?? null;

  async function openPdf(broj: string | null | undefined) {
    const san = sanitizeDrawingNo(broj);
    if (!san) return;
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      toast('⚠ Pop-up blokiran.');
      return;
    }
    try {
      const res = await fetchBigtehnDrawingSignUrl(san);
      if (!res.data?.url) {
        tab.close();
        toast('⚠ PDF nije pronađen.');
        return;
      }
      tab.location.href = res.data.url;
    } catch {
      tab.close();
      toast('⚠ Greška pri otvaranju PDF-a.');
    }
  }

  // Grupisanje prijava po operaciji + totali (Plan/Real).
  const logsByOp = new Map<string, TechLog[]>();
  for (const l of logs) {
    const k = String(l.operacija ?? '');
    if (!logsByOp.has(k)) logsByOp.set(k, []);
    logsByOp.get(k)!.push(l);
  }
  const totalPlan = operations.reduce((s, o) => s + plannedSeconds(o), 0);
  const totalReal = operations.reduce((s, o) => s + num(o.real_seconds), 0);

  return (
    <Dialog
      open
      onClose={onClose}
      size="2xl"
      title={header?.rn_ident_broj ? `Tehnološki postupak · RN ${header.rn_ident_broj}` : `Tehnološki postupak · RN ${workOrderId}`}
    >
      {q.isLoading ? (
        <div className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : operations.length === 0 ? (
        <div className="py-8 text-center text-sm text-ink-disabled">Nema operacija za ovaj RN.</div>
      ) : (
        <div className="space-y-4">
          {header && <RnHeader header={header} onPdf={() => openPdf(header.broj_crteza)} />}

          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-ink">
                Operacije <span className="text-ink-disabled">({operations.length})</span>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <span title="Ukupno tehnološko vreme" className="text-ink-secondary">
                  ⏱ Plan: <strong className="text-ink">{formatSecondsHm(totalPlan)}</strong>
                </span>
                <span title="Ukupno stvarno prijavljeno vreme" className="text-ink-secondary">
                  ✅ Real: <strong className="text-status-success">{formatSecondsHm(totalReal)}</strong>
                </span>
              </div>
            </div>
            <div className="overflow-x-auto rounded-panel border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                    <th className="w-8 px-2 py-1.5" />
                    <th className="px-3 py-1.5">Op</th>
                    <th className="px-3 py-1.5">Opis</th>
                    <th className="px-3 py-1.5">Mašina</th>
                    <th className="px-3 py-1.5">Komada</th>
                    <th className="px-3 py-1.5">Plan</th>
                    <th className="px-3 py-1.5">Real</th>
                    <th className="px-3 py-1.5">Status</th>
                    <th className="px-3 py-1.5">Završeno</th>
                  </tr>
                </thead>
                <tbody>
                  {operations.map((op, i) => (
                    <OpRowLine key={`${op.line_id}-${i}`} op={op} logs={logsByOp.get(String(op.operacija ?? '')) ?? []} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </Dialog>
  );
}

function RnHeader({ header, onPdf }: { header: OpRow; onPdf: () => void }) {
  const urgency = rokUrgencyClass(header.rok_izrade);
  const hasPdf = header.has_bigtehn_drawing !== false && !!sanitizeDrawingNo(header.broj_crteza);
  const status = header.rn_zavrsen
    ? { label: 'ZAVRŠEN', cls: 'bg-status-success-bg text-status-success' }
    : header.rn_zakljucano
      ? { label: 'ZAKLJUČAN', cls: 'bg-surface-2 text-ink-secondary' }
      : { label: 'U RADU', cls: 'bg-status-info-bg text-status-info' };

  return (
    <section className="rounded-panel border border-line bg-surface-2/40 p-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm md:grid-cols-3">
        <div>
          <span className="text-ink-disabled">RN:</span>{' '}
          <strong className="text-ink">{header.rn_ident_broj ?? '—'}</strong>{' '}
          <span className={cn('ml-1 rounded-full px-2 py-0.5 text-2xs font-medium', status.cls)}>{status.label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-ink-disabled">Crtež:</span>
          {hasPdf ? (
            <button
              type="button"
              onClick={onPdf}
              className="inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-xs text-accent hover:bg-surface-2"
              title="Otvori PDF crtež u novom tabu"
            >
              <FileText className="h-3.5 w-3.5" /> {header.broj_crteza ?? '—'}
            </button>
          ) : (
            <span className="text-ink">{header.broj_crteza ?? '—'}</span>
          )}
        </div>
        <div>
          <span className="text-ink-disabled">Naziv dela:</span>{' '}
          <strong className="text-ink">{header.naziv_dela ?? '—'}</strong>
        </div>
        <div>
          <span className="text-ink-disabled">Kupac:</span> <span className="text-ink">{customerLabel(header)}</span>
        </div>
        <div>
          <span className="text-ink-disabled">Materijal:</span> <span className="text-ink">{header.materijal ?? '—'}</span>
        </div>
        <div>
          <span className="text-ink-disabled">Dimenzija:</span>{' '}
          <span className="text-ink">{header.dimenzija_materijala ?? '—'}</span>
        </div>
        <div>
          <span className="text-ink-disabled">Komada:</span>{' '}
          <strong className="text-ink">{header.komada_total ?? '—'}</strong>
        </div>
        <div>
          <span className="text-ink-disabled">Rok:</span>{' '}
          <span className={cn('rounded-full px-2 py-0.5 text-2xs font-medium', urgencyPillClass(urgency))}>
            {formatDate(header.rok_izrade)}
          </span>
        </div>
      </div>
      {header.rn_napomena && (
        <div className="mt-2 text-sm">
          <span className="text-ink-disabled">Napomena:</span> <span className="text-ink">{header.rn_napomena}</span>
        </div>
      )}
    </section>
  );
}

function OpRowLine({ op, logs }: { op: OpRow; logs: TechLog[] }) {
  const [open, setOpen] = useState(false);
  const isDone = !!op.is_done_in_bigtehn;
  const statusBadge = isDone
    ? { label: '✓ završena', cls: 'text-status-success' }
    : op.local_status === 'in_progress'
      ? { label: 'u radu', cls: 'text-status-info' }
      : op.local_status === 'blocked'
        ? { label: 'blokirano', cls: 'text-status-danger' }
        : { label: 'čeka', cls: 'text-ink-secondary' };

  const isReassigned =
    !!op.assigned_machine_code && op.assigned_machine_code !== (op.original_machine_code ?? op.effective_machine_code);
  const machineCell = isReassigned ? (
    <span title="Premešteno iz BigTehn-a">
      {op.assigned_machine_code} <span className="text-ink-disabled">(orig: {op.original_machine_code ?? '—'})</span>
    </span>
  ) : (
    op.original_machine_code ?? op.effective_machine_code ?? '—'
  );
  const lastFinished = op.last_finished_at ? formatDate(op.last_finished_at) : '—';

  return (
    <>
      <tr className={cn('border-b border-line-soft', op.is_non_machining && 'italic text-ink-secondary')}>
        <td className="px-2 py-1.5 text-center">
          {logs.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              title={`${logs.length} prijav${logs.length === 1 ? 'a' : logs.length < 5 ? 'e' : 'a'}`}
              aria-expanded={open}
              className="rounded-control p-0.5 text-ink-secondary hover:bg-surface-2"
            >
              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
            </button>
          )}
        </td>
        <td className="tnums px-3 py-1.5 font-medium text-ink">{String(op.operacija ?? '')}</td>
        <td className="px-3 py-1.5" title={op.opis_rada ?? ''}>{op.opis_rada ?? '—'}</td>
        <td className="px-3 py-1.5">{machineCell}</td>
        <td className="tnums px-3 py-1.5">
          <strong className="text-ink">{op.komada_done ?? 0}</strong>
          <span className="text-ink-disabled"> / {op.komada_total ?? 0}</span>
        </td>
        <td className="tnums px-3 py-1.5 text-ink-secondary">{formatSecondsHm(plannedSeconds(op))}</td>
        <td className="tnums px-3 py-1.5 text-status-success">{formatSecondsHm(op.real_seconds)}</td>
        <td className={cn('px-3 py-1.5 text-xs', statusBadge.cls)}>{statusBadge.label}</td>
        <td className="px-3 py-1.5 text-ink-secondary">{lastFinished}</td>
      </tr>
      {open && logs.length > 0 && (
        <tr className="border-b border-line-soft bg-surface-2/40">
          <td colSpan={9} className="px-4 py-2">
            <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-ink-secondary">
              Prijave za operaciju {String(op.operacija ?? '')} ({logs.length})
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-2xs uppercase tracking-wider text-ink-disabled">
                    <th className="px-2 py-1">Početak</th>
                    <th className="px-2 py-1">Završeno</th>
                    <th className="px-2 py-1">Mašina</th>
                    <th className="px-2 py-1">Radnik</th>
                    <th className="px-2 py-1">Komada</th>
                    <th className="px-2 py-1">Trajanje</th>
                    <th className="px-2 py-1">Završen?</th>
                    <th className="px-2 py-1">Napomena</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l, i) => (
                    <LogRow key={i} log={l} />
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function LogRow({ log }: { log: TechLog }) {
  const worker = log.potpis || (log.worker_id != null ? `#${log.worker_id}` : '—');
  const napomena = log.napomena ? String(log.napomena).trim() : '';
  return (
    <tr className="border-t border-line-soft">
      <td className="px-2 py-1 text-ink-secondary">{log.started_at ? formatDate(log.started_at) : '—'}</td>
      <td className="px-2 py-1 text-ink-secondary">{log.finished_at ? formatDate(log.finished_at) : '—'}</td>
      <td className="px-2 py-1">{log.machine_code ?? '—'}</td>
      <td className="px-2 py-1">{worker}</td>
      <td className="tnums px-2 py-1">{log.komada ?? 0}</td>
      <td className="tnums px-2 py-1">{log.prn_timer_seconds ? formatSecondsHm(log.prn_timer_seconds) : '—'}</td>
      <td className="px-2 py-1 text-center">
        {log.is_completed ? <span className="text-status-success">DA</span> : <span className="text-ink-disabled">ne</span>}
      </td>
      <td className="px-2 py-1" title={napomena}>
        {napomena.length > 60 ? napomena.slice(0, 60) + '…' : napomena}
      </td>
    </tr>
  );
}

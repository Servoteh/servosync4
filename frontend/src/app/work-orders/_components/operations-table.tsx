'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import type { WorkOrderOperation } from '@/api/work-orders';
import type { OperationEstimate } from '@/api/time-estimate';

/** sr-RS format za norme/ukupno (do 3 decimale, decimalni zarez). */
const fmtNum = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 3 });
/** Kompaktan h/kom (do 2 decimale) za kolonu procene. */
const fmtH = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 2 });

/**
 * Ćelija „Slični poslovi (RM)" (TALAS AI-5): koliko slični poslovi STVARNO traju
 * PO KOMADU na tom radnom mestu, iz istorije prijava rada — interval p25–p75 sa
 * medijanom i brojem opservacija (n). NIJE norma i NE menja Tpz/Tk: samo uvid.
 * Mali uzorak (malo_podataka) se vizuelno označi kao nepouzdan.
 */
function EstimateCell({ est }: { est: OperationEstimate | undefined }) {
  const rm = est?.rm_procena;
  if (!rm || rm.n === 0 || rm.p25 == null || rm.p75 == null) {
    return <span className="text-ink-disabled">—</span>;
  }
  const cr = est?.crtez_procena;
  const title =
    `Stvarno vreme po komadu na ovom radnom mestu (istorija, ne norma): ` +
    `p25 ${fmtH(rm.p25)} – medijana ${rm.p50 != null ? fmtH(rm.p50) : '—'} – p75 ${fmtH(rm.p75)} h/kom, ` +
    `uzorak n=${rm.n}${rm.malo_podataka ? ' (mali uzorak — orijentaciono)' : ''}.` +
    (cr && cr.stvarno_h_p50 != null
      ? ` Baš ovaj crtež ranije: medijana ${fmtH(cr.stvarno_h_p50)} h/nalog (n=${cr.n_naloga}).`
      : '');
  return (
    <span className="inline-flex flex-col items-end leading-tight" title={title}>
      <span className="tnums text-ink">
        {rm.malo_podataka && <span aria-hidden>≈ </span>}
        {fmtH(rm.p25)}
        <span className="text-ink-disabled">–</span>
        {fmtH(rm.p75)}
        <span className="ml-1 text-2xs text-ink-secondary">h/kom</span>
      </span>
      <span className={`tnums text-2xs ${rm.malo_podataka ? 'text-status-warn' : 'text-ink-secondary'}`}>
        n={rm.n}
        {rm.malo_podataka && ' · malo'}
      </span>
    </span>
  );
}

/**
 * Read-only / editabilna tabela operacija TP-a (Op., RC, Opis, Tpz, Tk, Ukupno
 * + tfoot Ukupno). Markup izvučen iz `work-orders/page.tsx` (RN detalj) da bi ga
 * delili RN detalj (canEdit) i CAM detalj (read-only). Akcije (izmeni/obriši) se
 * prikazuju SAMO uz `canEdit`; tfoot „Ukupno" je uvek prisutan.
 *
 * `estimates` (TALAS AI-5, opciono) → dodaje nenametljivu kolonu „Slični poslovi
 * (RM)" sa statističkom procenom h/kom; kad izostane, kolone nema (npr. CAM ekran).
 */
export function OperationsTable({
  operations,
  pieceCount,
  canEdit,
  onEdit,
  onDelete,
  deleteDisabled,
  estimates,
  drawingHistory,
}: {
  operations: WorkOrderOperation[];
  pieceCount: number;
  canEdit?: boolean;
  onEdit?: (op: WorkOrderOperation) => void;
  onDelete?: (op: WorkOrderOperation) => void;
  /** Blokira dugme „Obriši" dok traje neka mutacija na RN-u. */
  deleteDisabled?: boolean;
  /** operationNumber → procena (TALAS AI-5). Prisutno → prikazuje se kolona. */
  estimates?: Map<number, OperationEstimate>;
  /** Istorija istog crteža (koliko drugih naloga) — natpis ispod tabele. */
  drawingHistory?: { broj_naloga: number; drugi_nalozi: number } | null;
}) {
  const opTotal = operations.reduce(
    (sum, op) => sum + (op.setupTime ?? 0) + (op.cycleTime ?? 0) * pieceCount,
    0,
  );
  const showEstimates = estimates != null;

  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
            <th className="px-3 py-2 font-semibold">Op.</th>
            <th className="px-3 py-2 font-semibold">RC</th>
            <th className="px-3 py-2 font-semibold">Opis</th>
            <th className="px-3 py-2 text-right font-semibold">Tpz</th>
            <th className="px-3 py-2 text-right font-semibold">Tk</th>
            <th className="px-3 py-2 text-right font-semibold">Ukupno</th>
            {showEstimates && (
              <th
                className="px-3 py-2 text-right font-semibold"
                title="Statistička procena iz istorije: koliko slični poslovi STVARNO traju po komadu na ovom radnom mestu (interval p25–p75, medijana, n). Nije norma — ne menja Tpz/Tk."
              >
                Slični poslovi (RM)
              </th>
            )}
            {canEdit && <th className="px-3 py-2 text-right font-semibold">Akcije</th>}
          </tr>
        </thead>
        <tbody>
          {operations.map((op) => {
            const uk = (op.setupTime ?? 0) + (op.cycleTime ?? 0) * pieceCount;
            return (
              <tr key={op.id} className="border-b border-line-soft last:border-0">
                <td className="tnums px-3 py-1.5 text-ink-secondary">{op.operationNumber}</td>
                <td className="px-3 py-1.5 text-ink">
                  {op.operation?.workCenterName ?? op.workCenterCode}
                </td>
                <td className="px-3 py-1.5 text-ink">{op.workDescription}</td>
                <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                  {op.setupTime != null ? fmtNum(op.setupTime) : '—'}
                </td>
                <td className="tnums px-3 py-1.5 text-right text-ink-secondary">
                  {op.cycleTime != null ? fmtNum(op.cycleTime) : '—'}
                </td>
                <td className="tnums px-3 py-1.5 text-right text-ink">{fmtNum(uk)}</td>
                {showEstimates && (
                  <td className="px-3 py-1.5 text-right">
                    <EstimateCell est={estimates.get(op.operationNumber)} />
                  </td>
                )}
                {canEdit && (
                  <td className="px-3 py-1.5 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        onClick={() => onEdit?.(op)}
                        aria-label="Izmeni operaciju"
                        className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button
                        disabled={deleteDisabled}
                        onClick={() => onDelete?.(op)}
                        aria-label="Obriši operaciju"
                        className="rounded-control border border-line px-2 py-1 text-status-danger hover:bg-status-danger-bg disabled:opacity-40"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-line bg-surface-2 text-2xs uppercase tracking-[0.08em] text-ink-secondary">
            <td className="px-3 py-2 font-semibold" colSpan={5}>
              Ukupno (Tpz + Tk × {formatNumber(pieceCount)} kom)
            </td>
            <td className="tnums px-3 py-2 text-right font-semibold text-ink">{fmtNum(opTotal)}</td>
            {showEstimates && <td />}
            {canEdit && <td />}
          </tr>
        </tfoot>
      </table>
      {showEstimates && (
        <p className="border-t border-line-soft px-3 py-2 text-2xs text-ink-secondary">
          „Slični poslovi (RM)" = koliko slični poslovi STVARNO traju po komadu na tom radnom mestu
          (istorija prijava rada, interval p25–p75 sa medijanom; „≈" i „malo" = mali uzorak).
          Informativno — ne menja normativ.
          {drawingHistory && drawingHistory.drugi_nalozi > 0 && (
            <>
              {' '}
              Isti crtež je ranije rađen na {formatNumber(drawingHistory.drugi_nalozi)}{' '}
              {drawingHistory.drugi_nalozi === 1 ? 'nalogu' : 'naloga'}.
            </>
          )}
        </p>
      )}
    </div>
  );
}

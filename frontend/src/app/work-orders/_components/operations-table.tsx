'use client';

import { Pencil, Trash2 } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import type { WorkOrderOperation } from '@/api/work-orders';

/** sr-RS format za norme/ukupno (do 3 decimale, decimalni zarez). */
const fmtNum = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 3 });

/**
 * Read-only / editabilna tabela operacija TP-a (Op., RC, Opis, Tpz, Tk, Ukupno
 * + tfoot Ukupno). Markup izvučen iz `work-orders/page.tsx` (RN detalj) da bi ga
 * delili RN detalj (canEdit) i CAM detalj (read-only). Akcije (izmeni/obriši) se
 * prikazuju SAMO uz `canEdit`; tfoot „Ukupno" je uvek prisutan.
 */
export function OperationsTable({
  operations,
  pieceCount,
  canEdit,
  onEdit,
  onDelete,
  deleteDisabled,
}: {
  operations: WorkOrderOperation[];
  pieceCount: number;
  canEdit?: boolean;
  onEdit?: (op: WorkOrderOperation) => void;
  onDelete?: (op: WorkOrderOperation) => void;
  /** Blokira dugme „Obriši" dok traje neka mutacija na RN-u. */
  deleteDisabled?: boolean;
}) {
  const opTotal = operations.reduce(
    (sum, op) => sum + (op.setupTime ?? 0) + (op.cycleTime ?? 0) * pieceCount,
    0,
  );

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
            {canEdit && <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

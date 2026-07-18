'use client';

import { usePartLocationCard } from '@/api/part-locations';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDateTime, formatNumber } from '@/lib/format';
import { qualityLabel, workerLabel } from './common';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function SumTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control border border-line bg-surface px-3 py-2">
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="tnums text-md font-semibold text-ink">{value}</dd>
    </div>
  );
}

/**
 * Kartica lokacije dela za jedan RN (expand red iz "Delovi na lokacijama"):
 * ledger istorija svih zapisa + NETO stanje po poziciji i ukupno (GET /card/:workOrderId).
 * Neto = SUM(quantity sa predznakom) — unos/cilj prenosa (+), trebovanje/izvor prenosa (−).
 * Mutacije (unos/prenos/trebovanje) su dugmad iznad tabele; ova kartica se osvežava
 * automatski po uspešnoj mutaciji (invalidacija `['part-locations']`).
 */
export function PartLocationCardDetail({ workOrderId }: { workOrderId: number }) {
  const q = usePartLocationCard(workOrderId);

  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju kartice.</span>;

  const { data: card, meta } = q.data;
  const wo = card.workOrder;

  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field label="RN / Ident" value={wo?.identNumber ?? `#${card.workOrderId}`} />
        <Field label="Naziv pozicije" value={wo?.partName || '—'} />
        <Field label="Crtež" value={wo?.drawingNumber || '—'} />
        <Field label="Zapisa u ledger-u" value={String(card.records.length)} />
      </dl>

      <div>
        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Neto stanje po poziciji
        </p>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <SumTile label="Ukupno (neto)" value={`${formatNumber(card.totalQuantity)} kom`} />
          {card.totalsByPosition.map((t) => (
            <SumTile
              key={t.positionId}
              label={t.position?.positionCode ?? `Pozicija #${t.positionId}`}
              value={`${formatNumber(t.quantity)} kom`}
            />
          ))}
        </dl>
      </div>

      {meta?.note && (
        <p className="rounded-control border border-line-soft bg-surface-2/60 px-3 py-2 text-xs text-ink-disabled">
          {meta.note}
        </p>
      )}

      <div>
        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Ledger istorija ({card.records.length})
        </p>
        {card.records.length === 0 ? (
          <EmptyState title="Nema zapisa lokacija za ovaj RN" />
        ) : (
          <div className="overflow-x-auto rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                  <th className="px-3 py-2 font-semibold">Datum</th>
                  <th className="px-3 py-2 font-semibold">Pozicija</th>
                  <th className="px-3 py-2 font-semibold">Kvalitet</th>
                  <th className="px-3 py-2 text-right font-semibold">Količina</th>
                  <th className="px-3 py-2 font-semibold">Radnik</th>
                </tr>
              </thead>
              <tbody>
                {card.records.map((r) => (
                  <tr key={r.id} className="border-b border-line-soft last:border-0">
                    <td className="tnums px-3 py-1.5 text-ink-secondary">
                      {formatDateTime(r.recordDate)}
                    </td>
                    <td className="px-3 py-1.5 text-ink">
                      {r.position?.positionCode ?? `#${r.positionId}`}
                      {r.position?.description && (
                        <span className="ml-1.5 text-xs text-ink-disabled">
                          {r.position.description}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-ink-secondary">
                      {qualityLabel(r.qualityTypeId, r.qualityType?.name)}
                    </td>
                    <td className="tnums px-3 py-1.5 text-right text-ink">
                      {formatNumber(r.quantity)}
                    </td>
                    <td className="px-3 py-1.5 text-ink-secondary">
                      {workerLabel(r.worker, r.workerId)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

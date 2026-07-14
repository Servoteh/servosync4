'use client';

import { useMemo } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { formatDateTime } from '@/lib/format';
import { useAllLocations, useMovements } from '@/api/lokacije';
import { buildLocIndex, movementLabel } from './common';

/** Istorija jedne stavke (movements filtrirani po item_ref_id/table). */
export function ItemHistoryDialog({
  itemRefId,
  itemRefTable,
  orderNo,
  onClose,
}: {
  itemRefId: string;
  itemRefTable: string;
  orderNo?: string;
  onClose: () => void;
}) {
  const q = useMovements({ itemRefId, itemRefTable, orderNo: orderNo || undefined, pageSize: 200 });
  const locs = useAllLocations('all');
  const locIndex = useMemo(() => buildLocIndex(locs.data ?? []), [locs.data]);
  const rows = q.data?.data ?? [];

  return (
    <Dialog open onClose={onClose} title={`Istorija stavke — ${itemRefId}`}>
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema zabeleženih pokreta za ovu stavku.</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((m) => (
            <li key={m.id} className="rounded-control border border-line-soft bg-surface-2 px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{movementLabel(m.movementType)}</span>
                <span className="tnums text-xs text-ink-secondary">{formatDateTime(m.movedAt)}</span>
              </div>
              <div className="mt-0.5 text-xs text-ink-secondary">
                {locIndex.labelOf(m.fromLocationId)} → {locIndex.labelOf(m.toLocationId)} · kol. {String(m.quantity)}
                {(m.movementReason || m.note) && ` · ${m.movementReason || m.note}`}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

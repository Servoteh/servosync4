'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { formatNumber } from '@/lib/format';
import {
  newClientEventId,
  useReversiDocument,
  useReversiReturn,
} from '@/api/reversi';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/**
 * Potvrda povraćaja (rev_confirm_return preko POST /reversi/return).
 * Prikazuje ISSUED stavke dokumenta sa preostalom količinom (default = sve);
 * `return_to_location_id` popunjava backend (magacin ALAT-MAG-01).
 */
export function ReturnDialog({
  docId,
  onClose,
}: {
  docId: string | null;
  onClose: () => void;
}) {
  const detail = useReversiDocument(docId);
  const ret = useReversiReturn();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [clientEventId, setClientEventId] = useState(newClientEventId);

  // Dijalog ostaje montiran (roditelj menja samo `docId`); resetuj stanje i uzmi
  // NOV idempotency ključ pri svakom otvaranju/promeni dokumenta — inače
  // napomena/količine i ključ „procure" sa prethodnog dokumenta.
  useEffect(() => {
    setQty({});
    setNotes('');
    setError(null);
    setClientEventId(newClientEventId());
  }, [docId]);

  const issuedLines = useMemo(
    () => (detail.data?.data.lines ?? []).filter((l) => l.lineStatus === 'ISSUED'),
    [detail.data],
  );

  function remaining(l: (typeof issuedLines)[number]): number {
    return Math.max(0, Number(l.quantity) - Number(l.returnedQuantity));
  }

  async function submit() {
    setError(null);
    const returned = issuedLines
      .map((l) => ({ line_id: l.id, returned_quantity: qty[l.id] ?? remaining(l) }))
      .filter((l) => l.returned_quantity > 0);
    if (!returned.length) return setError('Nijedna stavka nije označena za povraćaj.');
    try {
      await ret.mutateAsync({
        clientEventId,
        payload: {
          doc_id: docId,
          returned_lines: returned,
          return_notes: notes.trim() || undefined,
        },
      });
      setQty({});
      setNotes('');
      setClientEventId(newClientEventId());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Povraćaj nije uspeo.');
    }
  }

  return (
    <Dialog
      open={!!docId}
      onClose={onClose}
      title={`Povraćaj — ${detail.data?.data.docNumber ?? ''}`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={() => void submit()} loading={ret.isPending}>
            Potvrdi povraćaj
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {detail.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : issuedLines.length === 0 ? (
          <p className="text-sm text-ink-secondary">Sve stavke ovog dokumenta su već vraćene ili potrošene.</p>
        ) : (
          <div className="space-y-1 rounded-control border border-line p-2">
            {issuedLines.map((l) => (
              <div key={l.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1">
                  <span className="font-medium">{l.tool?.oznaka ?? l.drawingNo ?? l.partName ?? '—'}</span>{' '}
                  <span className="text-ink-secondary">{l.tool?.naziv ?? ''}</span>
                </span>
                <span className="text-xs text-ink-secondary">preostalo {formatNumber(remaining(l))}</span>
                <input
                  className={`${INPUT} w-20`}
                  type="number"
                  min={0}
                  max={remaining(l)}
                  value={qty[l.id] ?? remaining(l)}
                  onChange={(e) =>
                    setQty((m) => ({
                      ...m,
                      [l.id]: Math.min(remaining(l), Math.max(0, Number(e.target.value) || 0)),
                    }))
                  }
                />
              </div>
            ))}
          </div>
        )}

        <FormField label="Napomena povraćaja">
          <input className={INPUT} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>

        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

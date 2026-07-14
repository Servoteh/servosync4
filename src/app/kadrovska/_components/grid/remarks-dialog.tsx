'use client';

import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { formatDateTime } from '@/lib/format';
import { useResolveRemark, type WorkHoursRemark } from '@/api/kadrovska';

/** Primedbe radnika (💬) — lista + „Označi rešeno". Port _openRemarksModal. */
export function RemarksDialog({
  open,
  remarks,
  monthLabel,
  nameById,
  canResolve,
  onClose,
}: {
  open: boolean;
  remarks: WorkHoursRemark[];
  monthLabel: string;
  nameById: (empId: string) => string;
  canResolve: boolean;
  onClose: () => void;
}) {
  const resolve = useResolveRemark();
  const sorted = [...remarks].sort((a, b) => (a.status === b.status ? 0 : a.status === 'resolved' ? 1 : -1));

  return (
    <Dialog open={open} onClose={onClose} title={`💬 Primedbe — ${monthLabel}`}>
      {sorted.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema primedbi za ovaj mesec.</p>
      ) : (
        <div className="space-y-2">
          {sorted.map((r) => {
            const resolved = r.status === 'resolved';
            return (
              <div key={r.id} className="rounded-control border border-line-soft px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{nameById(r.employeeId)}</span>
                  <span className={resolved ? 'text-2xs text-status-success' : 'text-2xs text-status-warn'}>{resolved ? 'Rešeno' : 'Otvoreno'}</span>
                </div>
                {r.note && <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{r.note}</p>}
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-2xs text-ink-disabled">
                    {resolved && r.resolvedBy ? `Rešio: ${r.resolvedBy} · ${formatDateTime(r.resolvedAt)}` : formatDateTime(r.createdAt)}
                  </span>
                  {!resolved && canResolve && (
                    <Button variant="secondary" className="h-7 px-2 text-xs" loading={resolve.isPending} onClick={() => resolve.mutate({ id: r.id, status: 'resolved' })}>
                      ✔ Označi rešeno
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

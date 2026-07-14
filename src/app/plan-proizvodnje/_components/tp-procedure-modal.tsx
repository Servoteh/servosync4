'use client';

import { Dialog } from '@/components/ui-kit/dialog';
import { useTechProcedure } from '@/api/plan-proizvodnje';

/** TP procedura modal — ceo tehnološki postupak RN-a (operacije iz keša, read). */
export function TpProcedureModal({ workOrderId, onClose }: { workOrderId: string; onClose: () => void }) {
  const q = useTechProcedure(workOrderId);
  const ops = q.data?.data.operations ?? [];

  return (
    <Dialog open onClose={onClose} title={`Tehnološki postupak · RN ${workOrderId}`}>
      {q.isLoading ? (
        <div className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : ops.length === 0 ? (
        <div className="py-8 text-center text-sm text-ink-disabled">Nema operacija u kešu.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="px-3 py-1.5">Op</th>
                <th className="px-3 py-1.5">Mašina</th>
                <th className="px-3 py-1.5">Opis</th>
                <th className="px-3 py-1.5">TPZ</th>
                <th className="px-3 py-1.5">TK</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((o, i) => (
                <tr key={`${o.line_id}-${i}`} className="border-b border-line-soft">
                  <td className="tnums px-3 py-1.5">{String(o.operacija ?? '')}</td>
                  <td className="px-3 py-1.5">{o.effective_machine_code ?? '—'}</td>
                  <td className="px-3 py-1.5">{o.opis_rada ?? '—'}</td>
                  <td className="tnums px-3 py-1.5">{o.tpz_min ?? '—'}</td>
                  <td className="tnums px-3 py-1.5">{o.tk_min ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

'use client';

import { Dialog } from '@/components/ui-kit/dialog';
import { formatDate, formatNumber } from '@/lib/format';
import { useCuttingByMachine, useMachineHeads, type MachineRow } from '@/api/reversi';

/** Kartica mašine: rezni alat trenutno na njoj + glave (paritet 1.0 revMasineTab detalj). */
export function MachineCardDialog({ machine, onClose }: { machine: MachineRow | null; onClose: () => void }) {
  const cutting = useCuttingByMachine(machine?.machine_code ?? null);
  const heads = useMachineHeads(machine?.machine_code ?? null);

  return (
    <Dialog open={!!machine} onClose={onClose} title={machine ? `${machine.machine_code} — ${machine.name}` : 'Mašina'}>
      <div className="space-y-4">
        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-ink">Rezni alat na mašini</h3>
          <div className="space-y-1 rounded-control border border-line p-2">
            {cutting.isLoading ? (
              <p className="text-xs text-ink-secondary">Učitavanje…</p>
            ) : (cutting.data?.data ?? []).length === 0 ? (
              <p className="text-xs text-ink-secondary">Nema zaduženog reznog alata.</p>
            ) : (
              (cutting.data?.data ?? []).map((c) => (
                <div key={`${c.catalog_id}-${c.machine_code}`} className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{c.oznaka}</span>
                  <span className="flex-1 text-ink-secondary">{c.naziv}</span>
                  <span className="tnums">{formatNumber(Number(c.remaining_qty ?? 0))} {c.unit ?? ''}</span>
                  <span className="text-xs text-ink-secondary">{formatDate(c.last_issued_at)}</span>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="space-y-1">
          <h3 className="text-sm font-semibold text-ink">Glave</h3>
          <div className="space-y-1 rounded-control border border-line p-2">
            {heads.isLoading ? (
              <p className="text-xs text-ink-secondary">Učitavanje…</p>
            ) : (heads.data?.data ?? []).length === 0 ? (
              <p className="text-xs text-ink-secondary">Nema evidentiranih glava.</p>
            ) : (
              (heads.data?.data ?? []).map((h) => (
                <div key={h.id} className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{h.oznaka}</span>
                  <span className="flex-1 text-ink-secondary">{h.naziv}</span>
                  <span className="text-xs text-ink-secondary">{h.tip ?? ''}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </Dialog>
  );
}

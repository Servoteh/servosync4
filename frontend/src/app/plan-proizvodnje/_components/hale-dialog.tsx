'use client';

import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  useDeleteMachineHall,
  useMachineHalls,
  useUpsertMachineHall,
} from '@/api/plan-proizvodnje';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { toast } from '@/lib/toast';

/**
 * Šifrarnik hala (zahtev 046/26, odluka vlasnika: mapa hala↔mašina je RUČNA) — dodela
 * hale svakoj mašini iz `operations`. Mašine bez dodele padaju u grupu „Bez hale" na gantu.
 *
 * Živi UNUTAR modula (dugme „Hale" u tabu Gant), ne u Podešavanjima: Podešavanja nemaju
 * generički obrazac za šifarnike ovog tipa, a jedini potrošač mape je gant — manji put.
 * Prava: prikaz = `plan_proizvodnje.read`, izmena = `plan_proizvodnje.edit` (BE gate).
 */
export function HaleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useMachineHalls();
  const upsert = useUpsertMachineHall();
  const remove = useDeleteMachineHall();
  const [filter, setFilter] = useState('');
  const [novaHala, setNovaHala] = useState('');

  const rows = q.data?.data ?? [];
  const halls = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) if (r.hall) s.add(r.hall);
    return [...s].sort((a, b) => a.localeCompare(b, 'sr'));
  }, [rows]);

  const filtered = useMemo(() => {
    const t = filter.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) =>
      [r.machine_code, r.machine_name, r.hall].some((v) => String(v ?? '').toLowerCase().includes(t)),
    );
  }, [rows, filter]);

  function assign(machineCode: string, hall: string) {
    if (!hall) {
      remove.mutate({ machineCode }, { onSuccess: () => toast('✓ Hala uklonjena') });
      return;
    }
    upsert.mutate({ machineCode, hall }, { onSuccess: () => toast('✓ Hala dodeljena') });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Šifrarnik hala (mašina → hala)"
      size="xl"
      footer={
        <div className="ml-auto">
          <Button onClick={onClose}>Zatvori</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Traži mašinu ili halu"
            aria-label="Pretraga mašina"
            className="h-9 flex-1 rounded-control border border-line bg-surface px-2 text-sm text-ink placeholder:text-ink-disabled"
          />
          <input
            value={novaHala}
            onChange={(e) => setNovaHala(e.target.value)}
            placeholder={'Nova hala (npr. „Hala 3")'}
            aria-label="Naziv nove hale"
            className="h-9 w-56 rounded-control border border-line bg-surface px-2 text-sm text-ink placeholder:text-ink-disabled"
          />
        </div>
        <p className="text-2xs text-ink-disabled">
          Novu halu upiši u polje desno, pa je izaberi u redu mašine. Mašine bez hale se na gantu
          grupišu pod „Bez hale".
        </p>

        <div className="max-h-[55vh] overflow-auto rounded-panel border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-2xs uppercase tracking-wider text-ink-secondary">
              <tr>
                <th className="px-3 py-1.5 text-left">Mašina</th>
                <th className="px-3 py-1.5 text-left">Naziv</th>
                <th className="px-3 py-1.5 text-left">Hala</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.machine_code} className="border-b border-line-soft">
                  <td className="px-3 py-1.5 font-medium text-ink">{r.machine_code}</td>
                  <td className="max-w-[18rem] truncate px-3 py-1.5 text-ink-secondary">{r.machine_name ?? '—'}</td>
                  <td className="px-3 py-1.5">
                    <select
                      value={r.hall ?? ''}
                      onChange={(e) => assign(r.machine_code, e.target.value)}
                      aria-label={`Hala za mašinu ${r.machine_code}`}
                      className="h-8 w-48 rounded-control border border-line bg-surface px-2 text-sm text-ink"
                    >
                      <option value="">(bez hale)</option>
                      {halls.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                      {novaHala.trim() && !halls.includes(novaHala.trim()) ? (
                        <option value={novaHala.trim()}>+ {novaHala.trim()}</option>
                      ) : null}
                    </select>
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {r.hall ? (
                      <button
                        type="button"
                        onClick={() => assign(r.machine_code, '')}
                        className="text-ink-disabled hover:text-status-danger"
                        aria-label={`Ukloni halu sa mašine ${r.machine_code}`}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-sm text-ink-disabled">
                    {q.isLoading ? 'Učitavanje…' : 'Nema mašina za zadati filter.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </Dialog>
  );
}

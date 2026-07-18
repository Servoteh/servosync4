'use client';

import { useMemo, useState } from 'react';
import { useWorkOrders, type MaintMe, type WoStatus } from '@/api/odrzavanje';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { WoPriorityBadge, WoStatusBadge } from './common';
import { WoDetailDialog } from './wo-detail-dialog';

/** Statusi koji se tretiraju kao „gotov" (segment Završeni / isključeni iz Otvoreni). */
const DONE = new Set<WoStatus>(['zavrsen', 'otkazan']);
type Seg = 'open' | 'done' | 'all';

/**
 * Ugrađena lista radnih naloga za JEDNO sredstvo (paritet 1.0 embedded WO panel,
 * maintWorkOrdersPanel.js:117-359): traka Otvoreni/Završeni/Svi + kompaktna tabela.
 * Klik na red otvara WO detalj. Reusable — mašina karton (Istorija), vozilo karton
 * (Servis); IT/objekti kartoni je preuzimaju u P3. `assetId` = maint_assets.asset_id.
 */
export function AssetWorkOrders({
  assetId,
  me,
  title = 'Radni nalozi sredstva',
}: {
  assetId: string;
  me: MaintMe | undefined;
  title?: string;
}) {
  const [seg, setSeg] = useState<Seg>('open');
  const [openWo, setOpenWo] = useState<string | null>(null);
  // Povuci sve naloge za sredstvo (openOnly=false), pa segmentuj na klijentu (mali skup po sredstvu).
  const wos = useWorkOrders({ assetId, openOnly: false, pageSize: 200 });
  const all = wos.data?.data ?? [];

  const counts = useMemo(() => {
    let open = 0;
    let done = 0;
    for (const w of all) (DONE.has(w.status) ? (done += 1) : (open += 1));
    return { open, done, all: all.length };
  }, [all]);

  const rows = useMemo(() => {
    const sorted = [...all].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (seg === 'open') return sorted.filter((w) => !DONE.has(w.status));
    if (seg === 'done') return sorted.filter((w) => DONE.has(w.status));
    return sorted;
  }, [all, seg]);

  const SEGS: { key: Seg; label: string; n: number }[] = [
    { key: 'open', label: 'Otvoreni', n: counts.open },
    { key: 'done', label: 'Završeni', n: counts.done },
    { key: 'all', label: 'Svi', n: counts.all },
  ];

  return (
    <div className="rounded-panel border border-line p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        <div className="flex gap-1 rounded-control border border-line bg-surface-2/40 p-0.5">
          {SEGS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSeg(s.key)}
              className={cn(
                'rounded-control px-2.5 py-1 text-xs font-medium transition-colors',
                seg === s.key ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:text-ink',
              )}
            >
              {s.label} <span className="tnums">({s.n})</span>
            </button>
          ))}
        </div>
      </div>

      {wos.isLoading ? (
        <p className="py-3 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : wos.isError ? (
        <p className="py-3 text-center text-sm text-ink-secondary">Radni nalozi trenutno nisu dostupni.</p>
      ) : rows.length === 0 ? (
        <p className="py-3 text-center text-sm text-ink-secondary">
          {seg === 'open' ? 'Nema otvorenih naloga za ovo sredstvo.' : seg === 'done' ? 'Nema završenih naloga.' : 'Nema radnih naloga.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="py-1.5 pr-3">Broj</th>
                <th className="py-1.5 pr-3">Status</th>
                <th className="py-1.5 pr-3">Prioritet</th>
                <th className="py-1.5 pr-3">Naslov</th>
                <th className="py-1.5">Rok</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr
                  key={w.woId}
                  onClick={() => setOpenWo(w.woId)}
                  className="cursor-pointer border-b border-line-soft hover:bg-surface-2"
                >
                  <td className="tnums py-1.5 pr-3 text-ink-secondary">{w.woNumber ?? '—'}</td>
                  <td className="py-1.5 pr-3"><WoStatusBadge status={w.status} /></td>
                  <td className="py-1.5 pr-3"><WoPriorityBadge priority={w.priority} /></td>
                  <td className="py-1.5 pr-3 text-ink">{w.title}</td>
                  <td className="tnums py-1.5 text-ink-secondary">{w.dueAt ? formatDate(w.dueAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <WoDetailDialog woId={openWo} me={me} onClose={() => setOpenWo(null)} />
    </div>
  );
}

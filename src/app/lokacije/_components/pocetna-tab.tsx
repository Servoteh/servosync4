'use client';

import { useMemo, useState } from 'react';
import { ArrowRightLeft, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useAllLocations, useLocations, useMovements, usePlacements } from '@/api/lokacije';
import { buildLocIndex, movementLabel } from './common';
import { MovementDialog, type MovementPreset } from './movement-dialog';
import { ScanOverlay } from './scan-overlay';

/** Početna — KPI + poslednjih 12 pokreta + brze akcije. */
export function PocetnaTab({ onGoStavke }: { onGoStavke: (q: string) => void }) {
  const locs = useLocations({ active: 'true', pageSize: 1 });
  const placements = usePlacements({ pageSize: 1 });
  const recent = useMovements({ pageSize: 12 });
  const locFull = useAllLocations('all');
  const locIndex = useMemo(() => buildLocIndex(locFull.data ?? []), [locFull.data]);

  const [move, setMove] = useState<MovementPreset | null>(null);
  const [scan, setScan] = useState(false);

  const kpis = [
    { label: 'Aktivne lokacije', value: locs.data?.meta.pagination.total },
    { label: 'Smeštene stavke', value: placements.data?.meta.pagination.total },
    { label: 'Pokreta (ukupno)', value: recent.data?.meta.pagination.total },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Can permission={PERMISSIONS.LOKACIJE_MOVE}>
          <Button onClick={() => setMove({})}><ArrowRightLeft className="h-4 w-4" /> Brzo premeštanje</Button>
        </Can>
        <Button variant="secondary" onClick={() => setScan(true)}><ScanLine className="h-4 w-4" /> Skeniraj</Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-panel border border-line bg-surface p-4">
            <div className="text-2xs uppercase tracking-wider text-ink-secondary">{k.label}</div>
            <div className="tnums mt-1 text-2xl font-semibold text-ink">
              {k.value != null ? formatNumber(k.value) : '—'}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-panel border border-line bg-surface">
        <div className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">Poslednji pokreti</div>
        {recent.isLoading ? (
          <p className="px-4 py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : (recent.data?.data.length ?? 0) === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-ink-secondary">Nema zabeleženih pokreta.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {(recent.data?.data ?? []).map((m) => (
              <li key={m.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="w-40 shrink-0 tnums text-xs text-ink-secondary">{formatDateTime(m.movedAt)}</span>
                <span className="w-40 shrink-0 truncate">{movementLabel(m.movementType)}</span>
                <button className="truncate text-left text-accent hover:underline" onClick={() => onGoStavke(m.itemRefId)}>
                  {m.orderNo ? `${m.orderNo} · ` : ''}{m.itemRefId}
                </button>
                <span className="ml-auto shrink-0 text-xs text-ink-secondary">
                  {locIndex.labelOf(m.fromLocationId)} → {locIndex.labelOf(m.toLocationId)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {move && <MovementDialog preset={move} onClose={() => setMove(null)} />}
      {scan && (
        <ScanOverlay
          title="Skeniraj"
          accept={['ITEM', 'SHELF']}
          onResult={(r) => {
            if (r.kind === 'ITEM') onGoStavke(r.parsed.itemRefId);
          }}
          onClose={() => setScan(false)}
        />
      )}
    </div>
  );
}

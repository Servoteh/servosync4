'use client';

import { useState } from 'react';
import { RefreshCw, Lock } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useOperationsSearch, opKey, type OpRow } from '@/api/plan-proizvodnje';
import { OpsTable } from './ops-table';

/** Po crtežu: pretraga svih operacija + bulk premeštanje (JEDAN client_event_uuid u BE). */
export function PoCrtezuTab({
  onBulkReassign,
  onTp,
  onSkice,
  onReassign,
}: {
  onBulkReassign: (pairs: { workOrderId: string; lineId: string }[]) => void;
  onTp: (o: OpRow) => void;
  onSkice: (o: OpRow) => void;
  onReassign: (o: OpRow) => void;
}) {
  const can = useCan();
  const canEdit = can(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  const [q, setQ] = useState('');
  const search = useOperationsSearch(q);
  const rows = search.data?.data ?? [];
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(o: OpRow) {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = opKey(o);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  const selectedPairs = rows
    .filter((o) => selected.has(opKey(o)))
    .map((o) => ({ workOrderId: o.work_order_id, lineId: o.line_id }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Crtež / RN / naziv dela…" />
        <span className="text-sm text-ink-secondary">{rows.length} rezultata</span>
        {q.trim().length >= 2 && (
          <button
            type="button"
            onClick={() => search.refetch()}
            disabled={search.isFetching}
            title="Osveži"
            className="inline-flex h-8 items-center gap-1 rounded-control border border-line px-2 text-xs text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            <RefreshCw className={search.isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Osveži
          </button>
        )}
        {!canEdit && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary" title="Nemate pravo izmene">
            <Lock className="h-3 w-3" /> Samo za pregled
          </span>
        )}
        {selectedPairs.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-ink">{selectedPairs.length} izabrano</span>
            <Button onClick={() => onBulkReassign(selectedPairs)}>Premesti izabrane</Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>Poništi</Button>
          </div>
        )}
      </div>

      {q.trim().length < 2 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          Ukucaj bar 2 znaka za pretragu. Pretraga pokriva broj crteža, RN i naziv dela.
        </div>
      ) : search.isError ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-status-danger">
          Greška pri pretrazi.{' '}
          <button type="button" onClick={() => search.refetch()} className="underline">Pokušaj ponovo</button>
        </div>
      ) : search.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Pretraga…</div>
      ) : (
        <OpsTable
          ops={rows}
          selectable
          selected={selected}
          onToggleSelect={toggle}
          onReassign={onReassign}
          onTp={onTp}
          onSkice={onSkice}
        />
      )}
    </div>
  );
}

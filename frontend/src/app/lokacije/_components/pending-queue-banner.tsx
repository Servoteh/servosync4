'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { formatRelativeAge } from '@/lib/format';
import { KEYS } from '@/api/lokacije';
import {
  countPendingMovements,
  flushPendingMovements,
  installAutoFlush,
  listPendingMovements,
  subscribeQueue,
} from '@/lib/offlineQueue';

/**
 * Baner „Neposlato" — prikazuje broj premeštanja u offline queue-u (localStorage)
 * i nudi ručno slanje (paritet 1.0 „⏳ N čeka" badge). Auto-flush na `online`
 * event registruje `installAutoFlush`. Sakriven kad je queue prazan.
 */
export function PendingQueueBanner() {
  const qc = useQueryClient();
  const [count, setCount] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const refresh = useCallback(() => setCount(countPendingMovements()), []);

  useEffect(() => {
    installAutoFlush();
    refresh();
    const unsub = subscribeQueue(refresh);
    return unsub;
  }, [refresh]);

  const doFlush = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await flushPendingMovements();
      const parts: string[] = [];
      if (r.ok) parts.push(`poslato ${r.ok}`);
      if (r.failed) parts.push(`nije prošlo ${r.failed} (ostaju u redu)`);
      if (r.dropped) parts.push(`odbačeno ${r.dropped}`);
      setResult(parts.length ? parts.join(' · ') : 'Nema promena.');
      if (r.ok) void qc.invalidateQueries({ queryKey: KEYS.root });
    } catch (e) {
      setResult(e instanceof Error ? e.message : 'Slanje nije uspelo.');
    } finally {
      setBusy(false);
      refresh();
    }
  }, [qc, refresh]);

  if (count === 0) return null;

  const entries = expanded ? listPendingMovements() : [];

  return (
    <div className="rounded-panel border border-status-warn/40 bg-status-warn-bg p-3">
      <div className="flex flex-wrap items-center gap-2">
        <CloudOff className="h-4 w-4 shrink-0 text-status-warn" aria-hidden />
        <span className="text-sm font-medium text-ink">
          {count} premeštanj{count === 1 ? 'e' : 'a'} čeka slanje (offline red)
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            className="text-xs text-ink-secondary hover:underline"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Sakrij' : 'Detalji'}
          </button>
          <Button variant="secondary" loading={busy} onClick={() => void doFlush()}>
            <RefreshCw className="h-4 w-4" /> Pošalji sada
          </Button>
        </div>
      </div>
      {result && <p className="mt-2 text-xs text-ink-secondary">{result}</p>}
      {expanded && (
        <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-xs">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-2 rounded-control bg-surface/60 px-2 py-1">
              <span className="font-mono text-ink">{e.payload.itemRefId}</span>
              {e.payload.orderNo && <span className="text-ink-secondary">nalog {e.payload.orderNo}</span>}
              <span className="text-ink-secondary">{e.payload.movementType}</span>
              <span className="ml-auto text-ink-disabled">{formatRelativeAge(e.createdAt)}</span>
              {e.lastError && <span className="w-full text-status-danger">greška: {e.lastError}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

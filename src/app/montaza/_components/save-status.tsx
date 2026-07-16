'use client';

// Status snimanja (paritet 1.0 statusPanel): fiksni indikator u dnu — red čekanja /
// u toku / poslednja greška. Prikazuje se samo kad ima aktivnosti ili greške.
// Offline stanje (navigator.onLine + online/offline eventi) ima prioritet nad svim
// ostalim stanjima — 1.0 je čuvao lokalno pa sinhronizovao, 2.0 NE snima van mreže.

import { useEffect, useState } from 'react';
import { Loader2, Check, AlertTriangle, WifiOff } from 'lucide-react';
import type { SaveStatus } from '@/lib/plan-montaze/autosave';

export function SaveStatusPanel({ status }: { status: SaveStatus }) {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const active = status.queued > 0 || status.inflight > 0;
  const recentlySaved = !active && !status.error && status.savedAt != null;

  if (!offline && !active && !status.error && !recentlySaved) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        offline
          ? 'pointer-events-none fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm shadow-lg'
          : 'pointer-events-none fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-panel border border-line bg-surface px-3 py-2 text-sm shadow-lg'
      }
    >
      {offline ? (
        <>
          <WifiOff className="h-4 w-4 text-status-danger" aria-hidden />
          <span className="text-status-danger">Van mreže — izmene se ne snimaju.</span>
        </>
      ) : status.error ? (
        <>
          <AlertTriangle className="h-4 w-4 text-status-danger" aria-hidden />
          <span className="text-status-danger">{status.error}</span>
        </>
      ) : active ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
          <span className="text-ink-secondary">
            Snimanje…
            {status.queued > 0 && <span className="tnums"> ({status.queued} u redu)</span>}
          </span>
        </>
      ) : (
        <>
          <Check className="h-4 w-4 text-status-success" aria-hidden />
          <span className="text-ink-secondary">Sačuvano</span>
        </>
      )}
    </div>
  );
}

'use client';

import { RefreshCw } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import { Button } from './button';

/**
 * Traka "dostupna je nova verzija" (DESIGN_SYSTEM.md §10). Čisto prezentaciona —
 * kada i zašto se prikazuje odlučuje UpdateNotifier (src/components/update-notifier.tsx).
 */
export function UpdateBanner({
  builtAt,
  onReload,
  onLater,
}: {
  /** ISO vreme deploy-a nove verzije (iz version.json) — prikaz je opcioni */
  builtAt?: string;
  onReload: () => void;
  onLater: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-4"
    >
      <div className="pointer-events-auto flex w-full max-w-xl flex-wrap items-center gap-3 rounded-panel border border-status-info/40 bg-surface px-4 py-3 shadow-xl">
        <RefreshCw className="h-5 w-5 shrink-0 text-status-info" aria-hidden />
        <div className="min-w-0 flex-1 basis-52 text-base text-ink">
          <p className="font-semibold">Dostupna je nova verzija aplikacije.</p>
          <p className="text-sm text-ink-secondary">
            Osvežite stranicu da nastavite rad u najnovijoj verziji — nesnimljeni unos u
            otvorenoj formi se gubi, pa prvo snimite.
            {builtAt ? ` Objavljena: ${formatDateTime(builtAt)}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={onLater}>
            Kasnije
          </Button>
          <Button onClick={onReload}>Osveži sada</Button>
        </div>
      </div>
    </div>
  );
}

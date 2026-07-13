'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import {
  useWeeklyStatus,
  useWeeklyOdlozi,
  useWeeklyPomeri,
  useWeeklyVrati,
} from '@/api/sastanci';
import { formatDatum, formatVreme, INPUT_CLS } from './common';

/**
 * Sedmični kontrolni modal (paritet 1.0 weeklyControlModal). Pomeri/Odloži/Vrati —
 * `can_move` iz backenda (tabela sast_weekly_movers). Bez ovlašćenja: read-only.
 */
export function WeeklyControlModal({ onClose }: { onClose: () => void }) {
  const status = useWeeklyStatus();
  const pomeri = useWeeklyPomeri();
  const odlozi = useWeeklyOdlozi();
  const vrati = useWeeklyVrati();
  const [datum, setDatum] = useState('');
  const [vreme, setVreme] = useState('09:00');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const s = status.data?.data ?? null;
  const canMove = !!s?.can_move;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      void status.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Radnja nije uspela.');
    }
  }

  return (
    <Dialog open onClose={onClose} title="Sedmični sastanak">
      <div className="space-y-4">
        {status.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : (
          <>
            <div className="rounded-panel border border-line bg-surface-2 p-3 text-sm">
              {s?.skipped ? (
                <StatusBadge tone="neutral" label="Odloženo za ovu nedelju" />
              ) : s?.sastanak_id ? (
                <span className="text-ink">
                  Kreiran: <strong className="tnums">{formatDatum(s.sastanak_datum)}</strong> u{' '}
                  <strong className="tnums">{formatVreme(s.sastanak_vreme)}</strong>
                </span>
              ) : (
                <span className="text-ink-secondary">Automatika kreira u petak 08:00.</span>
              )}
              {s?.skip_reason && <p className="mt-1 text-xs text-ink-disabled">Razlog: {s.skip_reason}</p>}
            </div>

            {!canMove ? (
              <p className="text-sm text-ink-secondary">
                Nemaš ovlašćenje za pomeranje sedmičnog sastanka.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2 rounded-panel border border-line p-3">
                  <h3 className="text-sm font-semibold text-ink">Pomeri u ovoj nedelji</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <FormField label="Datum">
                      <input className={INPUT_CLS} type="date" value={datum} onChange={(e) => setDatum(e.target.value)} />
                    </FormField>
                    <FormField label="Vreme">
                      <input className={INPUT_CLS} type="time" value={vreme} onChange={(e) => setVreme(e.target.value)} />
                    </FormField>
                  </div>
                  <Button
                    variant="secondary"
                    loading={pomeri.isPending}
                    disabled={!datum}
                    onClick={() => void run(() => pomeri.mutateAsync({ datum, vreme: vreme || undefined }))}
                  >
                    Pomeri i pošalji pozivnice
                  </Button>
                </div>

                <div className="space-y-2 rounded-panel border border-line p-3">
                  <h3 className="text-sm font-semibold text-ink">Odloži ovu nedelju</h3>
                  <FormField label="Razlog (opciono)">
                    <input className={INPUT_CLS} value={reason} onChange={(e) => setReason(e.target.value)} />
                  </FormField>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      loading={odlozi.isPending}
                      onClick={() => void run(() => odlozi.mutateAsync({ reason: reason.trim() || undefined }))}
                    >
                      Odloži
                    </Button>
                    <Button
                      variant="ghost"
                      loading={vrati.isPending}
                      onClick={() => void run(() => vrati.mutateAsync({}))}
                    >
                      Vrati (poništi odlaganje)
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {error && <p className="text-sm text-status-danger">{error}</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}

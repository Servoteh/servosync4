'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { toast } from '@/lib/toast';
import { useLockOlderPaymentOrders } from '@/api/placanja';

/**
 * Modal „Zaključaj starije naloge" (BigBit paritet — zamrzavanje virmana). Svi otključani
 * nalozi za plaćanje KREIRANI pre izabranog datuma prelaze u zaključane (Zakljucano) —
 * zamrznut nalog se ne može potpisati/platiti ni izvesti u banku dok se ne otključa
 * (nalog po nalog). Već zaključani se ne diraju. TASTATURA: Esc = otkaži.
 *
 * DVA KORAKA (isti obrazac kao GK lock-older iz review-a): prvo „Proveri" (dry-run)
 * prebroji koliko naloga bi bilo zaključano — pa tek onda „Zaključaj N naloga".
 */
export function LockOlderPaymentsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const lockOlder = useLockOlderPaymentOrders();
  const [beforeDate, setBeforeDate] = useState(
    () => `${new Date().getFullYear()}-01-01`,
  );
  // Rezultat provere za dati datum (null = provera nije rađena / datum promenjen).
  const [preview, setPreview] = useState<{ date: string; count: number } | null>(
    null,
  );

  const err = (lockOlder.error as Error | null)?.message ?? null;
  const canSubmit = beforeDate.trim() !== '' && !lockOlder.isPending;
  const checked = preview !== null && preview.date === beforeDate;

  const runCheck = () => {
    if (!canSubmit) return;
    lockOlder.mutate(
      { beforeDate, dryRun: true },
      { onSuccess: (res) => setPreview({ date: beforeDate, count: res.count }) },
    );
  };

  const runLock = () => {
    if (!canSubmit || !checked || preview.count === 0) return;
    if (
      !window.confirm(
        `Zaključati ${preview.count} naloga kreiranih pre ${beforeDate}? ` +
          `Zaključan nalog se ne može potpisati, platiti ni izvesti dok se ne otključa (nalog po nalog).`,
      )
    )
      return;
    lockOlder.mutate(
      { beforeDate },
      {
        onSuccess: (res) => {
          toast(`Zaključano naloga: ${res.count}.`);
          setPreview(null);
          onClose();
        },
      },
    );
  };

  const close = () => {
    setPreview(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Zaključaj starije naloge"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={lockOlder.isPending}>
            Otkaži
          </Button>
          {!checked ? (
            <Button onClick={runCheck} loading={lockOlder.isPending} disabled={!canSubmit}>
              Proveri
            </Button>
          ) : (
            <Button
              onClick={runLock}
              loading={lockOlder.isPending}
              disabled={!canSubmit || preview.count === 0}
            >
              {preview.count === 0 ? 'Nema naloga' : `Zaključaj ${preview.count} naloga`}
            </Button>
          )}
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (checked) runLock();
          else runCheck();
        }}
      >
        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}
        <p className="text-sm text-ink-secondary">
          Svi otključani nalozi za plaćanje kreirani pre izabranog datuma prelaze u status
          Zaključan. Već zaključani se ne menjaju. Datum u budućnosti nije dozvoljen.
        </p>
        <div className="w-48">
          <FormField label="Zaključaj pre datuma" required>
            <Input
              type="date"
              value={beforeDate}
              onChange={(e) => {
                setBeforeDate(e.target.value);
                setPreview(null); // nov datum → nova provera
              }}
            />
          </FormField>
        </div>
        {checked && (
          <div
            className={
              preview.count === 0
                ? 'rounded-panel border border-line bg-surface-2 px-3 py-2 text-sm text-ink-secondary'
                : 'rounded-panel border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm text-ink'
            }
          >
            {preview.count === 0
              ? `Nema naloga kreiranih pre ${beforeDate} — nema šta da se zaključa.`
              : `Provera: ${preview.count} naloga bi bilo zaključano. Ništa još nije promenjeno.`}
          </div>
        )}
      </form>
    </Dialog>
  );
}

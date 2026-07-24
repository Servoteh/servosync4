'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { toast } from '@/lib/toast';
import { useLockOlderJournals } from '@/api/glavna-knjiga';

/**
 * Modal „Zaključaj starije naloge" (BigBit paritet — zaključavanje perioda). Svi
 * proknjiženi (posted) nalozi sa datumom knjiženja PRE izabranog datuma prelaze u
 * zaključane (locked) — sprečava naknadne izmene/storno u zatvorenom periodu.
 * Draft nalozi i već zaključani se ne diraju. TASTATURA: Esc = otkaži.
 */
export function LockOlderDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const lockOlder = useLockOlderJournals();
  const [beforeDate, setBeforeDate] = useState(
    () => `${new Date().getFullYear()}-01-01`,
  );

  const err = (lockOlder.error as Error | null)?.message ?? null;
  const canSubmit = beforeDate.trim() !== '';

  const submit = () => {
    if (!canSubmit) return;
    if (
      !window.confirm(
        `Zaključati sve proknjižene naloge sa datumom knjiženja pre ${beforeDate}? Zaključani nalozi se više ne mogu menjati ni stornirati bez otključavanja.`,
      )
    )
      return;
    lockOlder.mutate(beforeDate, {
      onSuccess: (res) => {
        toast(`Zaključano naloga: ${res.count}.`);
        onClose();
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Zaključaj starije naloge"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={lockOlder.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={lockOlder.isPending} disabled={!canSubmit}>
            Zaključaj
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}
        <p className="text-sm text-ink-secondary">
          Svi proknjiženi nalozi sa datumom knjiženja pre izabranog datuma prelaze u
          status „Zaključan". Nalozi u pripremi i već zaključani se ne menjaju.
        </p>
        <div className="w-48">
          <FormField label="Zaključaj pre datuma" required>
            <Input
              type="date"
              value={beforeDate}
              onChange={(e) => setBeforeDate(e.target.value)}
            />
          </FormField>
        </div>
      </form>
    </Dialog>
  );
}

'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import { useAkcioneTacke, useOdeljenja, usePromoteAkcionaTacka } from '@/api/pracenje';

/** Promocija akcione tačke iz Sastanaka u operativnu aktivnost (most Sastanci → Praćenje). */
export function PromoteModal({ rnId, projekat, onClose }: { rnId: string; projekat?: string; onClose: () => void }) {
  const tacke = useAkcioneTacke(projekat);
  const odeljenja = useOdeljenja();
  const promote = usePromoteAkcionaTacka();
  const [akcioniPlanId, setAkcioniPlanId] = useState('');
  const [odeljenjeId, setOdeljenjeId] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!akcioniPlanId || !odeljenjeId) return setErr('Izaberi akcionu tačku i odeljenje.');
    try {
      await promote.mutateAsync({ akcioniPlanId, odeljenjeId, rnId });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Promocija nije uspela.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Promoviši akcionu tačku"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={submit} loading={promote.isPending}>Promoviši</Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Akciona tačka (iz Sastanaka)" required>
          <select
            value={akcioniPlanId}
            onChange={(e) => setAkcioniPlanId(e.target.value)}
            className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
          >
            <option value="">—</option>
            {(tacke.data?.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.naslov}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Odeljenje" required>
          <select
            value={odeljenjeId}
            onChange={(e) => setOdeljenjeId(e.target.value)}
            className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
          >
            <option value="">—</option>
            {(odeljenja.data?.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>{o.naziv}</option>
            ))}
          </select>
        </FormField>
        {(tacke.data?.data ?? []).length === 0 && (
          <p className="text-xs text-ink-disabled">Nema otvorenih akcionih tačaka za ovaj projekat.</p>
        )}
        {err && <p className="text-sm text-status-danger">{err}</p>}
      </div>
    </Dialog>
  );
}

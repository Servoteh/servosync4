'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import { useAkcioneTacke, useOdeljenja, usePromoteAkcionaTacka, type AkcionaTacka } from '@/api/pracenje';

/**
 * Promocija akcione tačke iz Sastanaka u operativnu aktivnost (PR-24): opcija sa formatom
 * „naslov · odgovoran · rok", live preview izabrane tačke (naslov/opis/rok/odgovoran),
 * `onPromoted(id)` za highlight u listi. Napomena: naziv sastanka u opciji zahteva BE join
 * (TBE-30 čita samo v_akcioni_plan) — degradira na dostupna polja bez pada (BE-follow-up).
 */
export function PromoteModal({
  rnId,
  projekat,
  onClose,
  onPromoted,
}: {
  rnId: string;
  projekat?: string;
  onClose: () => void;
  onPromoted?: (id: string | null) => void;
}) {
  const tacke = useAkcioneTacke(projekat);
  const odeljenja = useOdeljenja();
  const promote = usePromoteAkcionaTacka();
  const [akcioniPlanId, setAkcioniPlanId] = useState('');
  const [odeljenjeId, setOdeljenjeId] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const list = tacke.data?.data ?? [];
  const selected = useMemo(() => list.find((t) => t.id === akcioniPlanId), [list, akcioniPlanId]);

  function optionLabel(t: AkcionaTacka): string {
    const parts = [t.naslov, t.odgovoran_label || t.odgovoran_text || 'bez odgovornog', t.rok_text || t.rok || 'bez roka'];
    return parts.filter(Boolean).join(' · ');
  }

  async function submit() {
    setErr(null);
    if (!akcioniPlanId || !odeljenjeId) return setErr('Izaberi akcionu tačku i odeljenje.');
    try {
      const res = await promote.mutateAsync({ akcioniPlanId, odeljenjeId, rnId });
      const newId = (res?.data as { id?: string | null } | undefined)?.id ?? null;
      onPromoted?.(newId);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Promocija nije uspela.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Iz akcione tačke"
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
            <option value="">Izaberi otvorenu akcionu tačku…</option>
            {list.map((t) => (
              <option key={t.id} value={t.id}>{optionLabel(t)}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Odeljenje" required>
          <select
            value={odeljenjeId}
            onChange={(e) => setOdeljenjeId(e.target.value)}
            className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
          >
            <option value="">Izaberi odeljenje…</option>
            {(odeljenja.data?.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>{o.naziv}</option>
            ))}
          </select>
        </FormField>

        {/* Live preview izabrane tačke */}
        {selected ? (
          <div className="rounded-control border border-line bg-surface-2 p-3">
            <div className="text-2xs uppercase tracking-wider text-ink-secondary">Preview operativne aktivnosti</div>
            <div className="mt-1 font-medium text-ink">{selected.naslov}</div>
            <div className="text-xs text-ink-secondary">{selected.opis || 'Bez opisa'}</div>
            <div className="mt-1 text-2xs text-ink-disabled">
              Rok: {selected.rok_text || selected.rok || '—'} · Odgovoran: {selected.odgovoran_label || selected.odgovoran_text || '—'} · Status: {selected.effective_status}
            </div>
          </div>
        ) : (
          <p className="text-xs text-ink-disabled">Izaberi akcionu tačku za preview.</p>
        )}

        {list.length === 0 && <p className="text-xs text-ink-disabled">Nema otvorenih akcionih tačaka za ovaj projekat.</p>}
        {err && <p className="text-sm text-status-danger">{err}</p>}
      </div>
    </Dialog>
  );
}

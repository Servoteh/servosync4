'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import {
  useUpsertAktivnost,
  useOdeljenja,
  useRadnici,
  AKTIVNOST_STATUS_LABELS,
  type AktivnostRow,
  type AktivnostInput,
} from '@/api/pracenje';

const PRIORITETI = [
  { v: 'nizak', label: 'Nizak' },
  { v: 'srednji', label: 'Srednji' },
  { v: 'visok', label: 'Visok' },
];

/** Modal za operativnu aktivnost (upsert_operativna_aktivnost, praktičan podskup 24 polja). */
export function AktivnostModal({
  open,
  onClose,
  rnId,
  projekatId,
  aktivnost,
}: {
  open: boolean;
  onClose: () => void;
  rnId: string;
  projekatId?: string;
  aktivnost: AktivnostRow | null;
}) {
  const odeljenja = useOdeljenja();
  const radnici = useRadnici();
  const upsert = useUpsertAktivnost();
  const [d, setD] = useState<AktivnostInput>({ odeljenjeId: '', nazivAktivnosti: '' });
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setD({
      id: aktivnost?.id,
      radniNalogId: rnId,
      projekatId,
      odeljenjeId: aktivnost?.odeljenje_id ?? '',
      nazivAktivnosti: aktivnost?.naziv_aktivnosti ?? '',
      status: aktivnost?.status ?? 'nije_krenulo',
      prioritet: aktivnost?.prioritet ?? 'srednji',
      rb: aktivnost?.rb ?? undefined,
      opis: aktivnost?.opis ?? undefined,
      brojTp: aktivnost?.broj_tp ?? undefined,
      kolicinaText: aktivnost?.kolicina_text ?? undefined,
      odgovoranLabel: aktivnost?.odgovoran_label ?? undefined,
      zavisiOdText: aktivnost?.zavisi_od_text ?? undefined,
      rizikNapomena: aktivnost?.rizik_napomena ?? undefined,
      planiraniPocetak: aktivnost?.planirani_pocetak?.slice(0, 10) ?? undefined,
      planiraniZavrsetak: aktivnost?.planirani_zavrsetak?.slice(0, 10) ?? undefined,
    });
  }, [open, aktivnost, rnId, projekatId]);

  function set<K extends keyof AktivnostInput>(k: K, v: AktivnostInput[K]) {
    setD((prev) => ({ ...prev, [k]: v }));
  }

  async function save() {
    setErr(null);
    if (!d.odeljenjeId) return setErr('Odeljenje je obavezno.');
    if (!d.nazivAktivnosti.trim()) return setErr('Naziv aktivnosti je obavezan.');
    try {
      await upsert.mutateAsync({ ...d, nazivAktivnosti: d.nazivAktivnosti.trim() });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Greška pri čuvanju aktivnosti.');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={aktivnost ? 'Izmena aktivnosti' : 'Nova aktivnost'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={save} loading={upsert.isPending}>Sačuvaj</Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Naziv aktivnosti" required>
          <Input value={d.nazivAktivnosti} onChange={(e) => set('nazivAktivnosti', e.target.value)} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Odeljenje" required>
            <select
              value={d.odeljenjeId}
              onChange={(e) => set('odeljenjeId', e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
            >
              <option value="">—</option>
              {(odeljenja.data?.data ?? []).map((o) => (
                <option key={o.id} value={o.id}>{o.naziv}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Odgovoran">
            <select
              value={d.odgovoranRadnikId ?? ''}
              onChange={(e) => {
                const r = (radnici.data?.data ?? []).find((x) => x.id === e.target.value);
                set('odgovoranRadnikId', e.target.value || undefined);
                set('odgovoranLabel', r?.puno_ime ?? r?.ime ?? undefined);
              }}
              className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
            >
              <option value="">—</option>
              {(radnici.data?.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.puno_ime ?? r.ime}</option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Status">
            <select
              value={d.status}
              onChange={(e) => set('status', e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
            >
              {Object.entries(AKTIVNOST_STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Prioritet">
            <select
              value={d.prioritet}
              onChange={(e) => set('prioritet', e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
            >
              {PRIORITETI.map((p) => (
                <option key={p.v} value={p.v}>{p.label}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Redosled (rb)">
            <Input type="number" value={d.rb ?? ''} onChange={(e) => set('rb', e.target.value ? Number(e.target.value) : undefined)} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Plan početak">
            <Input type="date" value={d.planiraniPocetak ?? ''} onChange={(e) => set('planiraniPocetak', e.target.value || undefined)} />
          </FormField>
          <FormField label="Plan završetak">
            <Input type="date" value={d.planiraniZavrsetak ?? ''} onChange={(e) => set('planiraniZavrsetak', e.target.value || undefined)} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Broj TP">
            <Input value={d.brojTp ?? ''} onChange={(e) => set('brojTp', e.target.value || undefined)} />
          </FormField>
          <FormField label="Količina">
            <Input value={d.kolicinaText ?? ''} onChange={(e) => set('kolicinaText', e.target.value || undefined)} />
          </FormField>
        </div>
        <FormField label="Zavisi od (tekst)">
          <Input value={d.zavisiOdText ?? ''} onChange={(e) => set('zavisiOdText', e.target.value || undefined)} />
        </FormField>
        <FormField label="Opis">
          <textarea
            value={d.opis ?? ''}
            onChange={(e) => set('opis', e.target.value || undefined)}
            rows={2}
            className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
          />
        </FormField>
        <FormField label="Rizik / napomena">
          <Input value={d.rizikNapomena ?? ''} onChange={(e) => set('rizikNapomena', e.target.value || undefined)} />
        </FormField>
        {err && <p className="text-sm text-status-danger">{err}</p>}
      </div>
    </Dialog>
  );
}

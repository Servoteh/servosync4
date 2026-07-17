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

const STATUS_MODE = [
  { v: 'manual', label: 'Ručno' },
  { v: 'auto_from_pozicija', label: 'Auto iz pozicije' },
  { v: 'auto_from_operacije', label: 'Auto iz operacija' },
];

/**
 * Modal za operativnu aktivnost (upsert_operativna_aktivnost) — pun set polja (PR-21):
 * Status mode (Ručno / Auto iz pozicije / Auto iz operacija), „Zavisi od aktivnosti" FK
 * select ostalih aktivnosti Tab2, Odgovoran radnik + Odgovoran label kao SLOBODAN tekst,
 * edit preload SVIH polja (uklj. odgovoranRadnikId). Read-only režim (PR-26): sva polja
 * disabled, footer „Read-only prikaz", viewer sme da gleda detalje postojeće aktivnosti.
 */
export function AktivnostModal({
  open,
  onClose,
  rnId,
  projekatId,
  aktivnost,
  activities = [],
  canEdit = true,
  onZatvori,
  onBlokiraj,
  onOdblokiraj,
}: {
  open: boolean;
  onClose: () => void;
  rnId: string;
  projekatId?: string;
  aktivnost: AktivnostRow | null;
  activities?: AktivnostRow[];
  canEdit?: boolean;
  onZatvori?: (a: AktivnostRow) => void;
  onBlokiraj?: (a: AktivnostRow) => void;
  onOdblokiraj?: (a: AktivnostRow) => void;
}) {
  const odeljenja = useOdeljenja();
  const radnici = useRadnici();
  const upsert = useUpsertAktivnost();
  const [d, setD] = useState<AktivnostInput>({ odeljenjeId: '', nazivAktivnosti: '' });
  const [err, setErr] = useState<string | null>(null);
  const readOnly = !canEdit;

  // Odeljenje po nazivu ako id ne stiže (1.0 findDeptIdByName fallback).
  const deptIdByName = (name: string | null | undefined): string => {
    if (!name) return '';
    const found = (odeljenja.data?.data ?? []).find((x) => String(x.naziv) === String(name));
    return found?.id ?? '';
  };

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setD({
      id: aktivnost?.id,
      radniNalogId: rnId,
      projekatId,
      odeljenjeId: aktivnost?.odeljenje_id ?? deptIdByName(aktivnost?.odeljenje ?? aktivnost?.odeljenje_naziv),
      nazivAktivnosti: aktivnost?.naziv_aktivnosti ?? '',
      status: aktivnost?.status ?? 'nije_krenulo',
      statusMode: aktivnost?.status_mode ?? 'manual',
      prioritet: aktivnost?.prioritet ?? 'srednji',
      rb: aktivnost?.rb ?? undefined,
      opis: aktivnost?.opis ?? undefined,
      brojTp: aktivnost?.broj_tp ?? undefined,
      kolicinaText: aktivnost?.kolicina_text ?? undefined,
      odgovoranRadnikId: (aktivnost?.odgovoran_radnik_id as string | undefined) ?? undefined,
      odgovoranUserId: (aktivnost?.odgovoran_user_id as string | undefined) ?? undefined,
      odgovoranLabel: aktivnost?.odgovoran_label ?? aktivnost?.odgovoran ?? undefined,
      zavisiOdAktivnostId: (aktivnost?.zavisi_od_aktivnost_id as string | undefined) ?? undefined,
      zavisiOdText: aktivnost?.zavisi_od_text ?? undefined,
      rizikNapomena: aktivnost?.rizik_napomena ?? undefined,
      izvor: aktivnost?.izvor ?? undefined,
      planiraniPocetak: aktivnost?.planirani_pocetak?.slice(0, 10) ?? undefined,
      planiraniZavrsetak: aktivnost?.planirani_zavrsetak?.slice(0, 10) ?? undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, aktivnost, rnId, projekatId, odeljenja.data]);

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

  const eff = String((aktivnost?.efektivni_status as string | undefined) || aktivnost?.status || '');
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink disabled:opacity-60';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={aktivnost ? (readOnly ? 'Aktivnost (pregled)' : 'Izmena aktivnosti') : 'Nova aktivnost'}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            {readOnly ? (
              <span className="text-xs text-ink-disabled">Read-only prikaz</span>
            ) : (
              <Button onClick={save} loading={upsert.isPending}>Sačuvaj</Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {canEdit && aktivnost && (
              <>
                {eff !== 'zavrseno' && (
                  <Button variant="ghost" className="text-xs" onClick={() => onZatvori?.(aktivnost)}>Zatvori aktivnost</Button>
                )}
                {eff === 'blokirano' ? (
                  <Button variant="ghost" className="text-xs" onClick={() => onOdblokiraj?.(aktivnost)}>Skini blokadu</Button>
                ) : (
                  <Button variant="ghost" className="text-xs" onClick={() => onBlokiraj?.(aktivnost)}>Postavi blokirano</Button>
                )}
              </>
            )}
            <Button variant="secondary" onClick={onClose}>Zatvori</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Naziv aktivnosti" required>
          <Input value={d.nazivAktivnosti} onChange={(e) => set('nazivAktivnosti', e.target.value)} disabled={readOnly} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Odeljenje" required>
            <select value={d.odeljenjeId} onChange={(e) => set('odeljenjeId', e.target.value)} disabled={readOnly} className={selCls}>
              <option value="">—</option>
              {(odeljenja.data?.data ?? []).map((o) => (
                <option key={o.id} value={o.id}>{o.naziv}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Redosled (rb)">
            <Input type="number" value={d.rb ?? ''} onChange={(e) => set('rb', e.target.value ? Number(e.target.value) : undefined)} disabled={readOnly} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Odgovoran radnik">
            <select
              value={d.odgovoranRadnikId ?? ''}
              onChange={(e) => set('odgovoranRadnikId', e.target.value || undefined)}
              disabled={readOnly}
              className={selCls}
            >
              <option value="">Bez veze na radnika</option>
              {(radnici.data?.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.puno_ime ?? r.ime ?? r.email ?? r.id}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Odgovoran (label)">
            <Input value={d.odgovoranLabel ?? ''} onChange={(e) => set('odgovoranLabel', e.target.value || undefined)} disabled={readOnly} placeholder="Slobodan tekst…" />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Zavisi od aktivnosti (FK)">
            <select
              value={d.zavisiOdAktivnostId ?? ''}
              onChange={(e) => set('zavisiOdAktivnostId', e.target.value || undefined)}
              disabled={readOnly}
              className={selCls}
            >
              <option value="">Bez FK veze</option>
              {activities.filter((x) => x.id && x.id !== aktivnost?.id).map((x) => (
                <option key={x.id} value={x.id}>{x.rb ?? ''} {x.naziv_aktivnosti ?? ''}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Zavisi od (tekst)">
            <Input value={d.zavisiOdText ?? ''} onChange={(e) => set('zavisiOdText', e.target.value || undefined)} disabled={readOnly} />
          </FormField>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Status mode">
            <select value={d.statusMode ?? 'manual'} onChange={(e) => set('statusMode', e.target.value)} disabled={readOnly} className={selCls}>
              {STATUS_MODE.map((s) => (
                <option key={s.v} value={s.v}>{s.label}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Status (ručni)">
            <select value={d.status} onChange={(e) => set('status', e.target.value)} disabled={readOnly} className={selCls}>
              {Object.entries(AKTIVNOST_STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Prioritet">
            <select value={d.prioritet} onChange={(e) => set('prioritet', e.target.value)} disabled={readOnly} className={selCls}>
              {PRIORITETI.map((p) => (
                <option key={p.v} value={p.v}>{p.label}</option>
              ))}
            </select>
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Plan početak">
            <Input type="date" value={d.planiraniPocetak ?? ''} onChange={(e) => set('planiraniPocetak', e.target.value || undefined)} disabled={readOnly} />
          </FormField>
          <FormField label="Plan završetak">
            <Input type="date" value={d.planiraniZavrsetak ?? ''} onChange={(e) => set('planiraniZavrsetak', e.target.value || undefined)} disabled={readOnly} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Broj TP">
            <Input value={d.brojTp ?? ''} onChange={(e) => set('brojTp', e.target.value || undefined)} disabled={readOnly} />
          </FormField>
          <FormField label="Količina">
            <Input value={d.kolicinaText ?? ''} onChange={(e) => set('kolicinaText', e.target.value || undefined)} disabled={readOnly} />
          </FormField>
        </div>
        <FormField label="Opis">
          <textarea
            value={d.opis ?? ''}
            onChange={(e) => set('opis', e.target.value || undefined)}
            rows={2}
            disabled={readOnly}
            className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink disabled:opacity-60"
          />
        </FormField>
        <FormField label="Rizik / napomena">
          <textarea
            value={d.rizikNapomena ?? ''}
            onChange={(e) => set('rizikNapomena', e.target.value || undefined)}
            rows={2}
            disabled={readOnly}
            className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink disabled:opacity-60"
          />
        </FormField>
        {err && <p className="text-sm text-status-danger">{err}</p>}
      </div>
    </Dialog>
  );
}

'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { useAssets, useCreateWorkOrder, type AssetType, type WoPriority, type WoType } from '@/api/odrzavanje';
import { ASSET_TYPE_LABEL, parsePrice, WO_PRIORITY_LABEL, WO_TYPE_LABEL } from './common';

const TYPES: WoType[] = ['kvar', 'preventiva', 'servis', 'inspekcija', 'administrativni'];
const PRIORITIES: WoPriority[] = ['p1_zastoj', 'p2_smetnja', 'p3_manje', 'p4_planirano'];

/** Ručno kreiranje radnog naloga (paritet 1.0 „Novi nalog"). */
export function CreateWoDialog({ onClose }: { onClose: () => void }) {
  const [assetType, setAssetType] = useState<AssetType>('machine');
  const [assetId, setAssetId] = useState('');
  const [type, setType] = useState<WoType>('kvar');
  const [priority, setPriority] = useState<WoPriority>('p3_manje');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [safety, setSafety] = useState(false);
  const [cena, setCena] = useState('');
  const [serviser, setServiser] = useState('');
  const [km, setKm] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const assets = useAssets(assetType, true);
  const create = useCreateWorkOrder();
  const jeVozilo = assetType === 'vehicle';

  function submit() {
    setErr(null);
    if (!assetId) return setErr('Izaberite sredstvo.');
    if (!title.trim()) return setErr('Naslov je obavezan.');
    const cenaNum = parsePrice(cena);
    if (Number.isNaN(cenaNum)) return setErr('Cena mora biti broj (npr. 42800 ili 42.800,50).');
    const kmNum = km.trim() === '' ? null : Number(km.replace(/\D/g, ''));
    if (kmNum != null && !Number.isFinite(kmNum)) return setErr('Kilometraža mora biti broj.');
    create.mutate(
      {
        type, assetId, assetType, title, description: description || undefined, priority,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        safetyMarker: safety,
        costTotal: cenaNum ?? undefined,
        externalServicerName: serviser.trim() || undefined,
        odometerKmAtService: kmNum ?? undefined,
      },
      { onSuccess: onClose, onError: (e) => setErr((e as Error).message) },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Novi radni nalog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Otkaži</Button>
          <Button onClick={submit} loading={create.isPending}>Kreiraj</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Vrsta sredstva">
            <select value={assetType} onChange={(e) => { setAssetType(e.target.value as AssetType); setAssetId(''); }} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              {(['machine', 'vehicle', 'it', 'facility'] as const).map((t) => (
                <option key={t} value={t}>{ASSET_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Sredstvo" required>
            <select value={assetId} onChange={(e) => setAssetId(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              <option value="">{assets.isLoading ? 'Učitavanje…' : '— izaberi —'}</option>
              {(assets.data?.data ?? []).map((a) => (
                <option key={a.assetId} value={a.assetId}>{a.assetCode} · {a.name}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Tip naloga">
            <select value={type} onChange={(e) => setType(e.target.value as WoType)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              {TYPES.map((t) => <option key={t} value={t}>{WO_TYPE_LABEL[t]}</option>)}
            </select>
          </FormField>
          <FormField label="Prioritet">
            <select value={priority} onChange={(e) => setPriority(e.target.value as WoPriority)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              {PRIORITIES.map((p) => <option key={p} value={p}>{WO_PRIORITY_LABEL[p]}</option>)}
            </select>
          </FormField>
        </div>
        <FormField label="Naslov" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kratak opis problema/zadatka" />
        </FormField>
        <FormField label="Opis">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </FormField>
        <div className="grid grid-cols-2 items-end gap-3">
          <FormField label="Rok">
            <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </FormField>
          <label className="flex h-9 cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={safety} onChange={(e) => setSafety(e.target.checked)} />
            Bezbednosni rizik
          </label>
        </div>

        {/*
          Trošak odmah pri kreiranju: servis se najčešće evidentira UNAZAD, sa računom
          u ruci. Bez ovoga je jedini put bio „kreiraj nalog → nađi ga u listi → otvori →
          upiši cenu", pa se cena praktično nije ni unosila (0 stavki na 134 naloga).
        */}
        <div className="rounded-panel border border-line bg-surface-2/40 p-3">
          <h4 className="mb-2 text-sm font-semibold text-ink">Trošak (opciono)</h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FormField label="Cena popravke (RSD)" hint="ceo iznos sa računa">
              <Input value={cena} onChange={(e) => setCena(e.target.value)} inputMode="decimal" placeholder="npr. 42800" />
            </FormField>
            <FormField label="Servis / radionica">
              <Input value={serviser} onChange={(e) => setServiser(e.target.value)} placeholder="npr. Auto Čačak" />
            </FormField>
            {jeVozilo && (
              <FormField label="Kilometraža">
                <Input value={km} onChange={(e) => setKm(e.target.value)} inputMode="numeric" placeholder="npr. 148320" />
              </FormField>
            )}
          </div>
          <p className="mt-1.5 text-2xs text-ink-secondary">
            Možeš i kasnije — cena se uređuje i u samom nalogu, gde postoji i čitanje računa sa slike.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

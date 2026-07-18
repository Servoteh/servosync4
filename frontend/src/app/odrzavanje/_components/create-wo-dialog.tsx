'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { useAssets, useCreateWorkOrder, type AssetType, type WoPriority, type WoType } from '@/api/odrzavanje';
import { ASSET_TYPE_LABEL, WO_PRIORITY_LABEL, WO_TYPE_LABEL } from './common';

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
  const [err, setErr] = useState<string | null>(null);

  const assets = useAssets(assetType, true);
  const create = useCreateWorkOrder();

  function submit() {
    setErr(null);
    if (!assetId) return setErr('Izaberite sredstvo.');
    if (!title.trim()) return setErr('Naslov je obavezan.');
    create.mutate(
      { type, assetId, assetType, title, description: description || undefined, priority, dueAt: dueAt ? new Date(dueAt).toISOString() : undefined, safetyMarker: safety },
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
      </div>
    </Dialog>
  );
}

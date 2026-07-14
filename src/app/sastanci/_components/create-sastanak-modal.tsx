'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { newClientEventId, useCreateSastanak, type Sastanak } from '@/api/sastanci';
import { DirectoryPicker } from './directory-picker';
import { INPUT_CLS, SASTANAK_TIP_LABEL } from './common';

/** „Novi sastanak" modal (paritet 1.0 createSastanakModal — osnovni tok). */
export function CreateSastanakModal({
  onClose,
  onCreated,
  defaultTip = 'projektni',
}: {
  onClose: () => void;
  onCreated?: (s: Sastanak) => void;
  defaultTip?: string;
}) {
  const create = useCreateSastanak();
  const [tip, setTip] = useState(defaultTip);
  const [naslov, setNaslov] = useState('');
  const [datum, setDatum] = useState('');
  const [vreme, setVreme] = useState('09:00');
  const [mesto, setMesto] = useState('');
  const [vodio, setVodio] = useState<{ email: string; label?: string } | null>(null);
  const [zapisnicar, setZapisnicar] = useState<{ email: string; label?: string } | null>(null);
  const [napomena, setNapomena] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!naslov.trim()) return setError('Naslov je obavezan.');
    if (!datum) return setError('Datum je obavezan.');
    try {
      const res = await create.mutateAsync({
        clientEventId: newClientEventId(),
        tip,
        naslov: naslov.trim(),
        datum,
        vreme: vreme || undefined,
        mesto: mesto.trim() || undefined,
        vodioEmail: vodio?.email,
        vodioLabel: vodio?.label,
        zapisnicarEmail: zapisnicar?.email,
        zapisnicarLabel: zapisnicar?.label,
        napomena: napomena.trim() || undefined,
      });
      onCreated?.(res.data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kreiranje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Novi sastanak"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={create.isPending} onClick={() => void submit()}>Zakaži</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Tip">
            <select className={INPUT_CLS} value={tip} onChange={(e) => setTip(e.target.value)}>
              {Object.entries(SASTANAK_TIP_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Mesto">
            <input className={INPUT_CLS} value={mesto} onChange={(e) => setMesto(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Naslov" required>
          <input className={INPUT_CLS} value={naslov} onChange={(e) => setNaslov(e.target.value)} autoFocus />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Datum" required>
            <input className={INPUT_CLS} type="date" value={datum} onChange={(e) => setDatum(e.target.value)} />
          </FormField>
          <FormField label="Vreme">
            <input className={INPUT_CLS} type="time" value={vreme} onChange={(e) => setVreme(e.target.value)} />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Vodi sastanak">
            <DirectoryPicker value={vodio} onChange={setVodio} />
          </FormField>
          <FormField label="Zapisničar">
            <DirectoryPicker value={zapisnicar} onChange={setZapisnicar} />
          </FormField>
        </div>
        <FormField label="Napomena">
          <textarea className={INPUT_CLS} rows={2} value={napomena} onChange={(e) => setNapomena(e.target.value)} />
        </FormField>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

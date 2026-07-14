'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  newClientEventId,
  useCreateTema,
  useUpdateTema,
  type PmTemaRow,
} from '@/api/sastanci';
import { INPUT_CLS, PRIORITET_LABEL, TEMA_OBLASTI, TEMA_VRSTE } from './common';

/** Nova/izmena PM teme (paritet 1.0 quickAddTemaButton + editTema). */
export function TemaModal({ edit, onClose }: { edit?: PmTemaRow | null; onClose: () => void }) {
  const { can } = useAuth();
  const canPrioritize = can(PERMISSIONS.SASTANCI_AI_MODEL); // admin (paritet canPrioritizeTeme = admin)
  const create = useCreateTema();
  const update = useUpdateTema();
  const [naslov, setNaslov] = useState(edit?.naslov ?? '');
  const [vrsta, setVrsta] = useState(edit?.vrsta ?? 'tema');
  const [oblast, setOblast] = useState(edit?.oblast ?? 'opste');
  const [opis, setOpis] = useState(edit?.opis ?? '');
  const [prioritet, setPrioritet] = useState(edit?.prioritet ?? 2);
  const [hitno, setHitno] = useState(edit?.hitno ?? false);
  const [zaRazmatranje, setZaRazmatranje] = useState(edit?.za_razmatranje ?? false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!naslov.trim()) return setError('Naslov je obavezan.');
    const body = {
      naslov: naslov.trim(),
      vrsta,
      oblast,
      opis: opis.trim() || undefined,
      prioritet,
      hitno,
      zaRazmatranje: canPrioritize ? zaRazmatranje : undefined,
    };
    try {
      if (edit) await update.mutateAsync({ id: edit.id, patch: body });
      else await create.mutateAsync({ clientEventId: newClientEventId(), status: 'predlog', ...body });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snimanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={edit ? 'Izmena teme' : 'Nova tema'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={create.isPending || update.isPending} onClick={() => void submit()}>Sačuvaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Naslov" required>
          <input className={INPUT_CLS} value={naslov} onChange={(e) => setNaslov(e.target.value)} autoFocus />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="Vrsta">
            <select className={INPUT_CLS} value={vrsta} onChange={(e) => setVrsta(e.target.value)}>
              {Object.entries(TEMA_VRSTE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </FormField>
          <FormField label="Oblast">
            <select className={INPUT_CLS} value={oblast} onChange={(e) => setOblast(e.target.value)}>
              {Object.entries(TEMA_OBLASTI).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </FormField>
          <FormField label="Prioritet">
            <select className={INPUT_CLS} value={prioritet} onChange={(e) => setPrioritet(Number(e.target.value))}>
              {[1, 2, 3].map((p) => <option key={p} value={p}>{PRIORITET_LABEL[p]}</option>)}
            </select>
          </FormField>
        </div>
        <FormField label="Opis">
          <textarea className={INPUT_CLS} rows={3} value={opis} onChange={(e) => setOpis(e.target.value)} />
        </FormField>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-1.5 text-sm text-ink">
            <input type="checkbox" checked={hitno} onChange={(e) => setHitno(e.target.checked)} /> Hitno
          </label>
          {canPrioritize && (
            <label className="flex items-center gap-1.5 text-sm text-ink">
              <input type="checkbox" checked={zaRazmatranje} onChange={(e) => setZaRazmatranje(e.target.checked)} /> Za razmatranje (admin)
            </label>
          )}
        </div>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

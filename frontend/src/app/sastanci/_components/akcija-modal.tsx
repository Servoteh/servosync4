'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import {
  newClientEventId,
  useCreateAkcija,
  usePatchAkcija,
  type AkcijaRow,
} from '@/api/sastanci';
import { DirectoryPicker } from './directory-picker';
import { ProjekatPicker, type ProjekatIzbor } from './projekat-picker';
import { AKCIJA_SETTABLE_STATUSI, AKCIJA_STATUS_LABEL, INPUT_CLS, PRIORITET_LABEL } from './common';

/** Nova/izmena akcije (paritet 1.0 akcioni plan modal). */
export function AkcijaModal({
  edit,
  sastanakId,
  initialProjekat,
  onClose,
}: {
  edit?: AkcijaRow | null;
  sastanakId?: string;
  /** S6 — prefill projekta/RN kad se otvara iz zaglavlja grupe („+ Zadatak"). */
  initialProjekat?: ProjekatIzbor | null;
  onClose: () => void;
}) {
  const create = useCreateAkcija();
  const patchM = usePatchAkcija();
  const [naslov, setNaslov] = useState(edit?.naslov ?? '');
  const [opis, setOpis] = useState(edit?.opis ?? '');
  const [odg, setOdg] = useState<{ email: string; label?: string } | null>(
    edit?.odgovoran_email ? { email: edit.odgovoran_email, label: edit.odgovoran_label ?? undefined } : null,
  );
  const [odgText, setOdgText] = useState(edit?.odgovoran_text ?? '');
  const [rok, setRok] = useState(edit?.rok ? String(edit.rok).slice(0, 10) : '');
  const [rokText, setRokText] = useState(edit?.rok_text ?? '');
  const [prioritet, setPrioritet] = useState(edit?.prioritet ?? 2);
  const [status, setStatus] = useState(edit?.status ?? 'otvoren');
  // S5/S6 — izbor projekta/RN. Kod izmene se seed-uje iz denormalizovanih polja
  // reda (projekat_id + projekatCode/projekatNaziv); kod nove akcije iz S6 prefill-a.
  const [projekat, setProjekat] = useState<ProjekatIzbor | null>(
    edit?.projekat_id
      ? { id: edit.projekat_id, code: edit.projekatCode, naziv: edit.projekatNaziv }
      : (initialProjekat ?? null),
  );
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!naslov.trim()) return setError('Naslov je obavezan.');
    const common = {
      naslov: naslov.trim(),
      opis: opis.trim() || undefined,
      odgovoranEmail: odg?.email,
      odgovoranLabel: odg?.label,
      odgovoranText: odgText.trim() || undefined,
      rok: rok || undefined,
      rokText: rokText.trim() || undefined,
      prioritet,
      status,
    };
    try {
      if (edit) {
        // `projekatId: null` (bez izbora) → BE patch briše vezu; string → menja je.
        await patchM.mutateAsync({ id: edit.id, patch: { ...common, projekatId: projekat?.id ?? null } });
      } else {
        await create.mutateAsync({
          clientEventId: newClientEventId(),
          sastanakId,
          projekatId: projekat?.id,
          ...common,
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snimanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={edit ? 'Izmena akcije' : 'Nova akcija'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={create.isPending || patchM.isPending} onClick={() => void submit()}>Sačuvaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Zadatak" required>
          <input className={INPUT_CLS} value={naslov} onChange={(e) => setNaslov(e.target.value)} autoFocus />
        </FormField>
        <FormField label="Opis">
          {/* S4 — veći unos: 6 redova + vertikalni resize (Zoran je stalno razvlačio 2 reda). */}
          <textarea className={`${INPUT_CLS} resize-y`} rows={6} value={opis} onChange={(e) => setOpis(e.target.value)} />
        </FormField>
        <FormField label="Projekat / RN" hint="Grupiše zadatak pod radni nalog. Prazno = bez RN / projekta.">
          <ProjekatPicker value={projekat} onChange={setProjekat} />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Odgovoran (iz direktorijuma)">
            <DirectoryPicker value={odg} onChange={setOdg} />
          </FormField>
          <FormField label="Odgovoran (slobodno)">
            <input className={INPUT_CLS} value={odgText} onChange={(e) => setOdgText(e.target.value)} placeholder="npr. kooperant" />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Rok (datum)">
            <input className={INPUT_CLS} type="date" value={rok} onChange={(e) => setRok(e.target.value)} />
          </FormField>
          <FormField label="Rok (slobodno)">
            <input className={INPUT_CLS} value={rokText} onChange={(e) => setRokText(e.target.value)} placeholder="npr. do kraja meseca" />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Prioritet">
            <select className={INPUT_CLS} value={prioritet} onChange={(e) => setPrioritet(Number(e.target.value))}>
              {[1, 2, 3].map((p) => (
                <option key={p} value={p}>{PRIORITET_LABEL[p]}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Status">
            <select className={INPUT_CLS} value={status} onChange={(e) => setStatus(e.target.value)}>
              {AKCIJA_SETTABLE_STATUSI.map((s) => (
                <option key={s} value={s}>{AKCIJA_STATUS_LABEL[s]}</option>
              ))}
            </select>
          </FormField>
        </div>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

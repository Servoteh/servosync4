'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import {
  HALL_TYPES,
  LOC_TYPE_LABEL,
  SHELF_TYPES,
  useAllLocations,
  useCreateLocation,
  useUpdateLocation,
  type LocLocation,
  type LocTypeEnum,
} from '@/api/lokacije';
import { LocationSelect } from './location-select';
import { locationKind } from './common';

const INPUT = 'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

const CREATE_TYPES: LocTypeEnum[] = [...HALL_TYPES, ...SHELF_TYPES, 'CAGE', 'MACHINE', 'SERVICE', 'OFFICE', 'TRANSIT', 'OTHER'];

/**
 * Tipovi koji NISU hala (polica/mašina…) moraju imati nadređenu halu (paritet 1.0 canBeShelfParent).
 * KAVEZ je IZUZETAK — kavez je prenosiv, hala mu je opciona (dodeli se kasnije premeštanjem),
 * kao u 1.0 renderCageForm („— bez hale (dodeli kasnije premestajem) —").
 */
function needsParent(type: LocTypeEnum): boolean {
  return locationKind(type) !== 'hall' && type !== 'CAGE';
}

/** Predloži prvi slobodan „<slovo><broj>" u hali za dati prefiks (auto-predlog šifre). */
function suggestNextCode(all: LocLocation[], parentId: string | null, prefix: string): string | null {
  if (!parentId) return null;
  const re = new RegExp(`^${prefix}(\\d+)$`, 'i');
  let max = 0;
  for (const l of all) {
    if (l.parentId !== parentId) continue;
    const m = re.exec(l.locationCode.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

/** Nova / izmena master lokacije (paritet 1.0 createLocation/updateLocation). */
export function LocationFormDialog({ edit, onClose }: { edit?: LocLocation | null; onClose: () => void }) {
  const isEdit = !!edit;
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const locs = useAllLocations('all');
  const locList = useMemo<LocLocation[]>(() => locs.data ?? [], [locs.data]);

  const [locationCode, setLocationCode] = useState(edit?.locationCode ?? '');
  const [name, setName] = useState(edit?.name ?? '');
  const [locationType, setLocationType] = useState<LocTypeEnum>(edit?.locationType ?? 'SHELF');
  const [parentId, setParentId] = useState<string | null>(edit?.parentId ?? null);
  const [isActive, setIsActive] = useState(edit?.isActive ?? true);
  const [capacityNote, setCapacityNote] = useState(edit?.capacityNote ?? '');
  const [notes, setNotes] = useState(edit?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  // Nadređena hala je obavezna za police/kaveze/mašine — i pri kreiranju i pri izmeni tipa.
  const parentRequired = needsParent(locationType);

  async function submit() {
    setError(null);
    if (!name.trim()) return setError('Naziv je obavezan.');
    if (parentRequired && !parentId) {
      return setError('Za policu / kavez / mašinu izaberi nadređenu halu.');
    }
    try {
      if (isEdit && edit) {
        await update.mutateAsync({
          id: edit.id,
          name: name.trim(),
          locationType,
          parentId,
          isActive,
          capacityNote: capacityNote.trim() || null,
          notes: notes.trim() || null,
        });
      } else {
        if (!locationCode.trim()) return setError('Šifra lokacije je obavezna.');
        await create.mutateAsync({
          locationCode: locationCode.trim(),
          name: name.trim(),
          locationType,
          parentId: parentId ?? undefined,
          capacityNote: capacityNote.trim() || undefined,
          notes: notes.trim() || undefined,
        });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Čuvanje nije uspelo.');
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? `Izmena lokacije — ${edit?.locationCode}` : 'Nova lokacija'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={busy} onClick={() => void submit()}>Sačuvaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Šifra lokacije" required={!isEdit} hint={isEdit ? 'Šifra se ne menja' : undefined}>
            <input className={INPUT} value={locationCode} onChange={(e) => setLocationCode(e.target.value)} disabled={isEdit} placeholder="npr. A23" />
            {!isEdit && parentRequired && parentId && !locationCode.trim() && (
              <button
                type="button"
                className="mt-1 text-xs text-accent hover:underline"
                onClick={() => { const s = suggestNextCode(locList, parentId, 'A'); if (s) setLocationCode(s); }}
              >
                Predloži sledeću slobodnu (npr. {suggestNextCode(locList, parentId, 'A')})
              </button>
            )}
          </FormField>
          <FormField label="Tip" required>
            <select className={INPUT} value={locationType} onChange={(e) => setLocationType(e.target.value as LocTypeEnum)}>
              {CREATE_TYPES.map((t) => (
                <option key={t} value={t}>{LOC_TYPE_LABEL[t] ?? t}</option>
              ))}
            </select>
          </FormField>
        </div>

        <FormField label="Naziv" required>
          <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="npr. Polica 12 — Hala 3" />
        </FormField>

        <FormField
          label="Nadređena lokacija (roditelj)"
          required={parentRequired}
          hint={parentRequired ? 'Polica / kavez / mašina mora pripadati hali' : 'Prazno = koren (hala bez roditelja)'}
        >
          <LocationSelect locations={locList.filter((l) => l.id !== edit?.id)} value={parentId} onChange={setParentId} placeholder="Pretraži nadređenu halu…" />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Napomena o kapacitetu">
            <input className={INPUT} value={capacityNote} onChange={(e) => setCapacityNote(e.target.value)} placeholder="opciono" />
          </FormField>
          <FormField label="Napomena">
            <input className={INPUT} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="opciono" />
          </FormField>
        </div>

        {isEdit && (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Aktivna lokacija
          </label>
        )}

        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

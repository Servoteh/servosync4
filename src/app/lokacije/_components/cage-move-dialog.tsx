'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { HALL_TYPES, useAllLocations, useMoveCage, type LocLocation } from '@/api/lokacije';
import { LocationSelect } from './location-select';

const INPUT = 'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/** Premeštaj kaveza u drugu halu — loc_move_cage (manage). */
export function CageMoveDialog({ cage, onClose }: { cage: LocLocation; onClose: () => void }) {
  const moveCage = useMoveCage();
  const locs = useAllLocations('true');
  const halls = useMemo<LocLocation[]>(
    () => (locs.data ?? []).filter((l) => HALL_TYPES.includes(l.locationType)),
    [locs.data],
  );

  const [newHallId, setNewHallId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!newHallId) return setError('Izaberi ciljnu halu.');
    try {
      await moveCage.mutateAsync({ cageId: cage.id, newHallId, reason: reason.trim() || undefined });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Premeštaj kaveza nije uspeo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Premeštaj kaveza — ${cage.locationCode}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={moveCage.isPending} onClick={() => void submit()}>Premesti</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Ciljna hala" required>
          <LocationSelect locations={halls} value={newHallId} onChange={setNewHallId} placeholder="Pretraži halu…" />
        </FormField>
        <FormField label="Razlog">
          <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="npr. premeštanje u Halu 3" maxLength={200} />
        </FormField>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

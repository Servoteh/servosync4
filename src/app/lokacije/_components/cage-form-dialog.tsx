'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { useAllLocations, useCreateLocation, type LocLocation } from '@/api/lokacije';
import { compareLocationCodeNatural, isCageLoc, locationKind } from './common';

const INPUT = 'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/** Šifra kaveza „KV <broj>" (paritet 1.0 CAGE_CODE_RE). */
const CAGE_CODE_RE = /^KV \d+$/;

/** Sledeći slobodan „KV N" iz postojećih kaveza (paritet 1.0 nextCageCodeFromLocs). */
function nextCageCode(locs: LocLocation[]): string {
  let max = 0;
  for (const l of locs) {
    if (!isCageLoc(l)) continue;
    const m = String(l.locationCode ?? '').trim().match(/^KV (\d+)$/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `KV ${max + 1}`;
}

/**
 * Nova KAVEZ lokacija — dedikovana forma (paritet 1.0 modals.js renderCageForm).
 * Kavez je prenosiv: hala je OPCIONA (dodeli se kasnije premeštanjem). Šifra
 * mora biti u formatu „KV broj"; auto-predlog sledećeg slobodnog. Ugrađen bulk
 * generator (KV od→do, isti opis) za serijsko kreiranje.
 */
export function CageFormDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateLocation();
  const locsQ = useAllLocations('all');
  const all = useMemo<LocLocation[]>(() => locsQ.data ?? [], [locsQ.data]);
  const halls = useMemo(
    () => all.filter((l) => locationKind(l.locationType) === 'hall').slice().sort(compareLocationCodeNatural),
    [all],
  );
  const suggested = useMemo(() => nextCageCode(all), [all]);

  const [hallId, setHallId] = useState('');
  const [code, setCode] = useState('');
  const [desc, setDesc] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Bulk
  const [bulkFrom, setBulkFrom] = useState('1');
  const [bulkTo, setBulkTo] = useState('5');
  const [bulkDesc, setBulkDesc] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [progress, setProgress] = useState<{ ok: number; failed: number; total: number } | null>(null);

  // Predloženu šifru pokaži čim korisnik nije ništa ukucao (ne gazi ručni unos).
  const effectiveCode = code || suggested;
  const fromN = Math.max(1, Math.min(9999, Number(bulkFrom) || 1));
  const toN = Math.max(1, Math.min(9999, Number(bulkTo) || 1));
  const bulkCount = Math.max(0, toN - fromN + 1);

  async function submitSingle() {
    setError(null);
    const loc = effectiveCode.trim();
    if (!CAGE_CODE_RE.test(loc)) {
      return setError('Šifra mora biti u formatu „KV broj" (npr. KV 7).');
    }
    if (!desc.trim()) return setError('Unesi opis kaveza.');
    try {
      await create.mutateAsync({
        locationCode: loc,
        name: desc.trim(),
        locationType: 'CAGE',
        parentId: hallId || undefined,
      });
      onClose();
    } catch {
      setError(`Snimanje nije uspelo (verovatno ${loc} već postoji u firmi).`);
    }
  }

  async function submitBulk() {
    setError(null);
    if (toN < fromN) return setError('„Do broja" mora biti ≥ „Od broja".');
    if (!bulkDesc.trim()) return setError('Unesi opis za sve kaveze.');
    if (bulkCount > 100 && !window.confirm(`Napraviti ${bulkCount} kaveza odjednom?`)) return;

    let ok = 0;
    let failed = 0;
    setProgress({ ok: 0, failed: 0, total: bulkCount });
    for (let n = fromN; n <= toN; n++) {
      try {
        await create.mutateAsync({
          locationCode: `KV ${n}`,
          name: bulkDesc.trim(),
          locationType: 'CAGE',
          parentId: hallId || undefined,
        });
        ok++;
      } catch {
        failed++; // najčešće duplikat — preskoči, nastavi
      }
      setProgress({ ok, failed, total: bulkCount });
    }
    if (failed === 0) onClose();
    // uz greške ostajemo otvoreni da korisnik vidi rezultat
  }

  const busy = create.isPending;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Novi kavez"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {progress && progress.failed > 0 ? 'Zatvori' : 'Otkaži'}
          </Button>
          {!showBulk && (
            <Button loading={busy} onClick={() => void submitSingle()}>
              Sačuvaj kavez
            </Button>
          )}
          {showBulk && (
            <Button loading={busy} onClick={() => void submitBulk()}>
              Napravi sve ({bulkCount})
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Trenutna hala" hint="Opciono — kavez je prenosiv, halu možeš dodeliti kasnije premeštanjem.">
          <select className={INPUT} value={hallId} onChange={(e) => setHallId(e.target.value)}>
            <option value="">— bez hale (dodeli kasnije premeštanjem) —</option>
            {halls.map((h) => (
              <option key={h.id} value={h.id}>{h.locationCode}{h.name ? ` — ${h.name}` : ''}</option>
            ))}
          </select>
        </FormField>

        {!showBulk ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Šifra kaveza" required hint="Format „KV broj“ (npr. KV 7)">
                <input
                  className={INPUT}
                  value={effectiveCode}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="npr. KV 7"
                  maxLength={20}
                />
              </FormField>
              <FormField label="Kratak opis" required>
                <input
                  className={INPUT}
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="npr. Veliki kavez sa točkovima"
                  maxLength={200}
                />
              </FormField>
            </div>
            <button type="button" className="text-xs text-accent hover:underline" onClick={() => setShowBulk(true)}>
              Dodaj više kaveza odjednom (bulk)
            </button>
          </>
        ) : (
          <div className="rounded-control border border-line-soft bg-surface-2 p-3">
            <div className="mb-2 flex items-center justify-between">
              <strong className="text-sm text-ink">Bulk kaveza</strong>
              <button type="button" className="text-xs text-accent hover:underline" onClick={() => setShowBulk(false)}>
                ← Jedan kavez
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Od broja" required>
                <input className={INPUT} type="number" min={1} max={9999} value={bulkFrom} onChange={(e) => setBulkFrom(e.target.value)} />
              </FormField>
              <FormField label="Do broja" required>
                <input className={INPUT} type="number" min={1} max={9999} value={bulkTo} onChange={(e) => setBulkTo(e.target.value)} />
              </FormField>
            </div>
            <FormField label="Opis za sve (isti)" required>
              <input className={INPUT} maxLength={200} value={bulkDesc} onChange={(e) => setBulkDesc(e.target.value)} placeholder="npr. Mali kavez" />
            </FormField>
            <div className="mt-2 rounded-control border border-line-soft bg-surface px-3 py-2 text-xs text-ink-secondary">
              Kreiraće se <strong className="text-ink">{bulkCount}</strong> kaveza: <span className="tnums">KV {fromN}, KV {fromN + 1}{bulkCount > 2 ? ', …' : ''}</span>
            </div>
            {progress && (
              <p className="mt-2 text-sm text-ink-secondary">
                Kreirano <strong className="text-status-success">{progress.ok}</strong>
                {progress.failed > 0 && <> · nije uspelo <strong className="text-status-warn">{progress.failed}</strong> (verovatno duplikat)</>}
                {' '}od {progress.total}.
              </p>
            )}
          </div>
        )}

        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

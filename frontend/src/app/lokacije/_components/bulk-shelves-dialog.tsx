'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { useAllLocations, useCreateLocation, type LocLocation } from '@/api/lokacije';
import { compareLocationCodeNatural, locationKind } from './common';

const INPUT = 'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';
const PREFIXES = ['A', 'B', 'C', 'D', 'F'] as const;

/**
 * Bulk generator polica (paritet 1.0 modals.js renderShelfForm „Dodaj više odjednom") —
 * serijsko kreiranje polica „<slovo><broj>" u izabranoj hali (npr. A1…A30 jednim klikom).
 * Auto-predlog sledećeg broja iz postojećih šifara sa istim prefiksom u hali.
 */
export function BulkShelvesDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateLocation();
  const locsQ = useAllLocations('all');
  const all = useMemo<LocLocation[]>(() => locsQ.data ?? [], [locsQ.data]);
  const halls = useMemo(
    () => all.filter((l) => locationKind(l.locationType) === 'hall').slice().sort(compareLocationCodeNatural),
    [all],
  );

  const [hallId, setHallId] = useState('');
  const [prefix, setPrefix] = useState<string>('A');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('30');
  const [desc, setDesc] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ ok: number; failed: number; total: number } | null>(null);

  const fromN = Math.max(1, Math.min(999, Number(from) || 1));
  const toN = Math.max(1, Math.min(999, Number(to) || 1));
  const count = Math.max(0, toN - fromN + 1);

  // Auto-predlog: sledeći slobodan broj za prefiks u izabranoj hali (max postojeći + 1).
  const suggestion = useMemo(() => {
    if (!hallId) return null;
    let max = 0;
    const re = new RegExp(`^${prefix}(\\d+)$`, 'i');
    for (const l of all) {
      if (l.parentId !== hallId) continue;
      const m = re.exec(l.locationCode.trim());
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max > 0 ? max + 1 : null;
  }, [all, hallId, prefix]);

  const example = count > 0 ? `${prefix}${fromN}, ${prefix}${fromN + 1}${count > 2 ? ', …' : ''}` : '—';

  async function submit() {
    setError(null);
    if (!hallId) return setError('Prvo izaberi halu.');
    if (toN < fromN) return setError('„Do broja" mora biti ≥ „Od broja".');
    if (!desc.trim()) return setError('Unesi opis koji se primenjuje na sve nove police.');
    if (count > 100 && !window.confirm(`Napraviti ${count} polica odjednom?`)) return;

    let ok = 0;
    let failed = 0;
    setProgress({ ok: 0, failed: 0, total: count });
    for (let n = fromN; n <= toN; n++) {
      try {
        await create.mutateAsync({
          locationCode: `${prefix}${n}`,
          name: desc.trim(),
          locationType: 'SHELF',
          parentId: hallId,
        });
        ok++;
      } catch {
        failed++; // najčešće duplikat šifre — preskoči, nastavi
      }
      setProgress({ ok, failed, total: count });
    }
    if (failed === 0) onClose();
    // uz greške ostajemo otvoreni da korisnik vidi rezultat
  }

  const busy = create.isPending;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Bulk generator polica"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{progress && progress.failed > 0 ? 'Zatvori' : 'Otkaži'}</Button>
          <Button loading={busy} onClick={() => void submit()}>Napravi sve ({count})</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Pripada hali" required>
          <select className={INPUT} value={hallId} onChange={(e) => setHallId(e.target.value)}>
            <option value="">— izaberi halu —</option>
            {halls.map((h) => (
              <option key={h.id} value={h.id}>{h.locationCode}{h.name ? ` — ${h.name}` : ''}</option>
            ))}
          </select>
        </FormField>

        <div>
          <span className="mb-1.5 block text-base font-medium text-ink">Slovo (prefiks)</span>
          <div className="flex flex-wrap gap-1.5">
            {PREFIXES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPrefix(p)}
                className={`h-8 w-8 rounded-control border text-sm font-medium ${prefix === p ? 'border-accent bg-accent-subtle text-accent' : 'border-line text-ink-secondary hover:bg-surface-2'}`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Od broja" required>
            <input className={INPUT} type="number" min={1} max={999} value={from} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          <FormField label="Do broja" required hint={suggestion != null ? `Sledeći slobodan: ${prefix}${suggestion}` : undefined}>
            <input className={INPUT} type="number" min={1} max={999} value={to} onChange={(e) => setTo(e.target.value)} />
          </FormField>
        </div>

        {suggestion != null && (
          <button
            type="button"
            className="text-xs text-accent hover:underline"
            onClick={() => setFrom(String(suggestion))}
          >
            Predloži od {prefix}{suggestion} (prvi slobodan u hali)
          </button>
        )}

        <FormField label="Opis za sve (isti)" required>
          <input className={INPUT} maxLength={200} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="npr. Farbanje, Dorada, Završna" />
        </FormField>

        <div className="rounded-control border border-line-soft bg-surface-2 px-3 py-2 text-xs text-ink-secondary">
          Kreiraće se <strong className="text-ink">{count}</strong> polica: <span className="tnums">{example}</span> (šifra unutar izabrane hale).
        </div>

        {progress && (
          <p className="text-sm text-ink-secondary">
            Kreirano <strong className="text-status-success">{progress.ok}</strong>
            {progress.failed > 0 && <> · nije uspelo <strong className="text-status-warn">{progress.failed}</strong> (verovatno duplikat šifre)</>}
            {' '}od {progress.total}.
          </p>
        )}
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

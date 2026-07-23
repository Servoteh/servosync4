'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { toast } from '@/lib/toast';
import {
  newClientEventId,
  useCreateSastanak,
  usePrenos,
  type Sastanak,
} from '@/api/sastanci';
import { DirectoryPicker } from './directory-picker';
import { DirectoryMultiPicker, type PickedUser } from './directory-multi-picker';
import { INPUT_CLS, SASTANAK_TIP_LABEL } from './common';

/**
 * „Novi sastanak" modal (paritet 1.0 createSastanakModal). Za tip sedmični nudi
 * „+ prenos": kopira učesnike i premesta otvorene akcije sa POSLEDNJEG sastanka
 * istog tipa STROGO PRE datuma novog (1.0 prenesiUNoviSastanak). Izvor bira BE
 * (poziv BEZ fromSastanakId — server-side, svež; klijentski snapshot je umeo da
 * tiho promaši kad lista nije učitana). `source: null` u odgovoru = server-verified
 * „nema prethodnog". Default isključen; „Sedmični + prenos" dugme ga pre-setuje
 * (1.0 carryover opcija).
 *
 * Zahtev 005/26 (Zoran Jaraković, 23.07): „Pozovi učesnike" u prvoj formi.
 * Izabrani učesnici idu uz create — BE ih umeće u istoj transakciji, a sy15 trigger
 * automatski šalje pozivnicu (tema/termin/mesto) mejlom. Kad je „prenos" uključen
 * (sedmični), učesnici se prenose sa prethodnog sastanka pa se ručni izbor sakriva
 * da se dva izvora ne sudare (prenos radi bulk-replace učesnika).
 */
export function CreateSastanakModal({
  onClose,
  onCreated,
  defaultTip = 'projektni',
  defaultPrenos = false,
}: {
  onClose: () => void;
  onCreated?: (s: Sastanak) => void;
  defaultTip?: string;
  defaultPrenos?: boolean;
}) {
  const create = useCreateSastanak();
  const prenosM = usePrenos();
  const [tip, setTip] = useState(defaultTip);
  const [naslov, setNaslov] = useState('');
  const [datum, setDatum] = useState('');
  const [vreme, setVreme] = useState('09:00');
  const [mesto, setMesto] = useState('');
  const [vodio, setVodio] = useState<{ email: string; label?: string } | null>(null);
  const [zapisnicar, setZapisnicar] = useState<{ email: string; label?: string } | null>(null);
  const [napomena, setNapomena] = useState('');
  const [prenos, setPrenos] = useState(defaultPrenos);
  const [ucesnici, setUcesnici] = useState<PickedUser[]>([]);
  const [prenosReplacedNote, setPrenosReplacedNote] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // „Prenos" (sedmični) sam kopira učesnike sa prethodnog sastanka → ručni izbor
  // se tada sakriva da bulk-replace prenosa ne pregazi ručno izabrane (i obrnuto).
  const prenosActive = tip === 'sedmicni' && prenos;

  // Uključivanje prenosa NAKON ručnog izbora: ne odbacuj tiho — vidljivo očisti
  // čipove i objasni da prenos preuzima učesnike sa prethodnog sastanka.
  function togglePrenos(checked: boolean) {
    setPrenos(checked);
    if (checked && ucesnici.length > 0) {
      setUcesnici([]);
      setPrenosReplacedNote(true);
    } else if (!checked) {
      setPrenosReplacedNote(false);
    }
  }

  async function submit() {
    setError(null);
    if (!naslov.trim()) return setError('Naslov je obavezan.');
    if (!datum) return setError('Datum je obavezan.');
    // Poziv iz „prve forme" (005/26): šalje se samo kad prenos NIJE aktivan.
    // BE uvek upiše pozvan=true/prisutan=false — tip nosi samo email+label.
    const pozvani =
      !prenosActive && ucesnici.length
        ? ucesnici.map((u) => ({ email: u.email, label: u.label }))
        : undefined;
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
        ucesnici: pozvani,
      });
      const created = res.data;
      if (tip === 'sedmicni' && prenos) {
        try {
          // BEZ fromSastanakId — BE bira izvor (poslednji istog tipa strogo pre datuma).
          const r = await prenosM.mutateAsync({
            id: created.id,
            clientEventId: newClientEventId(),
          });
          if (r.data.source) {
            toast(
              `Sastanak kreiran. Preneto ${r.data.akcije} akcija, ${r.data.ucesnici} učesnika (iz: ${r.data.source.naslov}).`,
            );
          } else {
            toast('Sastanak kreiran — nema prethodnog sastanka za prenos.');
          }
        } catch {
          toast('Sastanak kreiran, ali prenos nije uspeo.');
        }
      } else if (pozvani) {
        toast(`Sastanak zakazan — pozvano ${pozvani.length} učesnika (pozivnice u redu za slanje).`);
      }
      onCreated?.(created);
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
          <Button loading={create.isPending || prenosM.isPending} onClick={() => void submit()}>Zakaži</Button>
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
        {/* Zahtev 005/26 — poziv učesnika iz prve forme. Sakriveno kad je prenos
            aktivan (učesnici se tada prenose sa prethodnog sedmičnog sastanka). */}
        {prenosActive ? (
          <p className="text-xs text-ink-secondary">
            Učesnici se prenose sa poslednjeg sedmičnog sastanka.
            {prenosReplacedNote && ' Prethodno izabrani učesnici su uklonjeni jer ih prenos zamenjuje.'}
          </p>
        ) : (
          <FormField label="Pozovi učesnike">
            <DirectoryMultiPicker value={ucesnici} onChange={setUcesnici} />
            {ucesnici.length > 0 && (
              <p className="mt-1 text-xs text-ink-secondary">
                Pozvanima stiže mejl sa temom, terminom i mestom sastanka.
              </p>
            )}
          </FormField>
        )}
        {tip === 'sedmicni' && (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={prenos} onChange={(e) => togglePrenos(e.target.checked)} />
            Prenesi otvorene akcije i učesnike sa poslednjeg sastanka
          </label>
        )}
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

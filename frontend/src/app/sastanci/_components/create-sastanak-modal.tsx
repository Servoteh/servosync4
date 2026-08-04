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
  useSastanci,
  type Sastanak,
} from '@/api/sastanci';
import { DirectoryPicker } from './directory-picker';
import { DirectoryMultiPicker, type PickedUser } from './directory-multi-picker';
import { formatDatum, INPUT_CLS, PERIODICNI_PRESETI, SASTANAK_TIP_LABEL } from './common';

/**
 * „Novi sastanak" modal (paritet 1.0 createSastanakModal). „+ prenos" kopira
 * učesnike i premesta otvorene akcije sa izvornog sastanka — od 024/26 (predlog
 * d3, potvrđen 28.07) za SVAKI tip i sa IZBOROM izvora („Preuzmi otvorene stavke
 * iz…"); bez izbora izvor bira BE (poslednji ISTOG tipa STROGO PRE datuma novog,
 * server-side i svež — klijentski snapshot je umeo da tiho promaši kad lista
 * nije učitana). `source: null` u odgovoru = server-verified „nema prethodnog".
 * Default isključen; „Sedmični + prenos" dugme ga pre-setuje (1.0 carryover).
 *
 * 024/26 d1: tip „Periodični" nosi i interval (7/14/30 ili proizvoljan broj
 * dana) — automatika (`sast-periodicni-auto`, dnevno 08h) posle zatvaranja/
 * isteka termina kreira sledeći na `datum + interval`, sa pomeranjem za praznik.
 *
 * Zahtev 005/26 (Zoran Jaraković, 23.07): „Pozovi učesnike" u prvoj formi.
 * Izabrani učesnici idu uz create — BE ih umeće u istoj transakciji, a sy15 trigger
 * automatski šalje pozivnicu (tema/termin/mesto) mejlom. Kad je „prenos" uključen,
 * učesnici se prenose sa izvornog sastanka pa se ručni izbor sakriva da se dva
 * izvora ne sudare (prenos radi bulk-replace učesnika).
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
  // '' = automatski izbor izvora na BE (poslednji istog tipa pre datuma).
  const [prenosIzvorId, setPrenosIzvorId] = useState('');
  const [ucesnici, setUcesnici] = useState<PickedUser[]>([]);
  const [prenosReplacedNote, setPrenosReplacedNote] = useState(false);
  // 024/26 d1 — interval periodičnog: preset (7/14/30) ili proizvoljan broj dana.
  const [intervalIzbor, setIntervalIzbor] = useState('7');
  const [intervalCustom, setIntervalCustom] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Izvori za „Preuzmi otvorene stavke iz…" (024/26 d3) — ista strana liste kao
  // tabela (server klampuje na 200; sortirano datum desc = najskoriji prvi).
  const izvoriQ = useSastanci({ pageSize: 200 });
  const izvori = izvoriQ.data?.data ?? [];

  const intervalDays =
    intervalIzbor === 'custom' ? Number(intervalCustom) : Number(intervalIzbor);

  // „Prenos" sam kopira učesnike sa izvornog sastanka → ručni izbor se tada
  // sakriva da bulk-replace prenosa ne pregazi ručno izabrane (i obrnuto).
  const prenosActive = prenos;

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
    if (tip === 'periodicni' && (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365)) {
      return setError('Za periodični sastanak zadaj interval: ceo broj dana od 1 do 365.');
    }
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
        intervalDays: tip === 'periodicni' ? intervalDays : undefined,
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
      if (prenos) {
        try {
          // Izvor: izabran u formi (024/26 d3) ili BEZ fromSastanakId — tada BE
          // bira poslednji ISTOG tipa strogo pre datuma.
          const r = await prenosM.mutateAsync({
            id: created.id,
            fromSastanakId: prenosIzvorId || undefined,
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
        {/* 024/26 d1 — interval periodične serije (7/14/30 ili proizvoljno). */}
        {tip === 'periodicni' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Interval ponavljanja"
              required
              hint="Posle završetka termina automatika kreira sledeći na datum + interval (praznik ga pomera)."
            >
              <select
                className={INPUT_CLS}
                value={intervalIzbor}
                onChange={(e) => setIntervalIzbor(e.target.value)}
              >
                {PERIODICNI_PRESETI.map((p) => (
                  <option key={p.dana} value={String(p.dana)}>{p.label}</option>
                ))}
                <option value="custom">Proizvoljan broj dana…</option>
              </select>
            </FormField>
            {intervalIzbor === 'custom' && (
              <FormField label="Broj dana (1–365)" required>
                <input
                  className={INPUT_CLS}
                  type="number"
                  min={1}
                  max={365}
                  value={intervalCustom}
                  onChange={(e) => setIntervalCustom(e.target.value)}
                  placeholder="npr. 21"
                />
              </FormField>
            )}
          </div>
        )}
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
            aktivan (učesnici se tada prenose sa izvornog sastanka). */}
        {prenosActive ? (
          <p className="text-xs text-ink-secondary">
            Učesnici se prenose sa izvornog sastanka.
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
        {/* 024/26 d3 — prenos za SVAKI tip, sa izborom izvora („Preuzmi otvorene
            stavke iz…"). Prenose se samo NEZAVRŠENE akcije (otvoren/u toku) —
            završene ostaju u istoriji izvornog sastanka. */}
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={prenos} onChange={(e) => togglePrenos(e.target.checked)} />
          Prenesi otvorene akcije i učesnike iz postojećeg sastanka
        </label>
        {prenos && (
          <FormField
            label="Preuzmi otvorene stavke iz…"
            hint="Prenose se samo nezavršene akcije; završene ostaju u istoriji izvornog sastanka."
          >
            <select
              className={INPUT_CLS}
              value={prenosIzvorId}
              onChange={(e) => setPrenosIzvorId(e.target.value)}
            >
              <option value="">
                Automatski — poslednji sastanak istog tipa pre datuma
              </option>
              {izvori.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.naslov} — {formatDatum(s.datum)}
                </option>
              ))}
            </select>
          </FormField>
        )}
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

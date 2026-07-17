'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { toast } from '@/lib/toast';
import { printReversiLabels } from '@/lib/reversi-labels';
import {
  useAddSubgroup,
  useAddSubsubgroup,
  useCreateTool,
  useInventoryTree,
} from '@/api/reversi';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

const NEW_SG = '__NEW_SG__';
const NEW_SS = '__NEW_SS__';

/**
 * Modal „Nova jedinica u inventaru" (RB-46) — INSERT rev_tools + opciona štampa
 * nalepnice (RB-47). Paritet 1.0 `modals.js openAddToolModal`: kaskada Podgrupa
 * (+ „➕ Nova podgrupa" sa izborom grupe) / Podpodgrupa (+ „➕ Nova"), količinska
 * stavka (ukupna/min/max) + Potrošna toggle, „Odmah odštampaj nalepnicu".
 */
export function ToolCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tree = useInventoryTree();
  const create = useCreateTool();
  const addSub = useAddSubgroup();
  const addSubsub = useAddSubsubgroup();

  const [oznaka, setOznaka] = useState('');
  const [naziv, setNaziv] = useState('');
  const [subgroupSel, setSubgroupSel] = useState('');
  const [newSgGroup, setNewSgGroup] = useState('');
  const [newSgLabel, setNewSgLabel] = useState('');
  const [subsubSel, setSubsubSel] = useState('');
  const [newSsLabel, setNewSsLabel] = useState('');
  const [serial, setSerial] = useState('');
  const [datum, setDatum] = useState('');
  const [napomena, setNapomena] = useState('');
  const [isQty, setIsQty] = useState(false);
  const [isConsumable, setIsConsumable] = useState(false);
  const [totalQty, setTotalQty] = useState(1);
  const [minStock, setMinStock] = useState('');
  const [maxStock, setMaxStock] = useState('');
  const [printLbl, setPrintLbl] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOznaka('');
    setNaziv('');
    setSubgroupSel('');
    setNewSgGroup('');
    setNewSgLabel('');
    setSubsubSel('');
    setNewSsLabel('');
    setSerial('');
    setDatum('');
    setNapomena('');
    setIsQty(false);
    setIsConsumable(false);
    setTotalQty(1);
    setMinStock('');
    setMaxStock('');
    setPrintLbl(true);
    setError(null);
  }, [open]);

  // rev_tools pokriva HAND + LZO; REZNI grupa se isključuje iz izbora.
  const { groups, subgroups, subsubgroups } = useMemo(() => {
    const g = tree.data?.data.groups ?? [];
    const s = tree.data?.data.subgroups ?? [];
    const ss = tree.data?.data.subsubgroups ?? [];
    const rezni = g.find((x) => x.code === 'REZNI')?.id ?? null;
    return {
      groups: g.filter((x) => x.code !== 'REZNI'),
      subgroups: s.filter((x) => x.groupId !== rezni),
      subsubgroups: ss,
    };
  }, [tree.data]);

  const subsByGroupLabel = useMemo(() => {
    const map = new Map<string, typeof subgroups>();
    for (const s of subgroups) {
      const g = groups.find((x) => x.id === s.groupId);
      const key = g?.label ?? '—';
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    return map;
  }, [subgroups, groups]);

  const visibleSubsubs = useMemo(
    () => (subgroupSel && subgroupSel !== NEW_SG ? subsubgroups.filter((x) => x.subgroupId === subgroupSel) : []),
    [subsubgroups, subgroupSel],
  );

  function onSubgroupChange(v: string) {
    setSubgroupSel(v);
    setSubsubSel('');
    setNewSsLabel('');
  }

  async function submit() {
    setError(null);
    const oz = oznaka.trim();
    const nz = naziv.trim();
    if (!oz || !nz) {
      setError('Oznaka i naziv su obavezni.');
      return;
    }
    setBusy(true);
    try {
      // 1) Razreši podgrupu (postojeća ili nova).
      let subgroupId: string;
      let subgroupLabel: string;
      if (subgroupSel === NEW_SG) {
        if (!newSgGroup || !newSgLabel.trim()) {
          setError('Za novu podgrupu izaberi grupu i unesi naziv.');
          return;
        }
        const created = await addSub.mutateAsync({ groupCode: newSgGroup, label: newSgLabel.trim() });
        subgroupId = created.data.id;
        subgroupLabel = created.data.label;
      } else if (subgroupSel) {
        subgroupId = subgroupSel;
        subgroupLabel = subgroups.find((s) => s.id === subgroupSel)?.label ?? '';
      } else {
        setError('Izaberi podgrupu (grupa se izvodi automatski).');
        return;
      }

      // 2) Razreši podpodgrupu (opciono; postojeća ili nova).
      let subsubgroupId: string | null = null;
      if (subsubSel === NEW_SS) {
        if (newSsLabel.trim()) {
          const created = await addSubsub.mutateAsync({ subgroupId, label: newSsLabel.trim() });
          subsubgroupId = created.data.id;
        }
      } else if (subsubSel) {
        subsubgroupId = subsubSel;
      }

      // 3) Validacija količinske stavke.
      const min = minStock.trim() === '' ? null : Math.max(0, Math.floor(Number(minStock) || 0));
      const max = maxStock.trim() === '' ? null : Math.max(0, Math.floor(Number(maxStock) || 0));
      if (min != null && max != null && max < min) {
        setError('Maksimum ne sme biti manji od minimuma.');
        return;
      }

      const res = await create.mutateAsync({
        oznaka: oz,
        naziv: nz,
        subgroupId,
        subsubgroupId,
        serijskiBroj: serial.trim() || null,
        datumKupovine: datum || null,
        napomena: napomena.trim() || null,
        isQuantity: isQty,
        isConsumable: isQty && isConsumable,
        totalQty: isQty ? Math.max(0, Math.floor(Number(totalQty) || 0)) : 1,
        minStockQty: isQty ? min : null,
        maxStockQty: isQty ? max : null,
      });

      // RB-47 — nalepnica pri dodavanju (ALAT- Code128, 1 kopija).
      if (printLbl && res.data.barcode) {
        void printReversiLabels(
          [
            {
              barcode: res.data.barcode,
              oznaka: res.data.oznaka || oz,
              naziv: res.data.naziv || nz,
              subgroupLabel,
              serial: serial.trim() || null,
            },
          ],
          { copies: 1 },
        );
      }
      toast('Alat dodat');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snimanje nije uspelo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nova jedinica u inventaru"
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Sačuvaj
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-ink-secondary">
          Jedan zapis = jedan komad — osim ako označiš „Količinska stavka" (tada jedan barkod nosi
          više komada, npr. potrošni / zaštitni materijal).
        </p>

        <FormField label="Podgrupa" required>
          <select className={INPUT} value={subgroupSel} onChange={(e) => onSubgroupChange(e.target.value)}>
            <option value="">— Izaberi podgrupu —</option>
            {[...subsByGroupLabel.entries()].map(([groupLabel, subs]) => (
              <optgroup key={groupLabel} label={groupLabel}>
                {subs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value={NEW_SG}>➕ Nova podgrupa…</option>
          </select>
        </FormField>

        {subgroupSel === NEW_SG && (
          <div className="grid grid-cols-2 gap-3 rounded-control border border-line p-3">
            <FormField label="Grupa za novu podgrupu" required>
              <select className={INPUT} value={newSgGroup} onChange={(e) => setNewSgGroup(e.target.value)}>
                <option value="">— Izaberi grupu —</option>
                {groups.map((g) => (
                  <option key={g.code} value={g.code}>
                    {g.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Naziv nove podgrupe" required>
              <input
                className={INPUT}
                value={newSgLabel}
                onChange={(e) => setNewSgLabel(e.target.value)}
                placeholder="npr. Aku alat / Rukavice"
              />
            </FormField>
          </div>
        )}

        {subgroupSel && subgroupSel !== NEW_SG && (
          <FormField label="Podpodgrupa (opciono)">
            <select className={INPUT} value={subsubSel} onChange={(e) => setSubsubSel(e.target.value)}>
              <option value="">— (bez podpodgrupe) —</option>
              {visibleSubsubs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              <option value={NEW_SS}>➕ Nova podpodgrupa…</option>
            </select>
          </FormField>
        )}
        {subsubSel === NEW_SS && (
          <FormField label="Naziv nove podpodgrupe">
            <input
              className={INPUT}
              value={newSsLabel}
              onChange={(e) => setNewSsLabel(e.target.value)}
              placeholder="npr. Ø6mm / klasa 8.8"
            />
          </FormField>
        )}

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Oznaka" required>
            <input className={INPUT} value={oznaka} onChange={(e) => setOznaka(e.target.value)} />
          </FormField>
          <FormField label="Naziv" required>
            <input className={INPUT} value={naziv} onChange={(e) => setNaziv(e.target.value)} />
          </FormField>
          <FormField label="Serijski broj">
            <input className={INPUT} value={serial} onChange={(e) => setSerial(e.target.value)} />
          </FormField>
          <FormField label="Datum kupovine">
            <input className={INPUT} type="date" value={datum} onChange={(e) => setDatum(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Napomena">
          <textarea
            className={INPUT}
            rows={2}
            value={napomena}
            onChange={(e) => setNapomena(e.target.value)}
          />
        </FormField>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={isQty} onChange={(e) => setIsQty(e.target.checked)} />
          Količinska stavka (jedan barkod = više komada; može se zaduživati više puta)
        </label>

        {isQty && (
          <div className="space-y-3 rounded-control border border-line p-3">
            <div className="grid grid-cols-3 gap-3">
              <FormField label="Ukupna količina">
                <input
                  className={INPUT}
                  type="number"
                  min={0}
                  value={totalQty}
                  onChange={(e) => setTotalQty(Math.max(0, Number(e.target.value) || 0))}
                />
              </FormField>
              <FormField label="Min. zaliha">
                <input
                  className={INPUT}
                  type="number"
                  min={0}
                  value={minStock}
                  placeholder="—"
                  onChange={(e) => setMinStock(e.target.value)}
                />
              </FormField>
              <FormField label="Max. zaliha">
                <input
                  className={INPUT}
                  type="number"
                  min={0}
                  value={maxStock}
                  placeholder="—"
                  onChange={(e) => setMaxStock(e.target.value)}
                />
              </FormField>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent)]"
                checked={isConsumable}
                onChange={(e) => setIsConsumable(e.target.checked)}
              />
              Potrošna stavka (troši se, ne očekuje se povraćaj — npr. burgije, ploče, rukavice)
            </label>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={printLbl}
            onChange={(e) => setPrintLbl(e.target.checked)}
          />
          Odmah odštampaj nalepnicu (ALAT-…)
        </label>

        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

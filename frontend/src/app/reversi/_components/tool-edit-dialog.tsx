'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { toast } from '@/lib/toast';
import { useInventoryTree, useUpdateTool, type ReversiToolDetail } from '@/api/reversi';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

function dateOnly(v: string | null | undefined): string {
  return v ? String(v).slice(0, 10) : '';
}

/**
 * Modal „Izmena artikla" (RB-11) — PATCH rev_tools sa kaskadom Grupa → Podgrupa →
 * Podpodgrupa. Paritet 1.0 `reversiToolDetail.js` edit modal. Prazna polja se šalju
 * kao `null` (BE briše klasifikaciju/serijski/datum/garanciju/punjač). Otvara se iz
 * kartice alata (manage + aktivan).
 */
export function ToolEditDialog({
  open,
  tool,
  onClose,
}: {
  open: boolean;
  tool: ReversiToolDetail | null;
  onClose: () => void;
}) {
  const tree = useInventoryTree();
  const update = useUpdateTool();

  const [oznaka, setOznaka] = useState('');
  const [naziv, setNaziv] = useState('');
  const [groupId, setGroupId] = useState('');
  const [subgroupId, setSubgroupId] = useState('');
  const [subsubgroupId, setSubsubgroupId] = useState('');
  const [serial, setSerial] = useState('');
  const [datum, setDatum] = useState('');
  const [nabavna, setNabavna] = useState('');
  const [garancijaDo, setGarancijaDo] = useState('');
  const [garancijaNapomena, setGarancijaNapomena] = useState('');
  const [imaPunjac, setImaPunjac] = useState(false);
  const [punjacSerijski, setPunjacSerijski] = useState('');
  const [napomena, setNapomena] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  // Inicijalizuj iz alata pri otvaranju / promeni alata (grupa se izvodi iz podgrupe).
  useEffect(() => {
    if (!open || !tool) return;
    setOznaka(tool.oznaka ?? '');
    setNaziv(tool.naziv ?? '');
    const sg = subgroups.find((s) => s.id === tool.subgroupId);
    setGroupId(sg?.groupId ?? '');
    setSubgroupId(tool.subgroupId ?? '');
    setSubsubgroupId(tool.subsubgroupId ?? '');
    setSerial(tool.serijskiBroj ?? '');
    setDatum(dateOnly(tool.datumKupovine));
    setNabavna(tool.nabavnaVrednost != null ? String(tool.nabavnaVrednost) : '');
    setGarancijaDo(dateOnly(tool.garancijaDo));
    setGarancijaNapomena(tool.garancijaNapomena ?? '');
    setImaPunjac(!!tool.imaPunjac);
    setPunjacSerijski(tool.punjacSerijski ?? '');
    setNapomena(tool.napomena ?? '');
    setError(null);
  }, [open, tool, subgroups]);

  const visibleSubgroups = useMemo(
    () => (groupId ? subgroups.filter((s) => s.groupId === groupId) : subgroups),
    [subgroups, groupId],
  );
  const visibleSubsubs = useMemo(
    () => (subgroupId ? subsubgroups.filter((s) => s.subgroupId === subgroupId) : []),
    [subsubgroups, subgroupId],
  );

  function onGroupChange(v: string) {
    setGroupId(v);
    setSubgroupId('');
    setSubsubgroupId('');
  }
  function onSubgroupChange(v: string) {
    setSubgroupId(v);
    setSubsubgroupId('');
  }

  async function submit() {
    setError(null);
    const oz = oznaka.trim();
    const nz = naziv.trim();
    if (!oz || !nz) {
      setError('Oznaka i naziv su obavezni.');
      return;
    }
    if (!tool) return;
    try {
      await update.mutateAsync({
        id: tool.id,
        patch: {
          oznaka: oz,
          naziv: nz,
          subgroupId: subgroupId || null,
          subsubgroupId: subsubgroupId || null,
          serijskiBroj: serial.trim() || null,
          datumKupovine: datum || null,
          nabavnaVrednost: nabavna.trim() === '' ? null : Number(nabavna),
          garancijaDo: garancijaDo || null,
          garancijaNapomena: garancijaNapomena.trim() || null,
          imaPunjac,
          punjacSerijski: imaPunjac ? punjacSerijski.trim() || null : null,
          napomena: napomena.trim() || null,
        },
      });
      toast('Artikal izmenjen');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Izmena nije uspela.');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Izmena artikla"
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button loading={update.isPending} onClick={() => void submit()}>
            Sačuvaj izmene
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Oznaka" required>
            <input className={INPUT} value={oznaka} onChange={(e) => setOznaka(e.target.value)} />
          </FormField>
          <FormField label="Naziv" required>
            <input className={INPUT} value={naziv} onChange={(e) => setNaziv(e.target.value)} />
          </FormField>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <FormField label="Grupa">
            <select className={INPUT} value={groupId} onChange={(e) => onGroupChange(e.target.value)}>
              <option value="">— (bez) —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Podgrupa">
            <select className={INPUT} value={subgroupId} onChange={(e) => onSubgroupChange(e.target.value)}>
              <option value="">— (nesvrstano) —</option>
              {visibleSubgroups.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Podpodgrupa">
            <select
              className={INPUT}
              value={subsubgroupId}
              disabled={!subgroupId || visibleSubsubs.length === 0}
              onChange={(e) => setSubsubgroupId(e.target.value)}
            >
              <option value="">— (bez) —</option>
              {visibleSubsubs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Serijski broj">
            <input className={INPUT} value={serial} onChange={(e) => setSerial(e.target.value)} />
          </FormField>
          <FormField label="Datum kupovine">
            <input className={INPUT} type="date" value={datum} onChange={(e) => setDatum(e.target.value)} />
          </FormField>
          <FormField label="Nabavna vrednost">
            <input
              className={INPUT}
              type="number"
              min={0}
              step="0.01"
              value={nabavna}
              onChange={(e) => setNabavna(e.target.value)}
            />
          </FormField>
          <FormField label="Garancija do">
            <input
              className={INPUT}
              type="date"
              value={garancijaDo}
              onChange={(e) => setGarancijaDo(e.target.value)}
            />
          </FormField>
        </div>

        <FormField label="Garancija — napomena">
          <input
            className={INPUT}
            value={garancijaNapomena}
            onChange={(e) => setGarancijaNapomena(e.target.value)}
          />
        </FormField>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={imaPunjac}
            onChange={(e) => setImaPunjac(e.target.checked)}
          />
          Ima punjač
        </label>
        {imaPunjac && (
          <FormField label="Serijski broj punjača">
            <input
              className={INPUT}
              value={punjacSerijski}
              onChange={(e) => setPunjacSerijski(e.target.value)}
            />
          </FormField>
        )}

        <FormField label="Napomena">
          <textarea
            className={INPUT}
            rows={2}
            value={napomena}
            onChange={(e) => setNapomena(e.target.value)}
          />
        </FormField>

        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

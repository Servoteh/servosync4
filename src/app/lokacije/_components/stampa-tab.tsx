'use client';

import { useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { buildTspLabelProgram, buildTspShelfLabelProgram } from '@/lib/tspl2';
import { labelDate } from '@/lib/label-print';
import { SHELF_TYPES, useAllLocations, usePrintLocLabel, type LocLocation } from '@/api/lokacije';
import { buildLocIndex, tableEmpty } from './common';
import { formatRnzBarcode, shelfBarcodeValue } from './label-build';

const INPUT = 'h-9 w-full rounded-control border border-line bg-surface-2 px-2.5 text-sm text-ink outline-none focus:border-accent';

/** Štampa nalepnica — police (batch, LP: kompozit) + pojedinačna TP nalepnica (RNZ). */
export function StampaTab() {
  const print = usePrintLocLabel();
  const locs = useAllLocations('true');
  const locList = useMemo<LocLocation[]>(() => locs.data ?? [], [locs.data]);
  const locIndex = useMemo(() => buildLocIndex(locList), [locList]);

  const shelves = useMemo(
    () => locList.filter((l) => SHELF_TYPES.includes(l.locationType)),
    [locList],
  );

  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copies, setCopies] = useState('1');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return shelves.slice(0, 300);
    return shelves.filter((l) => l.locationCode.toLowerCase().includes(s) || l.pathCached.toLowerCase().includes(s)).slice(0, 300);
  }, [shelves, q]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function printShelves() {
    setMsg(null);
    const chosen = shelves.filter((l) => selected.has(l.id));
    if (chosen.length === 0) return setMsg('Izaberi bar jednu policu.');
    const n = Math.max(1, Math.floor(Number(copies) || 1));
    setBusy(true);
    let ok = 0;
    try {
      for (const sh of chosen) {
        const hall = locIndex.hallOf(sh.id);
        const bc = shelfBarcodeValue(sh.id, hall?.id) || sh.locationCode;
        const tspl2 = buildTspShelfLabelProgram({ barcodeValue: bc, footline: sh.locationCode, codeType: 'barcode', copies: n });
        await print.mutateAsync({ tspl2, copies: n });
        ok += 1;
      }
      setMsg(`Poslato ${ok} / ${chosen.length} nalepnica polica na štampač.`);
      setSelected(new Set());
    } catch (e) {
      setMsg(`Štampano ${ok} / ${chosen.length}. Greška: ${e instanceof Error ? e.message : 'nepoznata'}`);
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<LocLocation>[] = [
    {
      key: 'sel',
      header: '',
      render: (r) => (
        <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} onClick={(e) => e.stopPropagation()} aria-label={`Izaberi ${r.locationCode}`} />
      ),
    },
    { key: 'code', header: 'Šifra', render: (r) => <span className="font-medium">{r.locationCode}</span> },
    { key: 'hall', header: 'Hala', render: (r) => locIndex.hallOf(r.id)?.locationCode ?? '—' },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-md font-semibold text-ink">Nalepnice polica</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${INPUT} max-w-64`} placeholder="Pretraga polica…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
            Kopija <input className={`${INPUT} w-20`} type="number" min={1} value={copies} onChange={(e) => setCopies(e.target.value)} />
          </label>
          <span className="text-sm text-ink-secondary tnums">{selected.size} izabrano</span>
          <Button className="ml-auto" loading={busy} onClick={() => void printShelves()} disabled={selected.size === 0}>
            <Printer className="h-4 w-4" /> Štampaj police
          </Button>
        </div>
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          onRowActivate={(r) => toggle(r.id)}
          loading={locs.isLoading}
          empty={tableEmpty(locs.isError, 'Nema polica', 'Nema aktivnih polica za štampu.')}
        />
        {msg && <p className="text-sm text-ink-secondary">{msg}</p>}
      </section>

      <ManualTpLabel />
    </div>
  );
}

/** Pojedinačna TP nalepnica iz ručno unetog naloga/TP (RNZ barkod). */
function ManualTpLabel() {
  const print = usePrintLocLabel();
  const [orderNo, setOrderNo] = useState('');
  const [tpNo, setTpNo] = useState('');
  const [drawingNo, setDrawingNo] = useState('');
  const [nazivDela, setNazivDela] = useState('');
  const [copies, setCopies] = useState('1');
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setMsg(null);
    const bc = formatRnzBarcode({ orderNo, tpNo });
    if (!bc) return setMsg('Unesi ispravan nalog i TP (RNZ barkod se ne može sastaviti).');
    const n = Math.max(1, Math.floor(Number(copies) || 1));
    const tspl2 = buildTspLabelProgram({
      fields: { brojPredmeta: orderNo, nazivDela, brojCrteza: drawingNo, kolicina: '', datum: labelDate() },
      barcodeValue: bc,
      copies: n,
    });
    try {
      await print.mutateAsync({ tspl2, copies: n });
      setMsg('Nalepnica TP poslata na štampač.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Štampa nije uspela.');
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-md font-semibold text-ink">Pojedinačna TP nalepnica</h3>
      <div className="grid max-w-2xl grid-cols-2 gap-3">
        <FormField label="Broj naloga" required>
          <input className={INPUT} value={orderNo} onChange={(e) => setOrderNo(e.target.value)} placeholder="npr. 7351" />
        </FormField>
        <FormField label="TP ref" required>
          <input className={INPUT} value={tpNo} onChange={(e) => setTpNo(e.target.value)} placeholder="npr. 2/415" />
        </FormField>
        <FormField label="Broj crteža">
          <input className={INPUT} value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} />
        </FormField>
        <FormField label="Naziv dela">
          <input className={INPUT} value={nazivDela} onChange={(e) => setNazivDela(e.target.value)} />
        </FormField>
        <FormField label="Kopija">
          <input className={`${INPUT} w-24`} type="number" min={1} value={copies} onChange={(e) => setCopies(e.target.value)} />
        </FormField>
      </div>
      <Button loading={print.isPending} onClick={() => void submit()}>
        <Printer className="h-4 w-4" /> Štampaj TP
      </Button>
      {msg && <p className="text-sm text-ink-secondary">{msg}</p>}
    </section>
  );
}

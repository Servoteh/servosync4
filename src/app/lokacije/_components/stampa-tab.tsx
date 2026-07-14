'use client';

import { useEffect, useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { buildTspLabelProgram, buildTspShelfLabelProgram } from '@/lib/tspl2';
import { labelDate } from '@/lib/label-print';
import {
  SHELF_TYPES,
  useAllLocations,
  usePrintLocLabel,
  usePredmetTps,
  type LocLocation,
  type PredmetTpRow,
} from '@/api/lokacije';
import { usePredmetiLookup, type PredmetLookup } from '@/api/plan-montaze';
import { buildLocIndex, tableEmpty } from './common';
import { formatRnzBarcode, shelfPrintBarcode } from './label-build';
import {
  printShelfLabelsToBrowserWindow,
  printTechProcessLabelsBatch,
  SHELF_FORMAT_OPTIONS,
  TIP_OPERACIJE_MAP,
  type ShelfCodeType,
  type ShelfLabelFormat,
  type ShelfLabelInput,
  type TechLabelSpec,
} from './labels-print-window';

const INPUT = 'h-9 w-full rounded-control border border-line bg-surface-2 px-2.5 text-sm text-ink outline-none focus:border-accent';

// Police (SHELF/RACK/BIN) + kavezi (CAGE) se štampaju (paritet 1.0). Hale/mašine
// nemaju fizičku nalepnicu ovog tipa.
const HALL_TYPE_SET = new Set(['WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP']);
const KV_CODE_RE = /^KV \d+$/i;

/** Kavez u podacima: tip CAGE ili legacy „KV N" šifra (paritet 1.0 isCageLocation). */
function isCage(l: LocLocation): boolean {
  return l.locationType === 'CAGE' || KV_CODE_RE.test(String(l.locationCode ?? '').trim());
}
function isHall(l: LocLocation): boolean {
  return HALL_TYPE_SET.has(l.locationType);
}
/** Na nalepnici kaveza — samo broj (bez prefiksa KV; paritet 1.0 cagePrintCode). */
function cageNumber(code: string | null | undefined): string {
  const m = String(code ?? '').trim().match(/^KV (\d+)$/i);
  return m ? m[1] : String(code ?? '').trim();
}
function compareCode(a: string, b: string): number {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
}

/** Redosled za listu/štampu: kavezi (po broju) pre polica (po šifri). Paritet 1.0. */
function compareShelfPick(a: LocLocation, b: LocLocation): number {
  const ca = isCage(a);
  const cb = isCage(b);
  if (ca !== cb) return ca ? -1 : 1;
  if (ca && cb) return (Number(cageNumber(a.locationCode)) || 0) - (Number(cageNumber(b.locationCode)) || 0);
  return compareCode(a.locationCode, b.locationCode);
}

type PickKind = 'all' | 'shelves' | 'cages';

/** Štampa nalepnica — police/kavezi (6 formata: A4/TopStick + TSC) + batch TP (RNZ, sa TIP). */
export function StampaTab() {
  const print = usePrintLocLabel();
  // 'all' (uklj. neaktivne) — potrebni su i neaktivni kavezi (opcija ispod).
  const locs = useAllLocations('all');
  const locList = useMemo<LocLocation[]>(() => locs.data ?? [], [locs.data]);
  const locIndex = useMemo(() => buildLocIndex(locList), [locList]);

  const [pickKind, setPickKind] = useState<PickKind>('all');
  const [hallId, setHallId] = useState('');
  const [includeInactiveCages, setIncludeInactiveCages] = useState(true);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<ShelfLabelFormat>('a4-105x48');
  const [withBarcode, setWithBarcode] = useState(false);
  const [codeType, setCodeType] = useState<ShelfCodeType>('barcode');
  const [copies, setCopies] = useState('1');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const halls = useMemo(
    () => locList.filter((l) => isHall(l) && l.isActive !== false).slice().sort((a, b) => compareCode(a.locationCode, b.locationCode)),
    [locList],
  );

  // Kandidati: aktivne police + kavezi (aktivni ili svi, po opciji). Paritet 1.0 buildShelfLabelCandidates.
  const candidates = useMemo(
    () =>
      locList.filter((l) => {
        if (isCage(l)) return l.isActive !== false || includeInactiveCages;
        if ((SHELF_TYPES as readonly string[]).includes(l.locationType)) return l.isActive !== false;
        return false;
      }),
    [locList, includeInactiveCages],
  );

  const cagesOnly = pickKind === 'cages';
  const shelvesNeedHall = pickKind === 'shelves' && !hallId;

  // Bazen (bez pretrage) — kavezi bez hale; police tek uz izabranu halu (paritet 1.0).
  const rows = useMemo(() => {
    if (shelvesNeedHall) return [];
    let pool: LocLocation[];
    if (pickKind === 'cages') {
      pool = candidates.filter(isCage);
    } else if (pickKind === 'shelves') {
      pool = candidates.filter((l) => !isCage(l) && locIndex.hallOf(l.id)?.id === hallId);
    } else {
      const cages = candidates.filter(isCage);
      const shelves = hallId ? candidates.filter((l) => !isCage(l) && locIndex.hallOf(l.id)?.id === hallId) : [];
      pool = [...cages, ...shelves];
    }
    pool = pool.slice().sort(compareShelfPick);
    const s = q.trim().toLowerCase();
    if (!s) return pool;
    return pool.filter(
      (l) =>
        String(l.locationCode ?? '').toLowerCase().includes(s) ||
        String(l.name ?? '').toLowerCase().includes(s) ||
        String(l.pathCached ?? '').toLowerCase().includes(s),
    );
  }, [candidates, pickKind, hallId, q, locIndex, shelvesNeedHall]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Šifra + vrednost koja se koduje (kavez → broj/„KV N"; polica → HALA-POLICA). Paritet 1.0. */
  function prepShelfLabel(l: LocLocation): ShelfLabelInput {
    if (isCage(l)) {
      return { id: l.id, shelfCode: cageNumber(l.locationCode), barcodeValue: String(l.locationCode ?? '').trim() };
    }
    const hall = locIndex.hallOf(l.id);
    const { barcodeValue } = shelfPrintBarcode({ id: l.id, locationCode: l.locationCode }, hall);
    return { id: l.id, shelfCode: l.locationCode, barcodeValue };
  }

  async function doPrint() {
    setMsg(null);
    const chosen = candidates.filter((l) => selected.has(l.id)).slice().sort(compareShelfPick);
    if (chosen.length === 0) return setMsg('Izaberi bar jednu policu ili kavez.');
    const n = Math.max(1, Math.floor(Number(copies) || 1));

    if (format === 'tsc') {
      // POSTOJEĆI TSC put — backend TSPL2 (buildTspShelfLabelProgram → usePrintLocLabel).
      setBusy(true);
      let ok = 0;
      try {
        for (const sh of chosen) {
          const { shelfCode, barcodeValue } = prepShelfLabel(sh);
          const tspl2 = buildTspShelfLabelProgram({
            barcodeValue,
            footline: shelfCode,
            codeType: withBarcode ? codeType : 'barcode',
            copies: n,
          });
          await print.mutateAsync({ tspl2, copies: n });
          ok += 1;
        }
        setMsg(`Poslato ${ok} / ${chosen.length} nalepnica na TSC termalni štampač.`);
        setSelected(new Set());
      } catch (e) {
        setMsg(`Poslato ${ok} / ${chosen.length}. Greška: ${e instanceof Error ? e.message : 'nepoznata'}`);
      } finally {
        setBusy(false);
      }
      return;
    }

    // A4 / široki formati — pregled u novom prozoru + Ctrl+P (fizička štampa).
    setBusy(true);
    try {
      const items = chosen.map(prepShelfLabel);
      const res = await printShelfLabelsToBrowserWindow(items, { format, codeType, copies: n, withBarcode });
      if (!res.ok) {
        setMsg(
          res.reason === 'popup_blocked'
            ? 'Dozvoli pop-up prozore da bi se otvorio pregled za štampu.'
            : res.reason === 'empty'
              ? 'Nema nalepnica za štampu.'
              : `Greška pri pripremi pregleda: ${res.reason}`,
        );
      } else {
        setMsg(`Otvoren pregled: ${chosen.length} × ${n} = ${chosen.length * n} nalepnica. Štampaj iz prozora (Ctrl + P).`);
      }
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<LocLocation>[] = [
    {
      key: 'sel',
      header: '',
      render: (r) => (
        <input
          type="checkbox"
          checked={selected.has(r.id)}
          onChange={() => toggle(r.id)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Izaberi ${r.locationCode}`}
        />
      ),
    },
    { key: 'code', header: 'Šifra', render: (r) => <span className="font-medium">{isCage(r) ? `KV ${cageNumber(r.locationCode)}` : r.locationCode}</span> },
    { key: 'hall', header: 'Hala', render: (r) => locIndex.hallOf(r.id)?.locationCode ?? '—' },
    { key: 'preview', header: 'Kod (za sken)', render: (r) => <span className="text-xs text-ink-secondary">{prepShelfLabel(r).barcodeValue}</span> },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
  ];

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="text-md font-semibold text-ink">Nalepnice polica i kaveza</h3>

        {/* Struktuiran izbor (paritet 1.0: tip + hala + neaktivni + pretraga). */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-ink-secondary">
            <span className="mb-1 block">Tip lokacije</span>
            <select
              className={`${INPUT} w-52`}
              value={pickKind}
              onChange={(e) => {
                const v = e.target.value as PickKind;
                setPickKind(v);
                if (v === 'cages') setHallId('');
              }}
            >
              <option value="all">Sve (police + kavezi)</option>
              <option value="shelves">Samo police</option>
              <option value="cages">Samo kavezi (1…X)</option>
            </select>
          </label>
          <label className="text-sm text-ink-secondary">
            <span className="mb-1 block">Hala {cagesOnly ? '(nije za kaveze)' : '(za police)'}</span>
            <select className={`${INPUT} w-56`} value={hallId} disabled={cagesOnly} onChange={(e) => setHallId(e.target.value)}>
              <option value="">— izaberi halu —</option>
              {halls.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.locationCode} — {h.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-ink-secondary">
            <input type="checkbox" checked={includeInactiveCages} onChange={(e) => setIncludeInactiveCages(e.target.checked)} />
            Uključi neaktivne kaveze
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input className={`${INPUT} max-w-64`} placeholder="Pretraga (šifra / naziv / putanja)…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button variant="secondary" onClick={() => setSelected(new Set([...selected, ...rows.map((r) => r.id)]))} disabled={rows.length === 0}>
            Označi sve prikazane
          </Button>
          <Button variant="secondary" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            Očisti izbor
          </Button>
          <span className="text-sm text-ink-secondary tnums">{selected.size} izabrano</span>
        </div>

        {/* Format + kod + kopije + štampa. */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-ink-secondary">
            <span className="mb-1 block">Format</span>
            <select className={`${INPUT} w-96 max-w-full`} value={format} onChange={(e) => setFormat(e.target.value as ShelfLabelFormat)}>
              {SHELF_FORMAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-ink-secondary" title="Isključeno = samo šifra police (krupan glif bez barkoda).">
            <input type="checkbox" checked={withBarcode} onChange={(e) => setWithBarcode(e.target.checked)} />
            Sa barkodom / QR (za sken)
          </label>
          <label className="text-sm text-ink-secondary" style={{ opacity: withBarcode ? 1 : 0.45 }}>
            <span className="mb-1 block">Tip koda</span>
            <select className={`${INPUT} w-32`} value={codeType} disabled={!withBarcode} onChange={(e) => setCodeType(e.target.value as ShelfCodeType)}>
              <option value="barcode">Barkod</option>
              <option value="qr">QR kod</option>
            </select>
          </label>
          <label className="text-sm text-ink-secondary">
            <span className="mb-1 block">Kopija po lokaciji</span>
            <input className={`${INPUT} w-24`} type="number" min={1} value={copies} onChange={(e) => setCopies(e.target.value)} />
          </label>
          <Button className="mb-0.5" loading={busy} onClick={() => void doPrint()} disabled={selected.size === 0}>
            <Printer className="h-4 w-4" /> {format === 'tsc' ? 'Štampaj (TSC)' : 'Pregled i štampa'}
          </Button>
        </div>

        <p className="text-xs text-ink-secondary">
          Podrazumevano: <strong>krupna šifra</strong> na A4 TopStick 8715 (105×48 mm, 12 po listu). Za sken uključi barkod/QR.
          {' '}
          Kavezi: <strong>samo broj</strong> (barkod nosi punu šifru „KV N"). A4 formati se štampaju iz pregleda kroz pregledač (Ctrl + P).
        </p>

        {shelvesNeedHall && (
          <p className="text-sm text-ink-secondary">Izaberi halu — police se listaju A–Z samo unutar izabrane hale.</p>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowActivate={(r) => toggle(r.id)}
          loading={locs.isLoading}
          empty={tableEmpty(
            locs.isError,
            shelvesNeedHall ? 'Izaberi halu' : 'Nema polica/kaveza',
            shelvesNeedHall ? 'Police se prikazuju tek kad izabereš halu iznad.' : 'Nema stavki za izabrane filtere.',
          )}
        />
        {msg && <p className="text-sm text-ink-secondary">{msg}</p>}
      </section>

      <ManualTpLabel />

      <BatchTpLabels />
    </div>
  );
}

/** Pojedinačna TP nalepnica iz ručno unetog naloga/TP (RNZ barkod) — TSC termalni. */
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
      <h3 className="text-md font-semibold text-ink">Pojedinačna TP nalepnica (TSC)</h3>
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

/* ── Batch TP nalepnice iz BigTehn keša (paritet 1.0 labelsPrintPage) ──── */

type TipOperacije = '' | 'S' | 'O' | 'Z';

interface QueueEntry {
  predmet: PredmetLookup;
  tp: PredmetTpRow;
  qty: number;
  tip: TipOperacije;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function tpKey(predmetId: number, tp: PredmetTpRow): string {
  return `${predmetId}:${tp.work_order_id ?? tp.tp_no ?? ''}`;
}

/**
 * Batch TP: predmet (BigTehn lookup) → tehnološki postupci → red za štampu.
 * Svaka stavka nosi količinu + TIP operacije (S/O/Z → SKLOP/OBRADA/ZAVARIVANJE).
 * Štampa ide kroz pregledač (80×38 mm po nalepnici, barkod = CODE128 RNZ).
 */
function BatchTpLabels() {
  const [predmetQ, setPredmetQ] = useState('');
  const dq = useDebounced(predmetQ, 250);
  const lookup = usePredmetiLookup(dq, false);
  const predmeti = useMemo<PredmetLookup[]>(() => lookup.data?.data ?? [], [lookup.data]);

  const [focused, setFocused] = useState<PredmetLookup | null>(null);
  const tps = usePredmetTps(focused ? String(focused.id) : null, { onlyOpen: false, pageSize: 500 });
  const tpRows = useMemo<PredmetTpRow[]>(() => tps.data?.data.rows ?? [], [tps.data]);

  const [queue, setQueue] = useState<Map<string, QueueEntry>>(new Map());
  const [msg, setMsg] = useState<string | null>(null);

  function toggleTp(tp: PredmetTpRow) {
    if (!focused) return;
    const k = tpKey(focused.id, tp);
    setQueue((prev) => {
      const next = new Map(prev);
      if (next.has(k)) next.delete(k);
      else next.set(k, { predmet: focused, tp, qty: 1, tip: '' });
      return next;
    });
  }
  function addAllVisibleTps() {
    if (!focused) return;
    setQueue((prev) => {
      const next = new Map(prev);
      for (const tp of tpRows) {
        const k = tpKey(focused.id, tp);
        if (!next.has(k)) next.set(k, { predmet: focused, tp, qty: 1, tip: '' });
      }
      return next;
    });
  }
  function patchEntry(k: string, patch: Partial<QueueEntry>) {
    setQueue((prev) => {
      const next = new Map(prev);
      const cur = next.get(k);
      if (cur) next.set(k, { ...cur, ...patch });
      return next;
    });
  }
  function removeEntry(k: string) {
    setQueue((prev) => {
      const next = new Map(prev);
      next.delete(k);
      return next;
    });
  }

  const entries = useMemo(() => Array.from(queue.entries()), [queue]);
  const totalLabels = entries.reduce((s, [, e]) => s + (Number(e.qty) || 0), 0);

  function runBatchPrint() {
    setMsg(null);
    const specs: TechLabelSpec[] = [];
    const skipped: string[] = [];
    const datum = labelDate();
    for (const [, e] of entries) {
      const idb = String(e.tp.wo_ident_broj ?? '').trim();
      const slash = idb.indexOf('/');
      const orderPart = slash >= 0 ? idb.slice(0, slash) : idb;
      const tpPart = slash >= 0 ? idb.slice(slash + 1) : (e.tp.tp_no != null ? String(e.tp.tp_no) : '');
      const bc = formatRnzBarcode({ orderNo: orderPart, tpNo: tpPart });
      if (!bc) {
        skipped.push(idb || `tp#${e.tp.work_order_id ?? '?'}`);
        continue;
      }
      const komada = Number(e.tp.komada_rn) || e.qty;
      specs.push({
        barcodeValue: bc,
        copies: e.qty,
        fields: {
          brojPredmeta: idb || e.predmet.broj_predmeta,
          komitent: e.predmet.customer_name ?? '',
          nazivPredmeta: e.predmet.naziv_predmeta ?? '',
          nazivDela: String(e.tp.naziv_dela ?? ''),
          brojCrteza: String(e.tp.wo_broj_crteza ?? ''),
          materijal: [e.tp.materijal, e.tp.dimenzija_materijala].filter(Boolean).join(' '),
          kolicina: `${e.qty}/${komada}`,
          datum,
          tipOperacije: e.tip,
        },
      });
    }
    if (!specs.length) {
      setMsg(`Ni jedan TP nema validan RNZ barkod (preskočeno: ${skipped.length}).`);
      return;
    }
    const res = printTechProcessLabelsBatch(specs);
    if (!res.ok) {
      setMsg(res.reason === 'popup_blocked' ? 'Dozvoli pop-up prozore da bi se otvorio pregled za štampu.' : `Greška: ${res.reason}`);
      return;
    }
    const totalOtisak = specs.reduce((s, x) => s + (x.copies ?? 1), 0);
    setMsg(
      `Otvoren pregled: ${specs.length} TP, ukupno ${totalOtisak} nalepnica.` +
        (skipped.length ? ` Preskočeno bez barkoda: ${skipped.length}.` : ''),
    );
  }

  const predmetColumns: Column<PredmetLookup>[] = [
    { key: 'code', header: 'Predmet', render: (r) => <span className="font-medium">{r.broj_predmeta}</span> },
    { key: 'naz', header: 'Naziv', render: (r) => String(r.naziv_predmeta ?? '—').slice(0, 60) },
    { key: 'cust', header: 'Komitent', render: (r) => r.customer_name ?? '—' },
    { key: 'ug', header: 'Ugovor / NAR', render: (r) => [r.broj_ugovora, r.broj_narudzbenice].filter(Boolean).join(' · ') || '—' },
  ];

  const tpColumns: Column<PredmetTpRow>[] = [
    {
      key: 'sel',
      header: '',
      render: (r) =>
        focused ? (
          <input
            type="checkbox"
            checked={queue.has(tpKey(focused.id, r))}
            onChange={() => toggleTp(r)}
            onClick={(e) => e.stopPropagation()}
            aria-label="Dodaj TP u red za štampu"
          />
        ) : null,
    },
    { key: 'ident', header: 'RN (ident)', render: (r) => <span className="font-medium">{r.wo_ident_broj ?? '—'}</span> },
    { key: 'crtez', header: 'Crtež', render: (r) => r.wo_broj_crteza ?? '—' },
    { key: 'naziv', header: 'Naziv dela', render: (r) => String(r.naziv_dela ?? '—').slice(0, 60) },
    { key: 'kom', header: 'Komada', align: 'right', numeric: true, render: (r) => (r.komada_rn != null ? String(r.komada_rn) : '—') },
    { key: 'mat', header: 'Materijal', render: (r) => String(r.materijal ?? '—') },
  ];

  const queueColumns: Column<[string, QueueEntry]>[] = [
    { key: 'predmet', header: 'Predmet', render: ([, e]) => <span className="font-medium">{e.predmet.broj_predmeta}</span> },
    { key: 'rn', header: 'RN (ident)', render: ([, e]) => e.tp.wo_ident_broj ?? '—' },
    { key: 'naziv', header: 'Naziv dela', render: ([, e]) => String(e.tp.naziv_dela ?? '—').slice(0, 40) },
    {
      key: 'qty',
      header: 'Količina',
      align: 'right',
      render: ([k, e]) => (
        <input
          type="number"
          min={1}
          max={Number(e.tp.komada_rn) || 999}
          value={e.qty}
          onClick={(ev) => ev.stopPropagation()}
          onChange={(ev) => patchEntry(k, { qty: Math.max(1, Math.floor(Number(ev.target.value) || 1)) })}
          className={`${INPUT} w-20`}
        />
      ),
    },
    {
      key: 'tip',
      header: 'TIP operacije',
      render: ([k, e]) => (
        <select
          className={`${INPUT} w-40`}
          value={e.tip}
          onClick={(ev) => ev.stopPropagation()}
          onChange={(ev) => patchEntry(k, { tip: ev.target.value as TipOperacije })}
        >
          <option value="">— bez —</option>
          <option value="S">S · {TIP_OPERACIJE_MAP.S}</option>
          <option value="O">O · {TIP_OPERACIJE_MAP.O}</option>
          <option value="Z">Z · {TIP_OPERACIJE_MAP.Z}</option>
        </select>
      ),
    },
    {
      key: 'rm',
      header: '',
      align: 'right',
      render: ([k]) => (
        <Button variant="secondary" onClick={() => removeEntry(k)} aria-label="Ukloni iz reda">
          ✕
        </Button>
      ),
    },
  ];

  return (
    <section className="space-y-3">
      <h3 className="text-md font-semibold text-ink">Batch TP nalepnice iz BigTehn</h3>
      <p className="text-xs text-ink-secondary">
        Nađi predmet, otvori njegove tehnološke postupke, čekiraj TP-ove u red za štampu. TIP operacije (S/O/Z) štampa se krupno ispod barkoda.
      </p>

      <input
        className={`${INPUT} max-w-md`}
        placeholder="Pretraga predmeta (br. predmeta · naziv · ugovor · NAR)…"
        value={predmetQ}
        onChange={(e) => setPredmetQ(e.target.value)}
      />
      <DataTable
        columns={predmetColumns}
        rows={predmeti}
        rowKey={(r) => r.id}
        onRowActivate={(r) => setFocused(r)}
        expandedKey={focused?.id ?? null}
        loading={lookup.isLoading}
        empty={tableEmpty(lookup.isError, 'Nema predmeta', 'Ukucaj deo broja predmeta, naziva ili ugovora.')}
      />

      {focused && (
        <div className="space-y-2 rounded-panel border border-line bg-surface-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">
              Tehnološki postupci: {focused.broj_predmeta} · {focused.naziv_predmeta ?? ''}
            </span>
            <Button className="ml-auto" variant="secondary" onClick={addAllVisibleTps} disabled={tpRows.length === 0}>
              + Ubaci prikazane u red
            </Button>
          </div>
          <DataTable
            columns={tpColumns}
            rows={tpRows}
            rowKey={(r) => `${r.work_order_id}|${r.tp_no}`}
            onRowActivate={(r) => toggleTp(r)}
            loading={tps.isLoading}
            empty={tableEmpty(tps.isError, 'Nema tehnoloških postupaka', 'Za ovaj predmet nema TP-ova u BigTehn kešu.')}
          />
        </div>
      )}

      <h4 className="text-sm font-semibold text-ink">Red za štampu ({totalLabels} nalepnica · {entries.length} TP)</h4>
      <DataTable
        columns={queueColumns}
        rows={entries}
        rowKey={([k]) => k}
        empty={tableEmpty(false, 'Red je prazan', 'Čekiraj TP-ove u tabeli iznad da ih dodaš u red za štampu.')}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={runBatchPrint} disabled={entries.length === 0}>
          <Printer className="h-4 w-4" /> Pregled i štampa ({totalLabels})
        </Button>
        <Button variant="secondary" onClick={() => setQueue(new Map())} disabled={entries.length === 0}>
          Očisti red
        </Button>
      </div>
      {msg && <p className="text-sm text-ink-secondary">{msg}</p>}
    </section>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  newClientEventId,
  useCuttingTools,
  useReversiLocations,
  useReversiTool,
  useSeedCuttingStock,
  useStockDelta,
  useUpdateCuttingTool,
  useUpdateTool,
  type WarehouseRow,
} from '@/api/reversi';
import { ToolEditDialog } from './tool-edit-dialog';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/** Podrazumevani magacin reznog alata (paritet 1.0 BE default). */
const DEFAULT_WAREHOUSE_CODE = 'ALAT-MAG-01';

function num(v: number | null | undefined): number {
  return Number(v) || 0;
}

/**
 * Dijalog „Dopuna zalihe" (RA-37) — samo CUTTING red. Unos količine (min 1) + izbor
 * WAREHOUSE lokacije (default ALAT-MAG-01) sa validacijom „Izaberi lokaciju"; knjiži
 * kroz `seedCuttingToolStock` (rev_cutting_tool_seed_stock). Paritet 1.0 `openTopupDialog`.
 */
export function CuttingTopupDialog({ row, onClose }: { row: WarehouseRow; onClose: () => void }) {
  const seed = useSeedCuttingStock();
  const locations = useReversiLocations();
  const warehouses = useMemo(
    () => (locations.data?.data ?? []).filter((l) => l.location_type === 'WAREHOUSE'),
    [locations.data],
  );
  const defaultLoc = useMemo(
    () => warehouses.find((l) => l.location_code === DEFAULT_WAREHOUSE_CODE)?.id ?? '',
    [warehouses],
  );
  const [qty, setQty] = useState(1);
  const [locId, setLocId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Izabrana lokacija: eksplicitan izbor ima prednost, inače default magacin.
  const selectedLoc = locId || defaultLoc;

  async function submit() {
    setError(null);
    const q = Math.max(1, Math.floor(qty));
    if (!selectedLoc) {
      setError('Izaberi lokaciju');
      return;
    }
    try {
      await seed.mutateAsync({
        clientEventId: newClientEventId(),
        catalogId: row.item_id,
        locationId: selectedLoc,
        qty: q,
      });
      toast(`+${formatNumber(q)} ${row.unit || 'kom'} u magacinu`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dopuna nije uspela.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Dopuna zalihe — ${row.oznaka}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button loading={seed.isPending} onClick={() => void submit()}>
            Dopuni
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="text-sm">
          <strong>{row.naziv}</strong>{' '}
          <span className="text-ink-secondary">({row.barcode ?? '—'})</span>
        </div>
        <div className="text-sm text-ink-secondary">
          Trenutno u magacinu: <strong className="tnums">{formatNumber(num(row.in_warehouse_qty))}</strong>{' '}
          {row.unit || 'kom'}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Količina za dopunu">
            <input
              className={INPUT}
              type="number"
              min={1}
              step={1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </FormField>
          <FormField label="Lokacija">
            <select className={INPUT} value={selectedLoc} onChange={(e) => setLocId(e.target.value)}>
              <option value="">— izaberi —</option>
              {warehouses.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.location_code} {l.name ?? ''}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Dijalog „Zaliha" (RA-38) — prijem/otpis ručnog KOLIČINSKOG/potrošnog alata. Radio
 * Prijem(+)/Otpis(−), količina, opc. Min/Max zaliha, napomena. Validacije: Max<Min
 * blokira; otpis>stanje — potrošni SME u minus (upozorenje), nepotrošni blokira.
 * Knjiži RECEIPT/WRITE_OFF deltu (stock-delta) + PATCH min/max. Paritet 1.0
 * `openHandReceiptDialog`.
 */
export function HandStockDialog({ row, onClose }: { row: WarehouseRow; onClose: () => void }) {
  const stockDelta = useStockDelta();
  const updateTool = useUpdateTool();
  const onHand = num(row.qty_on_hand);
  const unit = row.unit || 'kom';
  const [mode, setMode] = useState<'RECEIPT' | 'WRITE_OFF'>('RECEIPT');
  const [qty, setQty] = useState(1);
  const [minVal, setMinVal] = useState(row.min_stock_qty == null ? '' : String(row.min_stock_qty));
  const [maxVal, setMaxVal] = useState(row.max_stock_qty == null ? '' : String(row.max_stock_qty));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isOtpis = mode === 'WRITE_OFF';
  const busy = stockDelta.isPending || updateTool.isPending;

  function parseOptInt(raw: string): number | null {
    if (raw.trim() === '') return null;
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  async function submit() {
    setError(null);
    const q = Math.max(0, Math.floor(qty));
    const newMin = parseOptInt(minVal);
    const newMax = parseOptInt(maxVal);
    if (newMin != null && newMax != null && newMax < newMin) {
      setError('Maksimum ne sme biti manji od minimuma.');
      return;
    }
    if (isOtpis && q > onHand) {
      // Potrošni SME u minus (ledger je izvor istine) — samo upozori; nepotrošni blokira.
      if (row.is_consumable === true) {
        toast(`⚠ Stanje ide u minus: ${onHand} → ${onHand - q} ${unit}`);
      } else {
        setError(`Ne možeš otpisati ${q} — na stanju je ${onHand} ${unit}.`);
        return;
      }
    }
    try {
      // 1) Min/max — patch samo ako se promenilo (null briše vrednost).
      const curMin = row.min_stock_qty == null ? null : Number(row.min_stock_qty);
      const curMax = row.max_stock_qty == null ? null : Number(row.max_stock_qty);
      if (newMin !== curMin || newMax !== curMax) {
        await updateTool.mutateAsync({
          id: row.item_id,
          patch: { minStockQty: newMin, maxStockQty: newMax },
        });
      }
      // 2) Prijem (+RECEIPT) ili otpis (−WRITE_OFF) kroz ledger.
      if (q > 0) {
        await stockDelta.mutateAsync({
          clientEventId: newClientEventId(),
          toolId: row.item_id,
          delta: isOtpis ? -q : q,
          reason: mode,
          note: note.trim() || undefined,
        });
        toast(isOtpis ? `−${q} ${unit} otpisano` : `+${q} ${unit} primljeno u magacin`);
      } else {
        toast('Min/max sačuvani');
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snimanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Zaliha — ${row.oznaka}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            {isOtpis ? 'Otpiši sa stanja' : 'Primi na stanje'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="text-sm">
          <strong>{row.naziv}</strong>{' '}
          <span className="text-ink-secondary">({row.barcode ?? '—'})</span>
        </div>
        <div className="text-sm text-ink-secondary">
          Trenutno na stanju: <strong className="tnums text-ink">{formatNumber(onHand)}</strong> {unit}
        </div>

        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              className="accent-[var(--accent)]"
              checked={mode === 'RECEIPT'}
              onChange={() => setMode('RECEIPT')}
            />
            Prijem (+)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              className="accent-[var(--accent)]"
              checked={mode === 'WRITE_OFF'}
              onChange={() => setMode('WRITE_OFF')}
            />
            Otpis (−)
          </label>
        </div>

        <FormField label={isOtpis ? 'Količina za otpis' : 'Količina za prijem'}>
          <input
            className={`${INPUT} w-40`}
            type="number"
            min={1}
            step={1}
            value={qty}
            onChange={(e) => setQty(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Min. zaliha (opciono)">
            <input
              className={INPUT}
              type="number"
              min={0}
              step={1}
              value={minVal}
              placeholder="—"
              onChange={(e) => setMinVal(e.target.value)}
            />
          </FormField>
          <FormField label="Max. zaliha (opciono)">
            <input
              className={INPUT}
              type="number"
              min={0}
              step={1}
              value={maxVal}
              placeholder="—"
              onChange={(e) => setMaxVal(e.target.value)}
            />
          </FormField>
        </div>

        <FormField label="Napomena (opciono)">
          <input
            className={INPUT}
            value={note}
            placeholder="npr. broj otpremnice / dobavljač"
            onChange={(e) => setNote(e.target.value)}
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

/**
 * Pregled reznog artikla iz magacina (RA-34 „oko" za CUTTING) — lagani modal iz
 * redova view-a (bez dodatnog poziva), paritet 1.0 `openCuttingToolDetailsModal`
 * (stanje po lokacijama je već u redu magacina). Puna kartica reznog stiže sa reznim
 * modulom (RC-*); ovde je magacionerski pregled šifre + stanja.
 */
export function CuttingDetailsDialog({ row, onClose }: { row: WarehouseRow; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${row.oznaka} — ${row.naziv}`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Zatvori
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Field label="Status">
          <StatusBadge tone="info" label="Rezni alat" />
        </Field>
        <Field label="Barkod">{row.barcode ?? '—'}</Field>
        <Field label="Klasa">{row.klasa ?? '—'}</Field>
        <Field label="Jedinica">{row.unit || 'kom'}</Field>
        <Field label="U magacinu">
          <span className="tnums">
            {formatNumber(num(row.in_warehouse_qty))} {row.unit || 'kom'}
          </span>
        </Field>
        <Field label="Lokacija">{row.location_label || row.location_code || '—'}</Field>
        <Field label="Min. zaliha">{row.min_stock_qty == null ? '—' : formatNumber(Number(row.min_stock_qty))}</Field>
        <Field label="Max. zaliha">{row.max_stock_qty == null ? '—' : formatNumber(Number(row.max_stock_qty))}</Field>
        {row.napomena && (
          <div className="col-span-2">
            <div className="text-xs text-ink-secondary">Napomena</div>
            <div className="text-ink">{row.napomena}</div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-ink-secondary">{label}</div>
      <div className="text-ink">{children}</div>
    </div>
  );
}

/**
 * „Izmena artikla" ručnog alata iz magacina (RA-34 „olovka" za HAND) — dovlači punu
 * karticu (`useReversiTool`) i otvara `ToolEditDialog` (kaskada grupa/podgrupa +
 * serijski/garancija/punjač). Paritet 1.0 `openItemEdit` (HAND grana).
 */
export function HandEditDialog({ toolId, onClose }: { toolId: string; onClose: () => void }) {
  const detail = useReversiTool(toolId);
  const t = detail.data?.data ?? null;
  return <ToolEditDialog open={!!t} tool={t} onClose={onClose} />;
}

/**
 * „Izmena šifre" reznog alata iz magacina (RA-34 „olovka" za CUTTING) — dovlači pun
 * red kataloga (`useCuttingTools` po oznaci → match po id) radi kompatibilnih mašina
 * i statusa, pa PATCH-uje naziv/jm/min. zaliha/mašine/napomena. Oznaka je nepromenljiva
 * (BE). Paritet 1.0 `openAddCuttingToolModal({tool})`.
 */
export function CuttingEditDialog({ row, onClose }: { row: WarehouseRow; onClose: () => void }) {
  const search = useCuttingTools(row.oznaka);
  const tool = useMemo(
    () => (search.data?.data ?? []).find((t) => t.id === row.item_id) ?? null,
    [search.data, row.item_id],
  );
  const update = useUpdateCuttingTool();

  const [naziv, setNaziv] = useState('');
  const [unit, setUnit] = useState('');
  const [minStock, setMinStock] = useState(0);
  const [machines, setMachines] = useState('');
  const [napomena, setNapomena] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inicijalizuj JEDNOM po dolasku podataka (bez pregaženja korisničkog unosa).
  if (tool && !ready) {
    setNaziv(tool.naziv ?? '');
    setUnit(tool.unit ?? 'kom');
    setMinStock(Number(tool.minStockQty) || 0);
    setMachines((tool.compatibleMachineCodes ?? []).join(', '));
    setNapomena(tool.napomena ?? '');
    setReady(true);
  }

  async function submit() {
    setError(null);
    if (!naziv.trim()) {
      setError('Naziv je obavezan.');
      return;
    }
    try {
      await update.mutateAsync({
        id: row.item_id,
        patch: {
          naziv: naziv.trim(),
          unit: unit.trim() || 'kom',
          minStockQty: Math.max(0, Math.floor(minStock)),
          compatibleMachineCodes: machines
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          napomena: napomena.trim() || null,
        },
      });
      toast('Šifra izmenjena');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Izmena nije uspela.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Izmena šifre — ${row.oznaka}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button loading={update.isPending} disabled={!tool} onClick={() => void submit()}>
            Sačuvaj
          </Button>
        </div>
      }
    >
      {search.isLoading && !tool ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : !tool ? (
        <p className="text-sm text-status-danger">Šifra nije pronađena u katalogu.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Oznaka (nepromenljiva)">
              <input className={`${INPUT} opacity-60`} value={row.oznaka} readOnly />
            </FormField>
            <FormField label="Jedinica">
              <input className={INPUT} value={unit} onChange={(e) => setUnit(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Naziv" required>
            <input className={INPUT} value={naziv} onChange={(e) => setNaziv(e.target.value)} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Min. zaliha">
              <input
                className={INPUT}
                type="number"
                min={0}
                value={minStock}
                onChange={(e) => setMinStock(Math.max(0, Number(e.target.value) || 0))}
              />
            </FormField>
            <FormField label="Mašine (šifre, zarezom)">
              <input
                className={INPUT}
                value={machines}
                placeholder="npr. M12, M15"
                onChange={(e) => setMachines(e.target.value)}
              />
            </FormField>
          </div>
          <FormField label="Napomena">
            <input className={INPUT} value={napomena} onChange={(e) => setNapomena(e.target.value)} />
          </FormField>
          {error && (
            <p className="text-sm text-status-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

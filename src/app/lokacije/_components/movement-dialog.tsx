'use client';

import { useMemo, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import {
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABEL,
  newClientEventUuid,
  useAllLocations,
  useCreateMovement,
  type LocLocation,
  type LocMovementType,
} from '@/api/lokacije';
import { LocationSelect } from './location-select';
import { normalizeLocMovementKeys } from './label-build';
import { ScanOverlay } from './scan-overlay';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

export interface MovementPreset {
  itemRefTable?: string;
  itemRefId?: string;
  orderNo?: string;
  drawingNo?: string;
  toLocationId?: string;
  fromLocationId?: string;
  movementType?: LocMovementType;
}

/** From-lokacija je nepotrebna za INITIAL_PLACEMENT / INVENTORY_ADJUSTMENT (paritet 1.0). */
function needsFrom(t: LocMovementType): boolean {
  return t !== 'INITIAL_PLACEMENT' && t !== 'INVENTORY_ADJUSTMENT';
}

/**
 * Brzo premeštanje — POST /locations/movements → loc_create_movement. 11 tipova
 * pokreta (select), stavka + od/do lokacije (skener ILI pretraga), količina,
 * razlog/napomena. Idempotency ključ (client_event_uuid) po formi (jednom).
 */
export function MovementDialog({
  preset,
  onClose,
}: {
  preset?: MovementPreset;
  onClose: () => void;
}) {
  const create = useCreateMovement();
  const locs = useAllLocations('true');
  const locList = useMemo<LocLocation[]>(() => locs.data ?? [], [locs.data]);

  const [clientEventUuid] = useState(newClientEventUuid);
  const [orderNo, setOrderNo] = useState(preset?.orderNo ?? '');
  const [itemRefId, setItemRefId] = useState(preset?.itemRefId ?? '');
  const [drawingNo, setDrawingNo] = useState(preset?.drawingNo ?? '');
  const [movementType, setMovementType] = useState<LocMovementType>(
    preset?.movementType ?? (preset?.itemRefId && !preset?.fromLocationId ? 'INITIAL_PLACEMENT' : 'TRANSFER'),
  );
  const [fromLocationId, setFromLocationId] = useState<string | null>(preset?.fromLocationId ?? null);
  const [toLocationId, setToLocationId] = useState<string | null>(preset?.toLocationId ?? null);
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [returnToUnplaced, setReturnToUnplaced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<null | 'item' | 'from' | 'to'>(null);

  const itemRefTable = preset?.itemRefTable ?? 'bigtehn_rn';
  // „Neraspoređeno" (paritet 1.0) uvek traži polaznu lokaciju (vraća komad sa police
  // u nesmešteni pool); inače from je nepotreban za INITIAL_PLACEMENT/INVENTORY.
  const needFrom = returnToUnplaced || needsFrom(movementType);
  const needTo = !returnToUnplaced && movementType !== 'SCRAP';

  async function submit() {
    setError(null);
    if (!itemRefId.trim()) return setError('Unesi/skeniraj stavku (broj crteža ili TP ref).');
    if (needTo && !toLocationId) return setError('Izaberi odredišnu lokaciju ili „Neraspoređeno".');
    if (returnToUnplaced && !fromLocationId)
      return setError('Za „Neraspoređeno" izaberi polaznu policu u polju „Sa lokacije".');
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return setError('Količina mora biti veća od 0.');

    // Paritet 1.0 modals.js:1838 — kanonizuj nalog+TP pre slanja (dash/slash/9400).
    const norm = normalizeLocMovementKeys(orderNo, itemRefId);
    // Neraspoređeno → CORRECTION bez odredišta, sa polaznom (modals.js:1866/1955).
    const effectiveType: LocMovementType = returnToUnplaced ? 'CORRECTION' : movementType;

    try {
      // Retry iste akcije nosi isti clientEventUuid → DB fn vraća {idempotent:true}
      // bez dupliranja pokreta (native idempotencija); tok je isti — zatvori formu.
      await create.mutateAsync({
        clientEventUuid,
        itemRefTable,
        itemRefId: norm.itemRefId,
        movementType: effectiveType,
        orderNo: norm.orderNo || undefined,
        drawingNo: drawingNo.trim() || undefined,
        quantity: qty,
        toLocationId: needTo ? toLocationId ?? undefined : undefined,
        fromLocationId: needFrom ? fromLocationId ?? undefined : undefined,
        movementReason: reason.trim() || undefined,
        note: note.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Premeštanje nije uspelo.');
    }
  }

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title="Brzo premeštanje"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Otkaži</Button>
            <Button loading={create.isPending} onClick={() => void submit()}>Sačuvaj pokret</Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Broj naloga">
              <input className={INPUT} value={orderNo} onChange={(e) => setOrderNo(e.target.value)} placeholder="npr. 7351" />
            </FormField>
            <FormField label="Stavka (TP ref / crtež)" required>
              <div className="flex gap-1.5">
                <input className={INPUT} value={itemRefId} onChange={(e) => setItemRefId(e.target.value)} placeholder="npr. 2/415" />
                <button
                  type="button"
                  onClick={() => setScan('item')}
                  className="shrink-0 rounded-control border border-line bg-surface-2 px-2 text-ink-secondary hover:bg-surface"
                  aria-label="Skeniraj stavku"
                  title="Skeniraj stavku"
                >
                  <ScanLine className="h-4 w-4" />
                </button>
              </div>
            </FormField>
          </div>

          <FormField label="Broj crteža">
            <input className={INPUT} value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} placeholder="opciono" />
          </FormField>

          <FormField label="Tip pokreta" required>
            <select
              className={INPUT}
              value={movementType}
              onChange={(e) => setMovementType(e.target.value as LocMovementType)}
            >
              {MOVEMENT_TYPES.map((t) => (
                <option key={t} value={t}>{MOVEMENT_TYPE_LABEL[t]}</option>
              ))}
            </select>
          </FormField>

          {needFrom && (
            <FormField
              label="Sa lokacije (polazna)"
              required={returnToUnplaced}
              hint={returnToUnplaced ? 'Obavezno za „Neraspoređeno" — polica sa koje se vraća' : 'Ostavi prazno za auto-razrešavanje trenutne lokacije'}
            >
              <LocationSelect
                locations={locList}
                value={fromLocationId}
                onChange={setFromLocationId}
                onScan={() => setScan('from')}
                placeholder="Pretraži policu/kavez/mašinu…"
              />
            </FormField>
          )}

          {movementType !== 'SCRAP' && (
            <>
              {needTo && (
                <FormField label="Na lokaciju (odredišna)" required>
                  <LocationSelect
                    locations={locList}
                    value={toLocationId}
                    onChange={setToLocationId}
                    onScan={() => setScan('to')}
                    placeholder="Pretraži policu/kavez/mašinu…"
                  />
                </FormField>
              )}
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={returnToUnplaced}
                  onChange={(e) => setReturnToUnplaced(e.target.checked)}
                />
                Neraspoređeno (vrati sa police u nesmešteni pool — bez odredišta)
              </label>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Količina" required>
              <input className={INPUT} type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </FormField>
            <FormField label="Razlog">
              <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="opciono" />
            </FormField>
          </div>

          <FormField label="Napomena">
            <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} placeholder="opciono" />
          </FormField>

          {error && <p className="text-sm text-status-danger">{error}</p>}
        </div>
      </Dialog>

      {scan === 'item' && (
        <ScanOverlay
          title="Skeniraj stavku"
          accept={['ITEM']}
          onResult={(r) => {
            if (r.kind === 'ITEM') {
              setOrderNo(r.parsed.orderNo);
              setItemRefId(r.parsed.itemRefId);
              if (r.parsed.drawingNo) setDrawingNo(r.parsed.drawingNo);
            }
          }}
          onClose={() => setScan(null)}
        />
      )}
      {(scan === 'from' || scan === 'to') && (
        <ScanOverlay
          title={scan === 'from' ? 'Skeniraj polaznu lokaciju' : 'Skeniraj odredišnu lokaciju'}
          accept={['SHELF']}
          onResult={(r) => {
            if (r.kind === 'SHELF' && r.record) {
              if (scan === 'from') setFromLocationId(r.record.id);
              else setToLocationId(r.record.id);
            }
          }}
          onClose={() => setScan(null)}
        />
      )}
    </>
  );
}

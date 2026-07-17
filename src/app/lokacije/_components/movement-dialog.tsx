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
  usePlacements,
  type LocLocation,
  type LocMovementType,
} from '@/api/lokacije';
import { LocationSelect } from './location-select';
import { normalizeLocMovementKeys } from './label-build';
import { ScanOverlay } from './scan-overlay';
import { enqueueMovement } from '@/lib/offlineQueue';
import type { MovementVars } from '@/api/lokacije';

/** Mrežni pad (fetch nije stigao do servera) → gurni u offline queue umesto tvrdog pada. */
function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const status = (e as { status?: number } | null)?.status;
  if (typeof status === 'number') return false; // server je odgovorio → nije mrežni pad
  const msg = String((e as { message?: string } | null)?.message ?? e ?? '').toLowerCase();
  return /failed to fetch|network|load failed|timeout|ecconn|offline/.test(msg);
}

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
  const locById = useMemo(() => new Map(locList.map((l) => [l.id, l])), [locList]);

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
  const [showMachines, setShowMachines] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const [scan, setScan] = useState<null | 'item' | 'from' | 'to'>(null);

  const itemRefTable = preset?.itemRefTable ?? 'bigtehn_rn';

  // Trenutno stanje pre premeštanja (paritet 1.0 renderState) — stvarni placement-i stavke.
  const trimmedItem = itemRefId.trim();
  const placementsQ = usePlacements(
    { itemRefId: trimmedItem, itemRefTable, orderNo: orderNo.trim() || undefined, pageSize: 50 },
    trimmedItem.length > 0,
  );
  const currentPlacements = useMemo(
    () => (placementsQ.data?.data ?? []).filter((p) => Number(p.quantity) > 0),
    [placementsQ.data],
  );
  const placedTotal = currentPlacements.reduce((a, p) => a + Number(p.quantity || 0), 0);

  // „Prikaži i mašine kao destinaciju" (paritet 1.0) — mašine skrivene dok se ne čekira.
  const destLocations = useMemo(
    () => (showMachines ? locList : locList.filter((l) => l.locationType !== 'MACHINE')),
    [locList, showMachines],
  );
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

    // Isti clientEventUuid nosi i online POST i offline queue → idempotentan retry
    // (DB fn vraća {idempotent:true} bez dupliranja pokreta).
    const payload: MovementVars = {
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
    };

    // Offline: bez pokušaja mreže — direktno u queue (paritet 1.0 !navigator.onLine).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      queueAndReport(payload);
      return;
    }

    try {
      await create.mutateAsync(payload);
      onClose();
    } catch (e) {
      // Mreža pala u toku RPC-a → queue (payload nosi isti UUID, idempotentno).
      if (isNetworkError(e)) {
        queueAndReport(payload);
        return;
      }
      setError(e instanceof Error ? e.message : 'Premeštanje nije uspelo.');
    }
  }

  function queueAndReport(payload: MovementVars) {
    try {
      enqueueMovement(payload);
      setError(null);
      setQueued(
        'Zapis je sačuvan lokalno i čeka slanje kad se mreža vrati (šalje se automatski). ' +
          'Otvori „Neposlato" na Sync tabu da proveriš / ručno pošalješ.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ne mogu da upišem u lokalni queue.');
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
            <Button variant="secondary" onClick={onClose}>{queued ? 'Zatvori' : 'Otkaži'}</Button>
            {!queued && (
              <Button loading={create.isPending} onClick={() => void submit()}>Sačuvaj pokret</Button>
            )}
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

          {/* Trenutno stanje pre premeštanja — stvarni placement-i stavke (paritet 1.0). */}
          {trimmedItem.length > 0 && (
            <div className="rounded-control border border-line-soft bg-surface-2 px-3 py-2">
              {placementsQ.isLoading ? (
                <p className="text-xs text-ink-secondary">Učitavam trenutno stanje…</p>
              ) : currentPlacements.length === 0 ? (
                <p className="text-xs text-ink-secondary">Nema zabeleženog smeštaja za ovu stavku — koristi „Prvo zaduženje".</p>
              ) : (
                <>
                  <div className="mb-1.5 text-xs font-medium text-ink">
                    Trenutno smešteno {orderNo.trim() ? `za nalog ${orderNo.trim()} ` : ''}(ukupno {placedTotal} kom.) — klik = polazna:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {currentPlacements.map((p) => {
                      const loc = locById.get(p.locationId);
                      const lbl = loc ? `${loc.locationCode}${loc.name ? ` — ${loc.name}` : ''}` : p.locationId.slice(0, 8);
                      const active = fromLocationId === p.locationId;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setFromLocationId(p.locationId)}
                          className={`rounded-full border px-2 py-0.5 text-xs ${active ? 'border-accent bg-accent-subtle text-accent' : 'border-line text-ink-secondary hover:bg-surface'}`}
                          title="Postavi kao polaznu lokaciju"
                        >
                          {lbl} · <strong>{String(p.quantity)}</strong>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

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
                    locations={destLocations}
                    value={toLocationId}
                    onChange={setToLocationId}
                    onScan={() => setScan('to')}
                    groupByHall
                    placeholder="Pretraži policu/kavez/mašinu…"
                  />
                  <label className="mt-1.5 flex items-center gap-2 text-xs text-ink-secondary">
                    <input type="checkbox" checked={showMachines} onChange={(e) => setShowMachines(e.target.checked)} />
                    Prikaži i mašine kao destinaciju
                  </label>
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

          {queued && (
            <div className="rounded-control border border-status-info/40 bg-status-info-bg px-3 py-2 text-sm text-status-info">
              {queued}
            </div>
          )}
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

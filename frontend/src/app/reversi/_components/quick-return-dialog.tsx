'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { ScanLine } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  fetchCuttingOpenLines,
  fetchOpenHandLine,
  lookupBarcode,
  newClientEventId,
  useCuttingReturn,
  useReversiLocations,
  useReversiReturn,
  type BarcodeResult,
} from '@/api/reversi';
import { ScanOverlay } from './scan-overlay';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/** Razrešena otvorena linija spremna za povraćaj (HAND ili CUTTING). */
interface QuickMatch {
  kind: 'HAND' | 'CUTTING';
  barcode: string;
  docNumber: string;
  documentId: string;
  lineId: string;
  recipientLabel: string;
  returnQty: number;
  /** Stabilan idempotency ključ ove logičke operacije (preživljava retry istog matcha). */
  clientEventId: string;
}

/**
 * Quick Return (RB-43/44) — paritet 1.0 `openQuickReturnModal`. Skeniraj/ukucaj barkod
 * alata → pronađi otvoren revers → stilizovana potvrda (Enter=Vrati / Esc=Otkaži) →
 * vrati SVE preostalo. NIJE role-gated (operater vraća svoj alat).
 *
 *  - HAND (ALAT-): `GET /documents/open-hand-line` (najstariji otvoren revers BILO
 *    KOG primaoca, FIFO) → `POST /return` (`return_to_location_id` iz izbora ili
 *    magacin ALAT-MAG-01).
 *  - CUTTING (RZN-): moje otvorene rezne linije (`open-lines`, FIFO) → `POST /cutting-return`
 *    (`return_to_location_id=null` → magacin, kao 1.0).
 *
 * Idempotency: svaki match nosi STABILAN `clientEventId` (jedan skan = jedan dokument)
 * — retry iste potvrde ne pravi dupli povraćaj.
 */
export function QuickReturnDialog({
  onClose,
  initialCode,
  initialKind,
}: {
  onClose: () => void;
  /** Već skenirani barkod (RA-46 sken-do-povraćaja sa radnog stola) — razreši se odmah. */
  initialCode?: string;
  initialKind?: BarcodeResult['kind'];
}) {
  const handReturn = useReversiReturn();
  const cuttingReturn = useCuttingReturn();
  const locations = useReversiLocations();

  const [manual, setManual] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [locationId, setLocationId] = useState(''); // '' = magacin (BE default ALAT-MAG-01)
  const [match, setMatch] = useState<QuickMatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Sprečava da živa kamera (nekoliko frejmova) ili brz HID gurne novi kod dok
  // stilizovana potvrda još stoji ili dok razrešavamo prethodni.
  const resolvingRef = useRef(false);
  const manualRef = useRef<HTMLInputElement>(null);

  // Magacinske lokacije prve; magacin (ALAT-MAG-01) na vrhu (paritet 1.0 default).
  const locationRows = useMemo(() => locations.data?.data ?? [], [locations.data]);

  async function resolveCode(code: string, knownKind?: BarcodeResult['kind']) {
    const bc = code.trim();
    if (!bc || resolvingRef.current || match) return;
    setError(null);
    setInfo(null);
    resolvingRef.current = true;
    setBusy(true);
    try {
      const kind = knownKind ?? (await lookupBarcode(bc)).data.kind;
      if (kind === 'HAND') {
        const { data } = await fetchOpenHandLine(bc);
        if (!data) {
          setInfo(`Nema otvorenog reversa za alat ${bc}.`);
          return;
        }
        setMatch({
          kind: 'HAND',
          barcode: data.tool.barcode || bc,
          docNumber: data.docNumber,
          documentId: data.documentId,
          lineId: data.lineId,
          recipientLabel: data.recipientLabel,
          returnQty: data.remainingQty,
          clientEventId: newClientEventId(),
        });
      } else if (kind === 'CUTTING') {
        const { data } = await fetchCuttingOpenLines(bc);
        const line = data[0]; // BE sortira FIFO (najstarija otvorena linija)
        if (!line) {
          setInfo(`Nema vašeg otvorenog zaduženja za šifru ${bc}.`);
          return;
        }
        setMatch({
          kind: 'CUTTING',
          barcode: line.barcode || bc,
          docNumber: line.docNumber,
          documentId: line.documentId,
          lineId: line.lineId,
          recipientLabel: line.machineCode ? `Mašina ${line.machineCode}` : '—',
          returnQty: line.remainingQty > 0 ? line.remainingQty : 1,
          clientEventId: newClientEventId(),
        });
      } else {
        setInfo(`Skeniraj barkod alata (ALAT- ili RZN-). Očitano: ${bc}.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pretraga reversa nije uspela.');
    } finally {
      resolvingRef.current = false;
      setBusy(false);
    }
  }

  // RA-46 — sken-do-povraćaja: kad radni sto prosledi već skenirani barkod, razreši ga
  // odmah (jednom) tako da se stilizovana potvrda pojavi bez ponovnog skeniranja.
  const initialRanRef = useRef(false);
  useEffect(() => {
    if (initialRanRef.current || !initialCode) return;
    initialRanRef.current = true;
    void resolveCode(initialCode, initialKind);
    // resolveCode je stabilna u okviru mount-a; namerno pokrećemo samo jednom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode, initialKind]);

  async function confirmReturn() {
    if (!match || confirming) return;
    setConfirming(true);
    setError(null);
    try {
      if (match.kind === 'HAND') {
        await handReturn.mutateAsync({
          clientEventId: match.clientEventId,
          payload: {
            doc_id: match.documentId,
            return_to_location_id: locationId || null,
            return_notes: 'Brzi povraćaj',
            returned_lines: [{ line_id: match.lineId, returned_quantity: match.returnQty }],
          },
        });
      } else {
        await cuttingReturn.mutateAsync({
          clientEventId: match.clientEventId,
          payload: {
            doc_id: match.documentId,
            return_to_location_id: null,
            return_notes: 'Brzi povraćaj',
            returned_lines: [{ line_id: match.lineId, returned_quantity: match.returnQty }],
          },
        });
      }
      toast(`Vraćeno · ${match.docNumber}`);
      setMatch(null);
      // Vrati fokus na unos za sledeći skan (kontinualni HID tok).
      setTimeout(() => manualRef.current?.focus(), 30);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Povraćaj nije uspeo.');
    } finally {
      setConfirming(false);
    }
  }

  // Potvrda (kad je match aktivan): Enter=Vrati, Esc=Otkaži. Capture faza da presretne
  // Esc pre skenera/Dialog-a (inače Esc zatvori ceo tok umesto samo potvrde).
  useEffect(() => {
    if (!match) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void confirmReturn();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        setMatch(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // confirmReturn čita najsvežiji match/locationId iz closure-a svakog ren
    // (efekat se re-vezuje kad se match promeni).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match, locationId]);

  const confirmCard = match && (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Potvrda povraćaja"
      onClick={() => setMatch(null)}
    >
      <div
        className="w-full max-w-sm rounded-panel border border-line bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-md font-semibold text-ink">Vrati alat u magacin?</div>
        <div className="mt-3 space-y-1 text-sm">
          <div className="tnums text-lg font-semibold text-ink">{match.barcode}</div>
          <div className="text-ink-secondary">
            Revers: <strong className="tnums text-ink">{match.docNumber}</strong>
          </div>
          <div className="text-ink-secondary">{match.recipientLabel}</div>
          {match.returnQty > 1 && (
            <div className="text-ink-secondary">
              Količina: <strong className="tnums text-ink">{formatNumber(match.returnQty)}</strong>
            </div>
          )}
        </div>
        {error && <p className="mt-2 text-sm text-status-danger" role="alert">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setMatch(null)}>Otkaži</Button>
          <Button loading={confirming} onClick={() => void confirmReturn()}>Vrati</Button>
        </div>
      </div>
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title="↩ Brzi povraćaj"
      footer={
        <Button variant="secondary" onClick={onClose}>Zatvori</Button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Skeniraj ili ukucaj barkod alata (ALAT-… ili RZN-…). Vraća se sve preostalo sa reversa.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) {
              void resolveCode(manual);
              setManual('');
            }
          }}
        >
          <input
            ref={manualRef}
            className={INPUT}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Skeniraj/ukucaj barkod → Enter"
            autoComplete="off"
            autoFocus
          />
          <Button type="submit" variant="secondary" loading={busy}>Traži</Button>
          <Button type="button" variant="secondary" onClick={() => setScanOpen(true)}>
            <ScanLine className="h-4 w-4" aria-hidden /> Skener
          </Button>
        </form>

        <label className="block text-sm">
          <span className="mb-1 block text-2xs uppercase tracking-wider text-ink-secondary">
            Lokacija povraćaja (ručni alat)
          </span>
          <select className={INPUT} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Magacin (podrazumevano)</option>
            {locationRows.map((l) => (
              <option key={l.id} value={l.id}>
                {l.location_code}
                {l.name ? ` · ${l.name}` : ''}
              </option>
            ))}
          </select>
        </label>

        {info && <p className="text-sm text-status-warn" role="status">{info}</p>}
        {error && !match && <p className="text-sm text-status-danger" role="alert">{error}</p>}
      </div>

      {scanOpen && (
        <ScanOverlay
          title="Skeniraj povraćaj"
          hint="Skeniraj ALAT-… ili RZN-… — skener ostaje otvoren"
          accept={['HAND', 'CUTTING']}
          continuous
          onResult={(r) => void resolveCode(r.barcode, r.kind)}
          onClose={() => setScanOpen(false)}
        />
      )}

      {confirmCard}
    </Dialog>
  );
}

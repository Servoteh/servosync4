'use client';

import { useRef, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { ScanLine, Trash2 } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import {
  newClientEventId,
  fetchCuttingOpenLines,
  useCuttingReturn,
} from '@/api/reversi';
import { ScanOverlay } from './scan-overlay';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

interface ReturnItem {
  lineId: string;
  documentId: string;
  docNumber: string;
  barcode: string | null;
  naziv: string;
  remaining: number;
  returnQty: number;
  unit: string;
}

/**
 * Povraćaj reznog alata — paritet 1.0 `openCuttingToolReturnScannerModal`. NIJE
 * role-gated: operater vraća SVOJ alat (dostupno svakom sa reversi.read; BE
 * open-lines skopira na prijavljenog korisnika). Skener/HID/ručni unos barkoda →
 * BE `open-lines` vraća otvorene ISSUED linije korisnika FIFO (issuedAt ASC);
 * uzimamo NAJSTARIJU (`data[0]`), količina default = preostalo (max = preostalo).
 *
 * Submit grupiše stavke po dokumentu → JEDAN POST po dokumentu (kao 1.0), svaki sa
 * STABILNIM clientEventId PO DOKUMENTU (mapa `eventIds`): distinct po dokumentu jer
 * bi deljen ključ zbog `ON CONFLICT (client_event_id)` u `rev_api_idempotency` tiho
 * vratio rezultat prvog dokumenta i preskočio ostale (tiha zaguba), a STABILAN
 * preko retry-ja (idempotencija — ponovni submit ne pravi dupli povraćaj).
 */
export function CuttingReturnDialog({ onClose }: { onClose: () => void }) {
  const ret = useCuttingReturn();
  const [items, setItems] = useState<ReturnItem[]>([]);
  const [notes, setNotes] = useState('');
  const [manual, setManual] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const busyRef = useRef(false);
  // Stabilan idempotency ključ PO DOKUMENTU — preživljava retry iste forme.
  const eventIds = useRef(new Map<string, string>());

  async function addByBarcode(raw: string) {
    const code = raw.trim();
    if (!code || busyRef.current) return;
    setError(null);
    setInfo(null);
    busyRef.current = true;
    setBusy(true);
    try {
      const { data } = await fetchCuttingOpenLines(code);
      const line = data[0]; // BE sortira FIFO (issuedAt ASC) → najstarija otvorena linija
      if (!line) {
        setInfo(`Nema otvorenog reversa za alat ${code} na vama.`);
        return;
      }
      if (items.some((it) => it.lineId === line.lineId)) {
        setInfo('Stavka je već u listi.');
        return;
      }
      // Dedup i u updater-u (garancija tačnosti i pri brzom seriskom skenu).
      setItems((xs) =>
        xs.some((it) => it.lineId === line.lineId)
          ? xs
          : [
              ...xs,
              {
                lineId: line.lineId,
                documentId: line.documentId,
                docNumber: line.docNumber,
                barcode: line.barcode,
                naziv: line.naziv,
                remaining: line.remainingQty,
                returnQty: line.remainingQty,
                unit: line.unit,
              },
            ],
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pretraga reversa nije uspela.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function setQty(lineId: string, v: number) {
    setItems((xs) =>
      xs.map((it) =>
        it.lineId === lineId
          ? { ...it, returnQty: Math.max(1, Math.min(it.remaining, Math.floor(v) || 1)) }
          : it,
      ),
    );
  }

  function remove(lineId: string) {
    setItems((xs) => xs.filter((it) => it.lineId !== lineId));
  }

  function eventIdFor(docId: string): string {
    let id = eventIds.current.get(docId);
    if (!id) {
      id = newClientEventId();
      eventIds.current.set(docId, id);
    }
    return id;
  }

  async function submit() {
    if (items.length === 0 || submitting) return;
    setError(null);
    setInfo(null);
    setSubmitting(true);
    // Grupiši po dokumentu → jedan POST po dokumentu (kao 1.0).
    const byDoc = new Map<string, ReturnItem[]>();
    for (const it of items) {
      const arr = byDoc.get(it.documentId) ?? [];
      arr.push(it);
      byDoc.set(it.documentId, arr);
    }
    const failedDocs = new Set<string>();
    let lastErr: string | null = null;
    let ok = 0;
    for (const [docId, lines] of byDoc) {
      try {
        await ret.mutateAsync({
          clientEventId: eventIdFor(docId),
          payload: {
            doc_id: docId,
            return_to_location_id: null, // BE/DB fn koristi ALAT-MAG-01
            return_notes: notes.trim() || null,
            returned_lines: lines.map((l) => ({
              line_id: l.lineId,
              returned_quantity: l.returnQty,
            })),
          },
        });
        ok += 1;
      } catch (e) {
        failedDocs.add(docId);
        lastErr = e instanceof Error ? e.message : 'Povraćaj nije uspeo.';
      }
    }
    setSubmitting(false);
    if (failedDocs.size > 0) {
      // Zadrži SAMO neuspele dokumente — retry nosi isti ključ po dokumentu (uspeli
      // se ne diraju). Katalog/„moji alati" su već osveženi kroz hook onSuccess.
      setItems((xs) => xs.filter((it) => failedDocs.has(it.documentId)));
      setError(
        `Povraćaj: ${ok} uspešno, ${failedDocs.size} neuspešno — ${lastErr ?? 'pokušaj ponovo'}.`,
      );
      return;
    }
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="↩ Povraćaj reznog alata"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={submitting} disabled={items.length === 0} onClick={() => void submit()}>
            Potvrdi povraćaj{items.length ? ` (${items.length})` : ''}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) {
              void addByBarcode(manual);
              setManual('');
            }
          }}
        >
          <input
            className={INPUT}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Skeniraj/ukucaj barkod (RZN-…) → Enter"
            autoComplete="off"
            autoFocus
          />
          <Button type="submit" variant="secondary" loading={busy}>Traži</Button>
          <Button type="button" variant="secondary" onClick={() => setScanOpen(true)}>
            <ScanLine className="h-4 w-4" aria-hidden /> Skener
          </Button>
        </form>

        {info && <p className="text-sm text-status-warn" role="status">{info}</p>}

        {items.length === 0 ? (
          <p className="rounded-panel border border-dashed border-line px-3 py-6 text-center text-sm text-ink-secondary">
            Nema stavki. Skeniraj barkod alata koji vraćaš.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-panel border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-2xs uppercase tracking-wide text-ink-secondary">
                  <th className="px-3 py-2 text-left font-semibold">Barkod</th>
                  <th className="px-3 py-2 text-left font-semibold">Naziv</th>
                  <th className="px-3 py-2 text-left font-semibold">Dokument</th>
                  <th className="px-3 py-2 text-right font-semibold">Vraćam</th>
                  <th className="px-3 py-2" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.lineId} className="border-b border-line last:border-0">
                    <td className="px-3 py-2"><span className="tnums text-ink-secondary">{it.barcode ?? '—'}</span></td>
                    <td className="px-3 py-2">{it.naziv}</td>
                    <td className="px-3 py-2"><span className="tnums text-ink-secondary">{it.docNumber}</span></td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <input
                          className={`${INPUT} w-20 text-right`}
                          type="number"
                          min={1}
                          max={it.remaining}
                          value={it.returnQty}
                          onChange={(e) => setQty(it.lineId, Number(e.target.value))}
                        />
                        <span className="text-xs text-ink-secondary">/ {formatNumber(it.remaining)} {it.unit}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="rounded-control p-1 text-ink-secondary hover:bg-surface-2 hover:text-status-danger"
                        aria-label="Ukloni stavku"
                        onClick={() => remove(it.lineId)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <FormField label="Napomena povraćaja">
          <textarea className={INPUT} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>

        {error && <p className="text-sm text-status-danger" role="alert">{error}</p>}
      </div>

      {scanOpen && (
        <ScanOverlay
          title="Skeniraj povraćaj"
          accept={['CUTTING']}
          onResult={(r) => { void addByBarcode(r.barcode); }}
          onClose={() => setScanOpen(false)}
        />
      )}
    </Dialog>
  );
}

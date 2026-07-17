'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import { code128bSvg } from '@/app/lokacije/_components/labels-print-window';
import {
  printReversiLabelsMultiFormat,
  REVERSI_BULK_FORMAT_OPTIONS,
  type ReversiLabelFormat,
  type ReversiLabelRow,
} from '@/lib/reversi-labels';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';
const PREVIEW_MAX = 6;

/**
 * Bulk štampa nalepnica (RA-22 · R1-ADV-01) — paritet 1.0 `bulkPrintLabelsModal.js`:
 * izbor formata (A4 varijante + TSC, default A4 105×74 = primarni 1.0 put), broj
 * kopija 1–50, pregled prvih 6 stavki sa barkodom i „Pregled u novom tabu" (dryRun)
 * pre same štampe. A4 formati idu u browser (Ctrl+P); TSC dodatno best-effort na
 * mrežni termalni štampač.
 */
export function BulkPrintLabelsDialog({
  open,
  onClose,
  rows,
}: {
  open: boolean;
  onClose: () => void;
  rows: ReversiLabelRow[];
}) {
  const [format, setFormat] = useState<ReversiLabelFormat>('a4-105x74');
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);

  const withBarcode = useMemo(() => rows.filter((r) => r.barcode), [rows]);
  const preview = withBarcode.slice(0, PREVIEW_MAX);
  const moreN = withBarcode.length - preview.length;
  const totalLabels = withBarcode.length * copies;

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const res = await printReversiLabelsMultiFormat(withBarcode, { format, copies, dryRun });
      if (res.ok && !dryRun) {
        toast(`Pripremljeno ${formatNumber(totalLabels)} nalepnica za štampu`);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Štampa nalepnica (${formatNumber(withBarcode.length)})`}
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button variant="secondary" loading={busy} onClick={() => void run(true)}>
            Pregled u novom tabu
          </Button>
          <Button loading={busy} onClick={() => void run(false)}>
            Štampaj ({formatNumber(totalLabels)})
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-ink-secondary">
          Isti formati kao <strong>Lokacije → Štampa nalepnica polica</strong>. A4: jedan prozor,
          Ctrl+P (u dijalogu isključi „Headers and footers", margina „None"). TSC: TSPL2 na LAN
          štampač + isti sadržaj u browseru.
        </p>

        <p className="text-sm">
          Ukupno nalepnica: <strong className="tnums">{formatNumber(totalLabels)}</strong>{' '}
          <span className="text-ink-secondary">
            ({formatNumber(withBarcode.length)} stavki × {copies} kopija)
          </span>
        </p>

        {preview.length > 0 && (
          <div>
            <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">
              Pregled ({preview.length}
              {moreN > 0 ? ` od ${formatNumber(withBarcode.length)}` : ''})
            </div>
            <ul className="space-y-1">
              {preview.map((r) => (
                <li
                  key={r.barcode}
                  className="flex items-center gap-3 rounded-control border border-line px-2 py-1"
                >
                  <span
                    className="h-8 w-24 shrink-0 [&_svg]:h-full [&_svg]:w-full"
                    aria-hidden
                    dangerouslySetInnerHTML={{ __html: code128bSvg(r.barcode, 'bulk-thumb') }}
                  />
                  <span className="min-w-0 leading-tight">
                    <span className="tnums block font-medium">{r.barcode}</span>
                    <span className="block truncate text-xs text-ink-secondary">
                      {r.oznaka} — {r.naziv}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {moreN > 0 && (
              <p className="mt-1 text-2xs text-ink-secondary">
                + još {formatNumber(moreN)} stavki u štampi
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Format (kao Lokacije)">
            <select
              className={INPUT}
              value={format}
              onChange={(e) => setFormat(e.target.value as ReversiLabelFormat)}
            >
              {REVERSI_BULK_FORMAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Kopija po stavci">
            <input
              className={INPUT}
              type="number"
              min={1}
              max={50}
              value={copies}
              onChange={(e) =>
                setCopies(Math.max(1, Math.min(50, Math.floor(Number(e.target.value) || 1))))
              }
            />
          </FormField>
        </div>
      </div>
    </Dialog>
  );
}

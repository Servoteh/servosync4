/**
 * Reversi — štampa ALAT- barkod-nalepnica (RA-22 bulk iz „Alat i oprema" bulk bara +
 * RB-47 „Odmah odštampaj nalepnicu" pri dodavanju). VERAN port 1.0
 * `src/ui/reversi/reversiLabelsPrint.js` (browser TSC put): otvara preview prozor
 * (80×38mm, Ctrl+P) SA pre-renderovanim CODE128 barkodom, a paralelno best-effort
 * šalje RAW TSPL2 na mrežni TSC preko `POST /v1/reversi/labels/print` (kao Lokacije/
 * Tehnologija). Barkod = samostalni CODE128-B SVG (bez `jsbarcode` zavisnosti,
 * deljen sa Lokacijama), TSPL2 = `buildReversiHandToolLabelProgram` (ALAT- layout).
 */

'use client';

import { printReversiLabel } from '@/api/reversi';
import { buildReversiHandToolLabelProgram } from '@/lib/tspl2';
import { code128bSvg } from '@/app/lokacije/_components/labels-print-window';
import { toast } from '@/lib/toast';

/** Jedna nalepnica ručnog alata (paritet 1.0 bulk-print reda: HAND + barcode + meta). */
export interface ReversiLabelRow {
  barcode: string;
  oznaka: string;
  naziv: string;
  /** Labela podgrupe (klasa) — prikazuje se uz serijski u trećem redu. */
  subgroupLabel?: string | null;
  serial?: string | null;
}

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** CSS TSC preview-a (paritet 1.0 REVERSI_LABEL_CSS, 80×38mm). */
const REVERSI_LABEL_CSS = `
  @page { size: 80mm 38mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; font-family: Arial, sans-serif; color:#000; background:#fff; }
  :root { --print-scale: 0.95; }
  .toolbar { position: sticky; top: 0; z-index: 10; padding: 8px 12px; background:#eef; font-size:12px; border-bottom:1px solid #99c; }
  .toolbar button { margin-left:8px; padding:4px 10px; cursor:pointer; }
  .toolbar .hint { color:#444; margin-left:12px; }
  .label {
    width: 80mm; height: 38mm; max-height: 38mm;
    padding: 0.4mm 2mm 0.4mm 7mm;
    display: flex; flex-direction: column; gap: 0.3mm;
    page-break-after: always; break-after: page; overflow: hidden; zoom: var(--print-scale);
  }
  .label:last-child { page-break-after: auto; break-after: auto; }
  .lbl-meta { flex: 0 0 auto; font-size: 7pt; line-height: 1.15; }
  .lbl-row-full { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lbl-strong { font-weight: 700; font-size: 11pt; }
  .lbl-muted { font-size: 6.5pt; color: #333; }
  .lbl-bc { flex: 1 1 auto; min-height: 14mm; display:flex; align-items:flex-end; }
  .lbl-bc svg { width: 100%; height: 15mm; }
  .lbl-footline { flex: 0 0 auto; text-align: center; font-weight: 700; font-size: 9pt; font-family: monospace; }
  @media print { .toolbar { display: none; } .label { border: 0; } }
`;

/** HTML jedne TSC nalepnice (barkod pre-renderovan CODE128-B SVG). Paritet 1.0. */
function labelHtmlBlock(row: ReversiLabelRow): string {
  const barcode = String(row.barcode ?? '').trim();
  const oznaka = String(row.oznaka ?? '').trim();
  const naziv = String(row.naziv ?? '').trim();
  const sub = [row.subgroupLabel, row.serial].filter(Boolean).join(' · ');
  return `<div class="label">
    <div class="lbl-meta">
      <div class="lbl-row-full lbl-strong">${escHtml(oznaka)}</div>
      <div class="lbl-row-full">${escHtml(naziv)}</div>
      ${sub ? `<div class="lbl-row-full lbl-muted">${escHtml(sub)}</div>` : ''}
    </div>
    <div class="lbl-bc">${code128bSvg(barcode, 'lbl-bc-svg')}</div>
    <div class="lbl-footline">${escHtml(barcode)}</div>
  </div>`;
}

/** Sastavi RAW TSPL2 za sve redove × kopije (ALAT- layout). */
function composeTspl(rows: ReversiLabelRow[], copies: number): string {
  const chunks: string[] = [];
  for (const r of rows) {
    if (!r.barcode) continue;
    for (let i = 0; i < copies; i += 1) {
      chunks.push(
        buildReversiHandToolLabelProgram({
          barcode: r.barcode,
          oznaka: r.oznaka,
          naziv: r.naziv,
          assetKind: r.subgroupLabel ?? '',
          serial: r.serial ?? '',
          copies: 1,
        }),
      );
    }
  }
  return chunks.join('\r\n');
}

/**
 * Odštampaj nalepnice: preview prozor (Ctrl+P) + best-effort mrežni TSC.
 * `window.open` MORA sinhrono u korisničkom gestu (inače popup-blocker), pa se
 * mrežni poziv radi posle otvaranja prozora. Ne baca — vraća `{ ok, reason? }`.
 */
export async function printReversiLabels(
  rows: ReversiLabelRow[],
  opts: { copies?: number } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const withBarcode = (Array.isArray(rows) ? rows : []).filter((r) => r?.barcode);
  if (!withBarcode.length) {
    toast('Nema barkoda za štampu');
    return { ok: false, reason: 'no_barcode' };
  }
  const copies = Math.max(1, Math.min(50, Math.floor(Number(opts.copies) || 1)));

  // Preview prozor — sinhrono u gestu.
  const w = window.open('', '_blank');
  if (!w) {
    toast('Dozvoli pop-up da bi štampao nalepnice');
    return { ok: false, reason: 'popup_blocked' };
  }
  const flat: ReversiLabelRow[] = [];
  for (const r of withBarcode) for (let i = 0; i < copies; i += 1) flat.push(r);
  w.document.write(
    `<!DOCTYPE html><html lang="sr-Latn"><head><meta charset="UTF-8"><title> </title>` +
      `<style>${REVERSI_LABEL_CSS}</style></head><body>` +
      `<div class="toolbar">Reversi nalepnice: <strong>${flat.length}</strong> · TSC 80×38mm. ` +
      `Pritisni <strong>Ctrl + P</strong> za štampu.` +
      `<button onclick="window.print()">Štampaj</button>` +
      `<button onclick="window.close()">Zatvori</button>` +
      `<span class="hint">U Chrome dijalogu isključi <em>Headers and footers</em> i marginu <em>None</em>.</span>` +
      `</div>${flat.map(labelHtmlBlock).join('')}</body></html>`,
  );
  w.document.close();

  // Best-effort mrežni TSC (ne blokira preview; toast po ishodu).
  try {
    const tspl2 = composeTspl(withBarcode, copies);
    await printReversiLabel(tspl2, copies);
    toast(`Poslato ${flat.length} nalepnica na TSC štampač`);
    return { ok: true };
  } catch (e) {
    toast('LAN štampač nedostupan — koristi browser (Ctrl+P)');
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

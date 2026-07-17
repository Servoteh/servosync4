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
import {
  buildReversiHandToolLabelProgram,
  buildTspCuttingToolLabelProgram,
  buildTspMiniInsertLabelProgram,
} from '@/lib/tspl2';
import {
  FORMAT_DIMS,
  code128bSvg,
  type ShelfLabelFormat,
} from '@/app/lokacije/_components/labels-print-window';
import { toast } from '@/lib/toast';

/**
 * TSC sadržajni šablon (RC-57): `standard` = 80×40mm (ručni HAND / rezni CUTTING),
 * `mini` = 30×15mm uložak (glodačke pločice, štampač već podešen u TSC admin-u).
 */
export type ReversiTsplTemplate = 'standard' | 'mini';

/**
 * Jedan red za štampu nalepnice (paritet 1.0 bulk-print reda). Podrazumevano = HAND
 * (ručni alat). Za rezni alat postavi `grupa: 'CUTTING'` (RC-61) + opcione `klasa` i
 * `compatibleMachineCodes` da bi TSC put izabrao `buildTspCuttingToolLabelProgram`.
 */
export interface ReversiLabelRow {
  barcode: string;
  oznaka: string;
  naziv: string;
  /** Labela podgrupe (klasa) — prikazuje se uz serijski u trećem redu (HAND). */
  subgroupLabel?: string | null;
  serial?: string | null;
  /** Grupa alata — bira TSC layout: `CUTTING` → rezni, inače (default) → ručni (HAND). */
  grupa?: 'HAND' | 'CUTTING' | null;
  /** Klasa reznog alata — red „Klasa: …" (CUTTING) i „oznaka" mini uloška. */
  klasa?: string | null;
  /** Kompatibilne mašine reznog — red „Masine: …" (CUTTING). */
  compatibleMachineCodes?: string[] | null;
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

/**
 * Sastavi RAW TSPL2 za sve redove × kopije, birajući layout po šablonu/grupi (paritet 1.0
 * `composeMultiLabelTspl`): `mini` šablon → 30×15 uložak za sve redove; inače po redu
 * `grupa === 'CUTTING'` → rezni layout (RC-61), a podrazumevano → ručni (HAND) layout.
 */
function composeTspl(
  rows: ReversiLabelRow[],
  copies: number,
  template: ReversiTsplTemplate = 'standard',
): string {
  const chunks: string[] = [];
  for (const r of rows) {
    if (!r.barcode) continue;
    for (let i = 0; i < copies; i += 1) {
      if (template === 'mini') {
        chunks.push(
          buildTspMiniInsertLabelProgram({
            barcode: r.barcode,
            oznaka: r.oznaka,
            klasa: r.klasa ?? r.subgroupLabel ?? '',
            copies: 1,
          }),
        );
      } else if (r.grupa === 'CUTTING') {
        chunks.push(
          buildTspCuttingToolLabelProgram({
            barcode: r.barcode,
            oznaka: r.oznaka,
            naziv: r.naziv,
            klasa: r.klasa ?? r.subgroupLabel ?? '',
            compatibleMachineCodes: r.compatibleMachineCodes ?? [],
            copies: 1,
          }),
        );
      } else {
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

/* ── RA-22 (R1-ADV-01): bulk štampa sa izborom formata + kopija ─────────────
 * Paritet 1.0 `bulkPrintLabelsModal.js` + `reversiLabelsPrint.js` (A4 grana):
 * primarni 1.0 put je A4 nalepnica (default `a4-105x74`), a ne samo TSC. Reuse
 * deljenih `FORMAT_DIMS` (isti formati kao Lokacije → Štampa nalepnica polica) i
 * samostalnog CODE128-B renderera (`code128bSvg`, bez jsbarcode zavisnosti). */

export type ReversiLabelFormat = ShelfLabelFormat;

/** Formati ponuđeni u bulk dijalogu (podskup FORMAT_DIMS; default = A4 105×74). */
export const REVERSI_BULK_FORMAT_OPTIONS: {
  value: ReversiLabelFormat;
  label: string;
}[] = [
  { value: 'a4-105x74', label: 'A4 · 105×74 mm (8 po listu — podrazumevano)' },
  { value: 'a4-large', label: 'A4 · 80×80 mm (2×2)' },
  { value: 'a4-grid', label: 'A4 kompakt · 60×40 mm (3-kol)' },
  { value: 'wide-200x99', label: '200×99 mm (široka, 1 po stranici)' },
  { value: 'tsc', label: 'TSC 80×40 mm (termalni LAN)' },
];

/** A4/široki blok nalepnice (oznaka/naziv/klasa/barkod/footline). Paritet 1.0. */
function reversiA4Block(row: ReversiLabelRow): string {
  const barcode = String(row.barcode ?? '').trim();
  const oznaka = String(row.oznaka ?? '').trim();
  const naziv = String(row.naziv ?? '').trim();
  const klasa = String(row.subgroupLabel ?? row.klasa ?? '').trim();
  const klasaLine = klasa ? `<div class="lbl-klasa">${escHtml(klasa)}</div>` : '';
  return `<div class="label">
    <div class="lbl-oznaka">${escHtml(oznaka)}</div>
    <div class="lbl-naziv">${escHtml(naziv.slice(0, 48))}</div>
    ${klasaLine}
    <div class="lbl-codebox">${code128bSvg(barcode, 'lbl-a4-svg')}</div>
    <div class="lbl-footline">${escHtml(barcode)}</div>
  </div>`;
}

/** A4/široki HTML dokument (grid iz FORMAT_DIMS). Paritet 1.0 reversiLabelHtmlShell. */
function reversiA4Doc(count: number, format: ReversiLabelFormat, labelsHtml: string): string {
  const dims = FORMAT_DIMS[format] ?? FORMAT_DIMS['a4-105x74'];
  const gapScreen = dims.gapScreen ?? '4mm';
  const gapPrint = dims.gapPrint ?? '0';
  const pageMargins = dims.pageMargins ?? '8mm';
  return (
    `<!DOCTYPE html><html lang="sr-Latn"><head><meta charset="UTF-8"><title> </title><style>` +
    `@page { size: A4; margin: ${pageMargins}; }` +
    `* { box-sizing: border-box; }` +
    `html, body { margin:0; padding:0; font-family: Arial, sans-serif; color:#000; background:#fff; }` +
    `.toolbar { position: sticky; top:0; z-index:10; padding:10px 16px; background:#eef; border-bottom:1px solid #99c; font-size:13px; }` +
    `.toolbar button { padding:6px 14px; margin-left:8px; cursor:pointer; font-size:13px; border:1px solid #334; background:#fff; border-radius:4px; }` +
    `.toolbar .hint { color:#444; margin-left:12px; }` +
    `.grid { display:grid; grid-template-columns: repeat(${dims.cols}, ${dims.w}); gap:${gapScreen}; padding:10px 16px 24px; justify-content:center; }` +
    `.label { width:${dims.w}; height:${dims.h}; border:1px dashed #666; padding:3mm; display:flex; flex-direction:column; justify-content:space-between; page-break-inside:avoid; break-inside:avoid; overflow:hidden; text-align:center; }` +
    `.lbl-oznaka { font-size:11pt; font-weight:700; line-height:1.1; }` +
    `.lbl-naziv { font-size:9pt; margin:1mm 0; }` +
    `.lbl-klasa { font-size:8pt; margin-bottom:1mm; }` +
    `.lbl-codebox { flex:1; display:flex; align-items:center; justify-content:center; min-height:14mm; }` +
    `.lbl-codebox svg { width:100%; height:100%; }` +
    `.lbl-footline { font-weight:900; text-align:center; font-size:10pt; font-family:monospace; }` +
    `@media print { .toolbar { display:none; } .grid { padding:0; gap:${gapPrint}; } .label { border:1px solid #000; } }` +
    `</style></head><body>` +
    `<div class="toolbar">Reversi nalepnice: <strong>${count}</strong> · ${escHtml(dims.name)}. ` +
    `Pritisni <strong>Ctrl + P</strong> za štampu.` +
    `<button onclick="window.print()">Štampaj</button>` +
    `<button onclick="window.close()">Zatvori</button>` +
    `<span class="hint">U Chrome dijalogu isključi <em>Headers and footers</em> i marginu <em>None</em>.</span>` +
    `</div><div class="grid">${labelsHtml}</div></body></html>`
  );
}

/**
 * Bulk štampa nalepnica sa izborom formata (A4 varijante + TSC) i kopija (RA-22).
 * A4/široki formati = samo browser preview (Ctrl+P); TSC = browser preview + (osim
 * u `dryRun`) best-effort RAW TSPL2 na mrežni štampač. `window.open` MORA sinhrono
 * u gestu. Vraća `{ ok }` — preview otvoren je garancija; mrežni TSC je best-effort
 * (paritet 1.0 `printReversiLabelsBatch`).
 */
export async function printReversiLabelsMultiFormat(
  rows: ReversiLabelRow[],
  opts: {
    format?: ReversiLabelFormat;
    copies?: number;
    dryRun?: boolean;
    /** TSC sadržajni šablon (RC-57) — `mini` = 30×15 uložak; važi samo za `format: 'tsc'`. */
    template?: ReversiTsplTemplate;
  } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const withBarcode = (Array.isArray(rows) ? rows : []).filter((r) => r?.barcode);
  if (!withBarcode.length) {
    toast('Nema barkoda za štampu');
    return { ok: false, reason: 'no_barcode' };
  }
  const format: ReversiLabelFormat =
    opts.format && FORMAT_DIMS[opts.format] ? opts.format : 'a4-105x74';
  const copies = Math.max(1, Math.min(50, Math.floor(Number(opts.copies) || 1)));
  const template: ReversiTsplTemplate = opts.template === 'mini' ? 'mini' : 'standard';
  const isTsc = format === 'tsc';

  const flat: ReversiLabelRow[] = [];
  for (const r of withBarcode) for (let i = 0; i < copies; i += 1) flat.push(r);

  const w = window.open('', '_blank');
  if (!w) {
    toast('Dozvoli pop-up da bi štampao nalepnice');
    return { ok: false, reason: 'popup_blocked' };
  }

  if (isTsc) {
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
  } else {
    w.document.write(reversiA4Doc(flat.length, format, flat.map(reversiA4Block).join('')));
  }
  w.document.close();

  // TSC: best-effort mrežni štampač (osim u pregledu/dryRun). Browser preview je
  // garancija, pa neuspeh mreže ne obara operaciju (paritet 1.0).
  if (isTsc && !opts.dryRun) {
    try {
      const tspl2 = composeTspl(withBarcode, copies, template);
      await printReversiLabel(tspl2, copies);
      toast(`Poslato ${flat.length} nalepnica na TSC štampač`);
    } catch {
      toast('LAN štampač nedostupan — koristi browser (Ctrl+P)');
    }
  } else {
    toast(`Otvoren pregled — ${FORMAT_DIMS[format].name} (Ctrl+P)`);
  }
  return { ok: true };
}

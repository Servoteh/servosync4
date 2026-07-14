/**
 * Lokacije — štampa nalepnica kroz PREGLEDAČ (A4 + preview + „samo šifra police" +
 * TP batch), VERAN port 1.0 `src/ui/lokacije/labelsPrint.js` (browser putevi:
 * `printShelfLabelsToBrowserWindow` / `shelfLabelsHtmlShell` / `buildTechLabelHtmlBlock`).
 *
 * 2.0 do sada štampa ISKLJUČIVO na TSC mrežni termalni (backend TSPL2 → 9100).
 * Ovaj modul dodaje 6 formata (uklj. A4/TopStick) koji idu kroz `window.open` +
 * `@page` CSS + Ctrl+P (fizička A4 štampa), preview prozor, „samo šifra police"
 * (krupan glif bez barkoda) i batch TP nalepnicu (sa TIP operacije: S/O/Z).
 *
 * ⚠️ TSC put OSTAJE netaknut (stampa-tab za `format==='tsc'` i dalje ide na backend
 * `usePrintLocLabel`). Ovde je SAMO browser render.
 *
 * Barkod: samostalni CODE128 (Code Set B) SVG enkoder (bez `jsbarcode` zavisnosti —
 * verifikovan 1:1 protiv jsbarcode CODE128B na test-vektorima; on-prem/offline
 * bezbedno). QR: lazy `qrcode` (postoji u 2.0 deps).
 */

/* ── HTML/ASCII helperi ───────────────────────────────────────────────── */

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Transliteruj dijakritike u ASCII (š→s, č/ć→c, ž→z, đ→dj) i saseci na Code B opseg
 * (32..126). ISTI translit kao `@/lib/tspl2` — pa browser barkod i TSC barkod koduju
 * IDENTIČAN string (skener na oba vraća isto → backend resolver radi jednako).
 */
function asciiTranslit(s: string | undefined | null): string {
  if (s == null) return '';
  return String(s)
    .replace(/š/g, 's').replace(/Š/g, 'S')
    .replace(/č/g, 'c').replace(/Č/g, 'C')
    .replace(/ć/g, 'c').replace(/Ć/g, 'C')
    .replace(/ž/g, 'z').replace(/Ž/g, 'Z')
    .replace(/đ/g, 'dj').replace(/Đ/g, 'Dj')
    .replace(/[„"]/g, '"')
    .replace(/[—–]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, '?');
}

/* ── CODE128 (Code Set B) — samostalni SVG enkoder ────────────────────── */

// 108 obrazaca širina (0..106 podataka/start/stop). Verifikovano protiv
// jsbarcode CODE128B (binary encode) na test-vektorima „A3", „HALA 1 - A3",
// „KV 7", „RNZ:123:1234/5:0:A", „9400/755"… — svi identični.
const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const CODE128_START_B = 104;
const CODE128_STOP = 106;

/** Širine obrasca („212222") → binarni string modula (počinje crtom). */
function widthsToBinary(w: string): string {
  let out = '';
  let bar = 1;
  for (const ch of w) {
    out += String(bar).repeat(Number(ch));
    bar ^= 1;
  }
  return out;
}

/** Vrednost → binarni niz modula (start B + podaci + kontrolni + stop). */
function code128bBinary(text: string): string {
  const values = [CODE128_START_B];
  for (const c of text) {
    const code = c.charCodeAt(0);
    // asciiTranslit garantuje 32..126; tvrdi guard za svaki slučaj.
    values.push(code >= 32 && code <= 126 ? code - 32 : '?'.charCodeAt(0) - 32);
  }
  let sum = CODE128_START_B;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  values.push(CODE128_STOP);
  return values.map((v) => widthsToBinary(CODE128_PATTERNS[v])).join('');
}

/**
 * CODE128-B barkod kao SVG string (crne crte na beloj podlozi, 10 modula tihe zone
 * sa svake strane). `preserveAspectRatio="none"` + `width/height:100%` — uniformno
 * skalira na širinu nalepnice (odnosi modula očuvani → skenira se pouzdano).
 */
export function code128bSvg(value: string, className = 'label-barcode', height = 100): string {
  const text = asciiTranslit(value).trim();
  if (!text) return '';
  const quiet = 10;
  const bin = code128bBinary(text);
  const total = bin.length + quiet * 2;
  let rects = '';
  let i = 0;
  while (i < bin.length) {
    if (bin[i] === '1') {
      let j = i;
      while (j < bin.length && bin[j] === '1') j++;
      rects += `<rect x="${quiet + i}" y="0" width="${j - i}" height="${height}" fill="#000"/>`;
      i = j;
    } else {
      i++;
    }
  }
  return (
    `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" ` +
    `preserveAspectRatio="none" width="100%" height="100%" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="${total}" height="${height}" fill="#fff"/>${rects}</svg>`
  );
}

/** QR kao SVG string (lazy `qrcode`), namešten da popuni codebox (kvadrat, centriran). */
async function qrSvg(value: string, className = 'label-qr'): Promise<string> {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const mod = await import('qrcode');
  const svg = await mod.toString(text, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'L',
    color: { dark: '#000000', light: '#ffffff' },
  });
  // qrcode.toString daje <svg ... viewBox=".."> bez width/height — dodaj fill + class.
  return svg.replace(
    /^<svg /,
    `<svg class="${className}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" `,
  );
}

/* ── Formati nalepnica polica (paritet 1.0 FORMAT_DIMS) ───────────────── */

export type ShelfLabelFormat =
  | 'a4-105x48' | 'a4-105x74' | 'wide-200x99' | 'a4-large' | 'a4-grid' | 'tsc';
export type ShelfCodeType = 'barcode' | 'qr';

interface FormatDim {
  w: string;
  h: string;
  cols: number;
  name: string;
  pageMargins?: string;
  gapScreen?: string;
  gapPrint?: string;
  rowsPerPage?: number;
  shelfCodeOnlyMm?: number;
  shelfCodeOnlyWithFootMm?: number;
  shelfCodeOnlyPt?: number;
}

export const FORMAT_DIMS: Record<ShelfLabelFormat, FormatDim> = {
  'wide-200x99': {
    w: '200mm', h: '99mm', cols: 1, name: '200×99 mm (široka)',
    pageMargins: '4.95mm 5mm', gapScreen: '10mm', gapPrint: '2mm',
    shelfCodeOnlyMm: 82, shelfCodeOnlyWithFootMm: 72,
  },
  tsc: {
    w: '80mm', h: '40mm', cols: 1, name: 'TSC 80×40mm',
    shelfCodeOnlyMm: 32, shelfCodeOnlyWithFootMm: 26,
  },
  'a4-105x48': {
    w: '105mm', h: '48mm', cols: 2, name: 'A4 TopStick 8715 · 105×48 mm (12 po listu)',
    pageMargins: '0', gapScreen: '6mm', gapPrint: '0', rowsPerPage: 6,
    shelfCodeOnlyMm: 40, shelfCodeOnlyWithFootMm: 34,
  },
  'a4-105x74': {
    w: '105mm', h: '74.25mm', cols: 2, name: 'A4 105×74,25 mm (8 po listu)',
    pageMargins: '0', gapScreen: '8mm', gapPrint: '0', rowsPerPage: 4,
    shelfCodeOnlyMm: 58, shelfCodeOnlyWithFootMm: 50,
  },
  'a4-large': {
    w: '80mm', h: '80mm', cols: 2, name: 'A4 80×80mm (2×2)',
    shelfCodeOnlyMm: 64, shelfCodeOnlyWithFootMm: 56,
  },
  'a4-grid': {
    w: '60mm', h: '40mm', cols: 3, name: 'A4 kompakt (3-kol)',
    shelfCodeOnlyMm: 28, shelfCodeOnlyWithFootMm: 24,
  },
};

export const SHELF_LABEL_FORMATS: ShelfLabelFormat[] = [
  'a4-105x48', 'a4-105x74', 'wide-200x99', 'a4-large', 'a4-grid', 'tsc',
];

/** Ljudske labele za format-dropdown (paritet 1.0 modala). */
export const SHELF_FORMAT_OPTIONS: { value: ShelfLabelFormat; label: string }[] = [
  { value: 'a4-105x48', label: 'A4 TopStick 8715 · 105×48 mm (12 po listu — podrazumevano)' },
  { value: 'a4-105x74', label: 'A4 · 105×74,25 mm (8 po listu)' },
  { value: 'wide-200x99', label: '200×99 mm (široka, 1 po stranici)' },
  { value: 'a4-large', label: 'A4 · 80×80 mm (2×2)' },
  { value: 'a4-grid', label: 'A4 kompakt 3-kolona' },
  { value: 'tsc', label: 'TSC 80×40 mm (termalni)' },
];

function isA4TwoCol105Format(format: ShelfLabelFormat): boolean {
  return format === 'a4-105x74' || format === 'a4-105x48';
}

/** Veličina glifa za „samo šifra" — raste sa formatom; a4-105x48 ostaje 40 mm. */
function shelfCodeOnlyFontMm(format: ShelfLabelFormat, hasFootline: boolean): number {
  const d = FORMAT_DIMS[format] || FORMAT_DIMS['a4-105x48'];
  if (hasFootline && d.shelfCodeOnlyWithFootMm != null) return d.shelfCodeOnlyWithFootMm;
  if (d.shelfCodeOnlyMm != null) return d.shelfCodeOnlyMm;
  const h = parseFloat(String(d.h)) || 48;
  return Math.max(18, Math.floor(h * (hasFootline ? 0.7 : 0.82)));
}

function shelfCodeOnlyStyleAttr(format: ShelfLabelFormat, hasFootline: boolean): string {
  const mm = shelfCodeOnlyFontMm(format, hasFootline);
  const lh = mm >= 56 ? 0.88 : 0.92;
  return ` style="font-size:${mm}mm;line-height:${lh};max-height:${mm}mm"`;
}

/* ── Pojedinačna nalepnica police/kaveza ─────────────────────────────── */

interface PreparedShelfLabel {
  /** Krupni glif / footline tekst (šifra police ili broj kaveza). */
  shelfCode: string;
  /** Footline tekst (= shelfCode kad ima barkod; '' u „samo šifra" režimu). */
  footline: string;
  /** Pre-render barkod/QR SVG (prazno u „samo šifra" režimu). */
  graphicHtml: string;
  /** Da li OVA nalepnica ima kod-grafiku. */
  withBarcode: boolean;
}

function shelfLabelHtml(item: PreparedShelfLabel, format: ShelfLabelFormat): string {
  const shelfCode = escHtml(item.shelfCode);
  const footRaw = String(item.footline ?? '').trim();
  const withBarcode = item.withBarcode;
  const codeOnlyStack = !withBarcode && footRaw !== '';
  const cls =
    `label fmt-${format}${withBarcode ? '' : ' label-code-only'}${codeOnlyStack ? ' label-code-only--stack' : ''}`;
  const codeMm = shelfCodeOnlyFontMm(format, footRaw !== '');
  const foot = footRaw !== '' ? `<div class="label-footline">${escHtml(footRaw)}</div>` : '';
  if (!withBarcode) {
    return (
      `<div class="${cls}" style="--code-mm:${codeMm}mm">` +
      `<div class="label-shelf-code"${shelfCodeOnlyStyleAttr(format, footRaw !== '')}>${shelfCode}</div>` +
      `${foot}</div>`
    );
  }
  return `
    <div class="${cls}">
      <div class="label-codebox">${item.graphicHtml}</div>
      ${foot}
    </div>`;
}

/** Print-ready HTML shell (paritet 1.0 shelfLabelsHtmlShell:274-461). */
function shelfLabelsHtmlShell(
  count: number,
  codeType: ShelfCodeType,
  format: ShelfLabelFormat,
  withBarcode: boolean,
  labelsHtml: string,
): string {
  const dims = FORMAT_DIMS[format] || FORMAT_DIMS['a4-105x48'];
  const codeLabel = withBarcode ? (codeType === 'qr' ? 'QR kod' : 'Barkod') : 'samo šifra police';
  const isCompact = format === 'a4-grid';
  const isLarge = format === 'a4-large';
  const isTwoUp105 = isA4TwoCol105Format(format);
  const isTopStick48 = format === 'a4-105x48';
  const isWide200 = format === 'wide-200x99';
  const isTsc = format === 'tsc';
  const pageMarginA4 = !isTsc && dims.pageMargins != null ? dims.pageMargins : '8mm';
  const gapScreen = dims.gapScreen != null ? dims.gapScreen : isLarge ? '5mm' : '4mm';
  const gapPrint = dims.gapPrint != null ? dims.gapPrint : isCompact ? '3mm' : isLarge ? '5mm' : '0';
  const labelPadPrint = isTwoUp105
    ? withBarcode
      ? isTopStick48 ? '1.5mm 6mm' : '1.5mm 2mm'
      : isTopStick48 ? '1.5mm 2mm 0' : '0'
    : isLarge ? '2.5mm' : '3mm';
  const shelfCodePt = dims.shelfCodeOnlyPt != null ? dims.shelfCodeOnlyPt : isTopStick48 ? 42 : 36;
  const shelfCodeFontSize =
    dims.shelfCodeOnlyMm != null ? `${dims.shelfCodeOnlyMm}mm` : `${shelfCodePt}pt`;
  const shelfCodeOnlyTopAlign = dims.shelfCodeOnlyMm != null;

  const pageRule = isTsc
    ? `@page { size: ${dims.w} ${dims.h}; margin: 0; }`
    : `@page { size: A4 portrait; margin: ${pageMarginA4}; }`;

  const footPx =
    isWide200 ? '19pt'
    : isLarge ? '15pt'
    : isTopStick48 ? '36pt'
    : isTwoUp105 ? '14pt'
    : isTsc ? '10pt'
    : '12pt';
  const codeBoxH =
    codeType === 'qr'
      ? isWide200 ? '76mm'
        : isTopStick48 ? '22mm'
        : isLarge || format === 'a4-105x74' ? '60mm'
        : '26mm'
      : isWide200 ? '74mm'
        : isTopStick48 ? '18mm'
        : isLarge ? '66mm'
        : format === 'a4-105x74' ? '56mm'
        : isTsc ? '26mm'
        : '24mm';

  return `<!DOCTYPE html>
<html lang="sr-Latn">
<head>
  <meta charset="UTF-8">
  <title>Nalepnice polica (${count})</title>
  <style>
    ${pageRule}
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #000; background: #fff;
    }
    .toolbar {
      position: sticky; top: 0; z-index: 10;
      padding: 10px 16px; background: #eef;
      border-bottom: 1px solid #99c;
      font-size: 13px; color: #234;
    }
    .toolbar button {
      padding: 6px 14px; margin-left: 8px; cursor: pointer;
      font-size: 13px; border: 1px solid #334; background: #fff; border-radius: 4px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(${dims.cols}, ${dims.w});
      gap: ${gapScreen};
      padding: 10px 16px 24px;
      justify-content: ${isTwoUp105 ? 'flex-start' : 'center'};
      ${isTwoUp105 ? 'width: 210mm; max-width: 210mm; margin: 0 auto;' : ''}
    }
    .label {
      width: ${dims.w};
      height: ${dims.h};
      border: 1px dashed #666;
      border-radius: ${isTwoUp105 ? '0' : '2mm'};
      padding: 3mm;
      text-align: center;
      page-break-inside: avoid;
      break-inside: avoid;
      display: flex; flex-direction: column; justify-content: space-between; align-items: stretch;
      gap: 1.75mm;
      overflow: hidden;
    }
    .label-codebox {
      flex: 1 1 0;
      width: 100%;
      min-height: ${codeBoxH};
      display: flex; align-items: center; justify-content: center;
    }
    .label-barcode { width: 100%; height: 100%; max-height: 100%; display: block; }
    .label-qr { width: 100%; height: 100%; max-height: 100%; display: block; }
    .label-footline {
      flex: 0 0 auto;
      width: 100%;
      text-align: center;
      font-weight: 900;
      font-size: ${footPx};
      line-height: 1.08;
      letter-spacing: 0.02em;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .label.label-code-only {
      justify-content: ${shelfCodeOnlyTopAlign ? 'flex-start' : 'center'};
      align-items: center;
      padding: ${shelfCodeOnlyTopAlign ? '1.5mm 2mm 0' : '0'};
    }
    .label.label-code-only--stack {
      justify-content: space-between;
      align-items: stretch;
      padding: 1.5mm 2mm 1mm;
      gap: 0.5mm;
    }
    .label.label-code-only--stack .label-shelf-code {
      flex: 1 1 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
      max-height: var(--code-mm, ${isTopStick48 ? '40mm' : '100%'});
      overflow: hidden;
    }
    .label-shelf-code {
      font-size: ${shelfCodeFontSize};
      font-weight: 900;
      line-height: ${shelfCodeOnlyTopAlign ? '0.92' : '1'};
      letter-spacing: 0.02em;
      max-width: 100%;
      overflow: hidden;
      white-space: nowrap;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    @media print {
      .toolbar { display: none; }
      html, body { margin: 0; padding: 0; }
      .grid {
        padding: 0;
        gap: ${gapPrint};
        ${isTwoUp105 ? 'width: 210mm; max-width: 210mm; margin: 0; justify-content: flex-start;' : ''}
      }
      .label {
        border: ${isTwoUp105 ? '0' : '1px solid #000'};
        border-radius: 0;
        padding: ${labelPadPrint};
      }
      ${isTwoUp105 ? `.label.fmt-a4-105x74, .label.fmt-a4-105x48 { page-break-inside: avoid; break-inside: avoid; }` : ''}
      ${isWide200 && codeType === 'barcode' ? '.label.fmt-wide-200x99 { overflow: visible; }' : ''}
      ${isWide200 && codeType === 'barcode' ? '.label.fmt-wide-200x99 .label-codebox { min-height: 72mm; }' : ''}
      ${isTsc ? '.label { border: 0; }' : ''}
    }
  </style>
</head>
<body>
  <div class="toolbar">
    Nalepnice polica: <strong>${count}</strong> · format <strong>${escHtml(dims.name)}</strong> · <strong>${escHtml(codeLabel)}</strong>.
    ${isTwoUp105 ? 'A4: margine <strong>None</strong>, skala <strong>100%</strong>, bez zaglavlja. ' : ''}
    Pritisni <strong>Ctrl + P</strong> za štampu.
    <button onclick="window.print()">Štampaj</button>
    <button onclick="window.close()">Zatvori</button>
  </div>
  <div class="grid">${labelsHtml}</div>
</body>
</html>`;
}

/** Ulaz za jednu policu/kavez (šifra + vrednost koja se koduje u barkod/QR). */
export interface ShelfLabelInput {
  id: string;
  /** Krupni glif / footline (šifra police ili broj kaveza). */
  shelfCode: string;
  /** Vrednost koja se koduje (HALA - POLICA, „KV N", ili sama šifra). */
  barcodeValue: string;
}

export interface ShelfPrintOpts {
  format: ShelfLabelFormat;
  codeType: ShelfCodeType;
  copies: number;
  /** true = barkod/QR + footline; false = „samo šifra police" (krupan glif). */
  withBarcode: boolean;
}

/**
 * Otvara prozor sa jednom ili više nalepnica polica/kaveza (preview + Ctrl+P).
 * VERAN port 1.0 `printShelfLabelsToBrowserWindow` — copies se razvija u flat listu,
 * grafika je pre-renderovana (barkod = samostalni CODE128 SVG, QR = lazy qrcode).
 */
export async function printShelfLabelsToBrowserWindow(
  items: ShelfLabelInput[],
  opts: ShelfPrintOpts,
): Promise<{ ok: boolean; reason?: string }> {
  if (!Array.isArray(items) || !items.length) return { ok: false, reason: 'empty' };

  const withBarcode = opts.withBarcode === true;
  const codeType: ShelfCodeType = opts.codeType === 'qr' ? 'qr' : 'barcode';
  const format: ShelfLabelFormat = FORMAT_DIMS[opts.format] ? opts.format : 'a4-105x48';
  const copies = Math.max(1, Math.floor(Number(opts.copies) || 1));

  // window.open MORA sinhrono u korisničkom gestu (inače popup-blocker).
  const w = window.open('', '_blank');
  if (!w) return { ok: false, reason: 'popup_blocked' };

  try {
    // Razvi copies u flat listu (N kopija po polici → N nalepnica).
    const flat: ShelfLabelInput[] = [];
    for (const it of items) for (let i = 0; i < copies; i++) flat.push(it);

    const anyBarcode = withBarcode && flat.some((l) => String(l.barcodeValue || '').trim() !== '');

    const prepared: PreparedShelfLabel[] = [];
    for (const l of flat) {
      const hasCode = anyBarcode && String(l.barcodeValue || '').trim() !== '';
      let graphicHtml = '';
      if (hasCode) {
        graphicHtml =
          codeType === 'qr'
            ? await qrSvg(l.barcodeValue)
            : code128bSvg(l.barcodeValue);
      }
      prepared.push({
        shelfCode: l.shelfCode,
        // Footline pravilo (paritet 1.0): SA barkodom = šifra/broj; BEZ = '' (glif već pokazuje šifru).
        footline: anyBarcode ? l.shelfCode : '',
        graphicHtml,
        withBarcode: hasCode,
      });
    }

    const labelsHtml = prepared.map((p) => shelfLabelHtml(p, format)).join('');
    w.document.write(shelfLabelsHtmlShell(flat.length, codeType, format, anyBarcode, labelsHtml));
    w.document.close();
    return { ok: true };
  } catch (e) {
    try {
      w.document.body.innerHTML = `<p style="padding:20px;color:#c00">Greška: ${escHtml(
        e instanceof Error ? e.message : String(e),
      )}</p>`;
    } catch {
      /* prozor zatvoren */
    }
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/* ── TP nalepnica (80×38mm) — batch kroz pregledač, sa TIP operacije ──── */

/** TIP operacije na TP nalepnici: S/O/Z → SKLOP/OBRADA/ZAVARIVANJE (paritet 1.0). */
export const TIP_OPERACIJE_MAP: Record<string, string> = {
  S: 'SKLOP',
  O: 'OBRADA',
  Z: 'ZAVARIVANJE',
};

export interface TechLabelFields {
  brojPredmeta?: string;
  komitent?: string;
  nazivPredmeta?: string;
  nazivDela?: string;
  brojCrteza?: string;
  materijal?: string;
  kolicina?: string;
  datum?: string;
  /** S/O/Z (opciono) → krupan natpis SKLOP/OBRADA/ZAVARIVANJE ispod barkoda. */
  tipOperacije?: string;
}

export interface TechLabelSpec {
  fields: TechLabelFields;
  barcodeValue: string;
  copies?: number;
}

/** CSS za TP nalepnice — stvarna dimenzija stock-a u TSC ML340P (80×38mm). Paritet 1.0. */
const TECH_LABEL_CSS = `
  @page { size: 80mm 38mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; font-family: 'Arial', 'Liberation Sans', sans-serif; color:#000; background:#fff; }
  :root { --print-scale: 0.95; }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    padding: 8px 12px; background:#eef; font-size:12px; border-bottom:1px solid #99c;
  }
  .toolbar button { margin-left:8px; padding:4px 10px; cursor:pointer; }
  .toolbar .hint { color:#444; margin-left:12px; }
  .label {
    width: 80mm; height: 38mm; max-height: 38mm;
    padding: 0.4mm 2mm 0.4mm 7mm;
    display: flex; flex-direction: column;
    gap: 0.2mm;
    page-break-after: always;
    break-after: page;
    overflow: hidden;
    zoom: var(--print-scale);
  }
  .label:last-child { page-break-after: auto; break-after: auto; }
  .lbl-meta { display: flex; flex-direction: column; gap: 0; flex: 0 0 auto; max-height: 14mm; overflow: hidden; }
  .lbl-row {
    font-size: 6.5pt; line-height: 1;
    display: flex; gap: 3mm;
    overflow: hidden;
    height: 2.6mm;
  }
  .lbl-row-full { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lbl-row-split { display: flex; justify-content: space-between; align-items: baseline; }
  .lbl-cell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 50%; }
  .lbl-cell-right { text-align: right; }
  .lbl-rn { font-size: 10pt; font-weight: 700; line-height: 1; flex: 1 1 auto; }
  .lbl-row-split:first-child { height: 3.6mm; align-items: center; }
  .lbl-k { font-weight: 700; }
  .lbl-v { font-weight: 500; }
  .lbl-bc {
    flex: 0 0 17mm; max-height: 17mm;
    display: flex; align-items: center; justify-content: center;
    margin-top: 0.3mm;
    padding: 0;
    overflow: hidden;
  }
  .lbl-bc svg { width: 100%; height: 100%; max-height: 17mm; display: block; }
  .lbl-tip {
    flex: 0 0 auto;
    text-align: center;
    font-size: 10pt;
    font-weight: 800;
    line-height: 1;
    margin-top: 0.4mm;
    letter-spacing: 0.5px;
  }
  @media print {
    .toolbar { display: none !important; }
    body { margin:0; padding:0; }
    .label { border: 0; }
  }
`;

/** HTML za jednu TP nalepnicu (barkod pre-renderovan kao SVG). Paritet 1.0 buildTechLabelHtmlBlock. */
function buildTechLabelHtmlBlock(spec: TechLabelSpec, barcodeSvg: string): string {
  const f = spec?.fields || {};
  const cell = (label: string, value: unknown, opts: { bare?: boolean } = {}): string => {
    const v = value == null || value === '' ? '' : String(value);
    if (!v) return '';
    if (opts.bare) return `<span class="lbl-v">${escHtml(v)}</span>`;
    return `<span class="lbl-k">${escHtml(label)}:</span> <span class="lbl-v">${escHtml(v)}</span>`;
  };
  const tipLabel = TIP_OPERACIJE_MAP[String(f.tipOperacije || '').trim().toUpperCase()] || '';
  const tipHtml = tipLabel ? `<div class="lbl-tip">${escHtml(tipLabel)}</div>` : '';
  return `<div class="label">
    <div class="lbl-meta">
      <div class="lbl-row lbl-row-split">
        <span class="lbl-cell lbl-rn">${escHtml(f.brojPredmeta || '')}</span>
        <span class="lbl-cell lbl-cell-right">${escHtml(f.komitent || '')}</span>
      </div>
      <div class="lbl-row lbl-row-full">${escHtml(f.nazivPredmeta || '')}</div>
      <div class="lbl-row lbl-row-full">${escHtml(f.nazivDela || '')}</div>
      <div class="lbl-row lbl-row-split">
        <span class="lbl-cell">${cell('Crtež', f.brojCrteza)}</span>
        <span class="lbl-cell lbl-cell-right">${cell('', f.materijal, { bare: true })}</span>
      </div>
      <div class="lbl-row lbl-row-split">
        <span class="lbl-cell">${cell('Komada', f.kolicina)}</span>
        <span class="lbl-cell lbl-cell-right">${cell('', f.datum, { bare: true })}</span>
      </div>
    </div>
    <div class="lbl-bc">${barcodeSvg}</div>
    ${tipHtml}
  </div>`;
}

/**
 * Batch TP nalepnice u jednom prozoru (svaka na svoj papir), sa TIP operacije.
 * VERAN port 1.0 `printTechProcessLabelsBatch` (browser deo) — barkod = samostalni
 * CODE128 SVG (bez jsbarcode). TSC put OSTAJE odvojen (backend TSPL2).
 */
export function printTechProcessLabelsBatch(
  specs: TechLabelSpec[],
): { ok: boolean; reason?: string } {
  if (!Array.isArray(specs) || !specs.length) return { ok: false, reason: 'empty' };

  // Razvi copies u flat listu.
  const flat: TechLabelSpec[] = [];
  for (const s of specs) {
    const n = Math.max(1, Math.floor(Number(s?.copies) || 1));
    for (let i = 0; i < n; i++) flat.push(s);
  }

  const w = window.open('', '_blank');
  if (!w) return { ok: false, reason: 'popup_blocked' };

  const labelsHtml = flat
    .map((s) => buildTechLabelHtmlBlock(s, code128bSvg(String(s.barcodeValue || ''), 'lbl-bc-svg')))
    .join('');
  const totalCount = flat.length;
  const firstRn = String(flat[0]?.fields?.brojPredmeta || '');

  w.document.write(`<!DOCTYPE html><html lang="sr-Latn"><head><meta charset="UTF-8"><title> </title>
  <style>${TECH_LABEL_CSS}</style></head><body>
  <div class="toolbar">
    <strong>${totalCount}</strong> nalepnic${totalCount === 1 ? 'a' : totalCount < 5 ? 'e' : 'a'}${firstRn ? ` (prva: <strong>${escHtml(firstRn)}</strong>)` : ''}.
    <button onclick="window.print()">Štampaj</button>
    <button onclick="window.close()">Zatvori</button>
    <span class="hint">U Chrome dijalogu ▸ <em>More settings</em> ▸ isključi <em>Headers and footers</em> i postavi marginu na <em>None</em> (samo prvi put po štampaču).</span>
  </div>
  ${labelsHtml}
  </body></html>`);
  w.document.close();
  return { ok: true };
}

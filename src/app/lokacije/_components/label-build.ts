// Lokacije — građa barkod stringova za nalepnice (VERAN port 1.0
// `barcodeParse.js` formatera + `labelsPrint.js barcodeForPlacementRow` +
// `shelfBarcode.js` shelf kompozit). TSPL2 program gradi `@/lib/tspl2`
// (buildTspLabelProgram za TP, buildTspShelfLabelProgram za policu); ovde su samo
// vrednosti koje idu u barkod. Semantika 1:1 sa 1.0 (isti regexi/limiti).

/** RNZ format `RNZ:idrn:nalog/tp:seg3:seg4` (paritet 1.0 formatBigTehnRnzBarcode). */
export function formatRnzBarcode(args: {
  orderNo: string | number;
  tpNo: string | number;
  internalId?: string | number;
  segment3?: string | number;
  segment4?: string | number;
}): string | null {
  const { orderNo, tpNo, internalId = '0', segment3 = '0', segment4 = '0' } = args;
  if (orderNo == null || tpNo == null) return null;
  const a = String(internalId).replace(/\D/g, '').slice(0, 10) || '0';
  const o = String(orderNo).replace(/[^0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 13);
  const t = String(tpNo).replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 64);
  const s3 = String(segment3).replace(/\D/g, '').slice(0, 12) || '0';
  const s4 = String(segment4).replace(/\D/g, '').slice(0, 12) || '0';
  if (!o || !t) return null;
  return `RNZ:${a}:${o}/${t}:${s3}:${s4}`;
}

/** Kratki format `NALOG/CRTEŽ` (paritet 1.0 formatBigTehnShortBarcode). */
export function formatShortBarcode(orderNo: string | number, drawingNo: string | number): string | null {
  if (orderNo == null || drawingNo == null) return null;
  const o = String(orderNo).replace(/\D/g, '').slice(0, 8);
  const d = String(drawingNo).replace(/\D/g, '').slice(0, 10);
  if (!o || !d) return null;
  return `${o}/${d}`;
}

/** Barkod za red placement-a/izveštaja (paritet 1.0 barcodeForPlacementRow). */
export function barcodeForRow(p: {
  itemRefTable?: string;
  orderNo?: string;
  itemRefId?: string;
  drawingNo?: string;
}): string | null {
  const tbl = String(p.itemRefTable || '');
  const ord = String(p.orderNo || '').trim();
  const iid = String(p.itemRefId || '').trim();
  const dr = String(p.drawingNo || '').trim();
  if (tbl === 'bigtehn_rn' && ord && iid) return formatRnzBarcode({ orderNo: ord, tpNo: iid });
  if (ord && (dr || iid)) return formatShortBarcode(ord, dr || iid);
  return null;
}

/**
 * Kompozitni shelf barkod `LP:hallUuid:shelfUuid` (paritet 1.0 shelf SCAN) —
 * backend `LP_COMPOSITE` ga razrešava nazad u policu+halu. Koristi se za SKEN,
 * NE za štampu (predugačak za CODE128 na 80mm nalepnici). Bez hale → prazno.
 */
export function shelfBarcodeValue(shelfId: string, hallId: string | null | undefined): string {
  return hallId ? `LP:${hallId}:${shelfId}` : '';
}

/** Kratka ljudska linija `HALA - POLICA` (paritet 1.0 formatShelfBarcodeHumanLine). */
export function formatShelfHumanLine(hallCode: string, shelfCode: string): string {
  const h = String(hallCode ?? '').trim();
  const s = String(shelfCode ?? '').trim();
  if (h && s) return `${h} - ${s}`;
  return s || h || '';
}

/**
 * Vrednost koja se KODIRA u nalepnicu police/kaveza (paritet 1.0
 * buildShelfPrintBarcodeParts): KRATKA linija `ŠIF_HALE - ŠIF_POLICE` (backend
 * `parseShortShelfBarcodePair` je razrešava na sken). NE LP: kompozit — predugačak
 * za CODE128 na 80mm. Bez hale → sama šifra (globalno jedinstvena fallback).
 */
export function shelfPrintBarcode(
  loc: { id: string; locationCode?: string | null },
  hall: { locationCode?: string | null } | null | undefined,
): { barcodeValue: string; displayPrimary: string } {
  const fallback = String(loc.locationCode ?? '').trim() || loc.id.slice(0, 8);
  if (!hall) return { barcodeValue: fallback, displayPrimary: fallback };
  const line = formatShelfHumanLine(String(hall.locationCode ?? ''), String(loc.locationCode ?? '')) || fallback;
  return { barcodeValue: line, displayPrimary: line };
}

/**
 * Kanonski ključ (nalog + TP ref) pre slanja `loc_create_movement` — VERAN port
 * 1.0 `normalizeLocMovementKeys` (barcodeParse.js) + backend `barcode.ts`. 9400
 * grana + dash normalizacija; MORA se primeniti na ručni unos (paritet modals.js:1838).
 */
export function normalizeLocMovementKeys(
  orderNo: string | null | undefined,
  itemRefId: string | null | undefined,
): { orderNo: string; itemRefId: string } {
  const o = String(orderNo ?? '').trim();
  let r = String(itemRefId ?? '').trim();
  if (!o || !r) return { orderNo: o, itemRefId: r };
  const m9400 = o.match(/^9400-(\d+)$/);
  if (m9400 && /^\d+$/.test(r)) {
    return { orderNo: '9400', itemRefId: `${m9400[1]}/${r}` };
  }
  if (o === '9400' && /^-?\d+\/\d+$/.test(r)) {
    r = r.replace(/^-/, '');
    return { orderNo: '9400', itemRefId: r };
  }
  return { orderNo: o, itemRefId: r };
}

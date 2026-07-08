/**
 * TSPL2 generator za TSC termalne štampače (ML340P, 300 DPI). Port iz ServoSync 1.0
 * (`servoteh-plan-montaze/src/lib/tspl2.js`) — MODULE_SPEC_stampa §6, MODULE_SPEC_kontrola §6.
 *
 * ⚠️ Printer-side konfiguracija je READ-ONLY: ML340P u pogonu već ima podešene
 * SIZE/GAP/DENSITY/SPEED/CODEPAGE preko TSC web admina (http://192.168.70.20). Ako te
 * komande pošaljemo, štampač piše preko konfiguracije i može da se BLOKIRA. Zato šaljemo
 * SAMO sadržaj: CLS / TEXT / BARCODE / PRINT.
 *
 * Layout (80.34×40.3 mm, 0,0 = gornji-levi, koordinate u dots):
 *   Red 1: Broj predmeta (levo, font "4") | Komitent (desno)
 *   Red 2: Naziv predmeta (puna širina)
 *   Red 3: Naziv dela (puna širina)
 *   Red 4: Crtež (levo) | Materijal (desno)
 *   Red 5: Količina (levo) | Datum (desno)
 *   Barkod: CODE128 (128M), y=14.8mm, h=15mm
 */

export interface TspLabelFields {
  brojPredmeta?: string;
  komitent?: string;
  nazivPredmeta?: string;
  nazivDela?: string;
  brojCrteza?: string;
  materijal?: string;
  kolicina?: string;
  datum?: string;
}

export interface TspLabelSpec {
  fields: TspLabelFields;
  /** RNZ payload, npr. `RNZ:123:1234/5:0:A`. */
  barcodeValue: string;
  /** Broj identičnih nalepnica u nizu (PRINT copies,1). */
  copies?: number;
}

const DOTS_PER_MM = 11.81; /* ML340P 300 DPI */

/** mm → dots (ceo broj). */
const mm = (v: number): number => Math.round(v * DOTS_PER_MM);

/**
 * Transliteruj dijakritike u ASCII (š→s, č/ć→c, ž→z, đ→dj). NE šaljemo CODEPAGE, pa
 * se oslanjamo na ASCII — dovoljno čitljivo na 80mm nalepnici.
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

/** Esc-uj string za TSPL2 TEXT/BARCODE parametar (obmotaj `"`; interni `"`→`'`). */
function tsplStr(s: string): string {
  return `"${asciiTranslit(s).replace(/"/g, "'")}"`;
}

/** Skrati na max N karaktera sa elipsom (bez preklapanja polovina reda). */
function truncFit(s: string | undefined | null, n: number): string {
  const v = String(s ?? '').trim();
  if (v.length <= n) return v;
  return v.slice(0, Math.max(0, n - 1)) + '…';
}

/**
 * Generiše TSPL2 program za jednu TP nalepnicu (80.34×40.3mm). NE šalje
 * SIZE/GAP/DENSITY/SPEED/CODEPAGE (vidi vrh fajla). Baca ako `barcodeValue` fali.
 */
export function buildTspLabelProgram(spec: TspLabelSpec): string {
  const f = spec?.fields ?? {};
  const bc = String(spec?.barcodeValue ?? '').trim();
  const copies = Math.max(1, Math.floor(Number(spec?.copies) || 1));
  if (!bc) throw new Error('buildTspLabelProgram: barcodeValue je obavezan');

  const lines: string[] = [];
  lines.push('CLS');

  // PAD_LEFT (7mm) = 2mm baseline + 5mm operaterski pomak udesno na ML340P.
  const PAD_LEFT = mm(7);
  const RIGHT_HALF_X = mm(46);

  /* Red 1: Broj predmeta (levo, naglašen font "4") | Komitent (desno) */
  if (f.brojPredmeta)
    lines.push(`TEXT ${PAD_LEFT},${mm(0.5)},"4",0,1,1,${tsplStr(truncFit(f.brojPredmeta, 16))}`);
  if (f.komitent)
    lines.push(`TEXT ${RIGHT_HALF_X},${mm(1.2)},"2",0,1,1,${tsplStr(truncFit(f.komitent, 24))}`);

  /* Red 2: Naziv predmeta (puna širina) */
  if (f.nazivPredmeta)
    lines.push(`TEXT ${PAD_LEFT},${mm(4.5)},"2",0,1,1,${tsplStr(truncFit(f.nazivPredmeta, 58))}`);

  /* Red 3: Naziv dela (puna širina) */
  if (f.nazivDela)
    lines.push(`TEXT ${PAD_LEFT},${mm(7)},"2",0,1,1,${tsplStr(truncFit(f.nazivDela, 58))}`);

  /* Red 4: Crtež (levo) | Materijal (desno) */
  if (f.brojCrteza)
    lines.push(`TEXT ${PAD_LEFT},${mm(9.5)},"2",0,1,1,${tsplStr('Crtez: ' + truncFit(f.brojCrteza, 16))}`);
  if (f.materijal)
    lines.push(`TEXT ${RIGHT_HALF_X},${mm(9.5)},"2",0,1,1,${tsplStr(truncFit(f.materijal, 24))}`);

  /* Red 5: Količina (levo) | Datum (desno) */
  if (f.kolicina)
    lines.push(`TEXT ${PAD_LEFT},${mm(12)},"2",0,1,1,${tsplStr('Kol: ' + truncFit(f.kolicina, 16))}`);
  if (f.datum)
    lines.push(`TEXT ${RIGHT_HALF_X},${mm(12)},"2",0,1,1,${tsplStr(f.datum)}`);

  /* Barkod CODE128 (128M): x=7mm, y=14.8mm, h=15mm, narrow=2, wide=4, human_readable=0. */
  lines.push(`BARCODE ${mm(7)},${mm(14.8)},"128M",${mm(15)},0,0,2,4,${tsplStr(bc)}`);

  lines.push(`PRINT ${copies},1`);
  return lines.join('\r\n') + '\r\n';
}

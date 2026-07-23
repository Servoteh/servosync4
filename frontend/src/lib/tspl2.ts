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
 * Konzervativna procena broja Code128 modula za auto-izbor širine modula
 * (`narrow`). Parovi uzastopnih cifara se pakuju kao jedan simbol (subset C),
 * sve ostalo 1 znak = 1 simbol (subset B); + start + checksum + ~2 simbola
 * rezerve za prelaze subseta + stop (13 modula). Simbol = 11 modula.
 */
function code128ModuleEstimate(content: string): number {
  let symbols = 0;
  let i = 0;
  while (i < content.length) {
    const digitPair =
      content[i] >= '0' && content[i] <= '9' &&
      i + 1 < content.length &&
      content[i + 1] >= '0' && content[i + 1] <= '9';
    symbols += 1;
    i += digitPair ? 2 : 1;
  }
  return (symbols + 4) * 11 + 13;
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

  /* Barkod CODE128 (128M): x=7mm, y=14.8mm, h=15mm, human_readable=0.
   * Modul (narrow): 3 dots (0,254mm — ono što su pogonski skeneri čitali kod
   * 1.0 browser-štampe; incident 22.07 „novi izgled neće da čita" — narrow=2 =
   * 0,169mm je pretanko). Fallback na 2 SAMO ako procenjena širina ne staje u
   * raspoloživih ~71mm (80,34 − 7 leva margina − ~2 quiet zona) — dug sadržaj. */
  const availableDots = mm(80.34 - 7 - 2);
  const narrow = code128ModuleEstimate(asciiTranslit(bc)) * 3 <= availableDots ? 3 : 2;
  if (narrow === 2)
    console.warn(
      `[tspl2] barkod "${bc}" predugačak za narrow=3 na 80mm nalepnici — pad na narrow=2 (proveriti čitljivost skenerom)`,
    );
  lines.push(`BARCODE ${mm(7)},${mm(14.8)},"128M",${mm(15)},0,0,${narrow},${narrow * 2},${tsplStr(bc)}`);

  lines.push(`PRINT ${copies},1`);
  return lines.join('\r\n') + '\r\n';
}

// --------------------------------------------------------------- Lokacije: nalepnica police
// Port iz ServoSync 1.0 (`src/lib/tspl2.js buildTspShelfLabelProgram`) — Lokacije
// štampa nalepnica polica (MODULE_SPEC_lokacije_30.md §3 t.12). Barkod = `LP:hallUuid:shelfUuid`
// (kompozit koji `shelfBarcode`/backend `barcode.ts` razrešava nazad u policu+halu),
// ili sama šifra police. Footer = čitljiva šifra police. NE šalje SIZE/GAP/DENSITY
// (vidi vrh fajla). Backend `POST /v1/locations/labels/print` samo prosleđuje RAW.

export interface ShelfLabelSpec {
  /** String koji se koduje u barkod/QR (`LP:hall:shelf` ili šifra police). */
  barcodeValue: string;
  /** Čitljiva šifra police ispod koda (default = barcodeValue). */
  footline?: string;
  codeType?: 'barcode' | 'qr';
  copies?: number;
}

// --------------------------------------------------------------- Reversi: nalepnica ručnog alata
// Port iz ServoSync 1.0 (`src/lib/tspl2.js buildTspHandToolLabelProgram`) — Reversi
// štampa ALAT- nalepnice (RA-22 bulk / RB-47 pri dodavanju). Layout 80.34×40.3mm:
//   Red 1: oznaka (font "4"), Red 2: naziv (font "2"), Red 3: podgrupa/serijski (font "1"),
//   Barkod CODE128 (128M) x=2mm y=22mm h=14mm. NE šalje SIZE/GAP/DENSITY (vidi vrh fajla).

export interface HandToolLabelSpec {
  barcode: string;
  oznaka?: string;
  naziv?: string;
  /** Labela podgrupe (klasa) — levo od serijskog u trećem redu. */
  assetKind?: string;
  serial?: string;
  copies?: number;
}

/** Jedna ALAT- nalepnica (80.34×40.3mm) — paritet 1.0 `buildTspHandToolLabelProgram`. */
export function buildReversiHandToolLabelProgram(spec: HandToolLabelSpec): string {
  const barcode = String(spec?.barcode ?? '').trim();
  if (!barcode) throw new Error('buildReversiHandToolLabelProgram: barcode je obavezan');

  const oznaka = String(spec?.oznaka ?? '').trim();
  const naziv = String(spec?.naziv ?? '').trim();
  const assetKind = String(spec?.assetKind ?? '').trim();
  const serial = String(spec?.serial ?? '').trim();
  const copies = Math.max(1, Math.floor(Number(spec?.copies) || 1));

  const lines: string[] = ['CLS'];
  if (oznaka) lines.push(`TEXT ${mm(2)},${mm(1)},"4",0,1,1,${tsplStr(truncFit(oznaka, 22))}`);
  if (naziv) lines.push(`TEXT ${mm(2)},${mm(6)},"2",0,1,1,${tsplStr(truncFit(naziv, 38))}`);
  const kindLine = [assetKind, serial].filter(Boolean).join(': ');
  if (kindLine) lines.push(`TEXT ${mm(2)},${mm(10)},"1",0,1,1,${tsplStr(truncFit(kindLine, 42))}`);
  lines.push(`BARCODE ${mm(2)},${mm(22)},"128M",${mm(14)},1,0,2,4,${tsplStr(barcode)}`);
  lines.push(`PRINT ${copies},1`);
  return lines.join('\r\n') + '\r\n';
}

// --------------------------------------------------------------- Reversi: nalepnica reznog alata
// Port iz ServoSync 1.0 (`src/lib/tspl2.js buildTspCuttingToolLabelProgram`, RZ-2) — Reversi
// štampa nalepnica reznog alata (grupa CUTTING). Layout 80.34×40.3mm:
//   Red 1: barkod string (font "5", čitljiv) | oznaka desno (ako se razlikuje),
//   Red 2: naziv (font "3"), Red 3: „Klasa: …", Red 4: „Masine: …",
//   Barkod CODE128 (128M) x=2mm y=19.5mm h=18mm human_readable=1.
// NE šalje SIZE/GAP/DENSITY (vidi vrh fajla).

export interface CuttingToolLabelSpec {
  barcode: string;
  oznaka?: string;
  naziv?: string;
  klasa?: string;
  /** Kompatibilne mašine — spajaju se u red „Masine: …". */
  compatibleMachineCodes?: string[];
  copies?: number;
}

/** Jedna nalepnica reznog alata (80.34×40.3mm) — paritet 1.0 `buildTspCuttingToolLabelProgram`. */
export function buildTspCuttingToolLabelProgram(spec: CuttingToolLabelSpec): string {
  const barcode = String(spec?.barcode ?? '').trim();
  if (!barcode) throw new Error('buildTspCuttingToolLabelProgram: barcode je obavezan');

  const oznaka = String(spec?.oznaka ?? '').trim();
  const naziv = String(spec?.naziv ?? '').trim();
  const klasa = String(spec?.klasa ?? '').trim();
  const machines = Array.isArray(spec?.compatibleMachineCodes)
    ? spec.compatibleMachineCodes.filter(Boolean).join(', ')
    : '';
  const copies = Math.max(1, Math.floor(Number(spec?.copies) || 1));

  const lines: string[] = ['CLS'];

  /* Red 1: barkod string (font "5" ~16pt) — čitljiv pored barkoda. */
  lines.push(`TEXT ${mm(2)},${mm(1.5)},"5",0,1,1,${tsplStr(truncFit(barcode, 18))}`);
  /* Red 1 (desno): oznaka — samo ako se razlikuje od barkoda. */
  if (oznaka && oznaka !== barcode)
    lines.push(`TEXT ${mm(46)},${mm(2.5)},"2",0,1,1,${tsplStr(truncFit(oznaka, 16))}`);
  /* Red 2: naziv (puna širina, font "3" ~10pt). */
  if (naziv) lines.push(`TEXT ${mm(2)},${mm(9)},"3",0,1,1,${tsplStr(truncFit(naziv, 38))}`);
  /* Red 3: klasa. */
  if (klasa)
    lines.push(`TEXT ${mm(2)},${mm(13.5)},"2",0,1,1,${tsplStr('Klasa: ' + truncFit(klasa, 26))}`);
  /* Red 4: kompatibilne mašine. */
  if (machines)
    lines.push(`TEXT ${mm(2)},${mm(16.5)},"2",0,1,1,${tsplStr('Masine: ' + truncFit(machines, 50))}`);
  /* Barkod CODE128 (128M): x=2mm, y=19.5mm, h=18mm, human_readable=1. */
  lines.push(`BARCODE ${mm(2)},${mm(19.5)},"128M",${mm(18)},1,0,2,4,${tsplStr(barcode)}`);
  lines.push(`PRINT ${copies},1`);
  return lines.join('\r\n') + '\r\n';
}

// --------------------------------------------------------------- Reversi: mini nalepnica (uložak)
// Port iz ServoSync 1.0 (`src/lib/tspl2.js buildTspMiniInsertLabelProgram`) — mini nalepnica
// 30×15mm (glodačke pločice / ulošci). Pretpostavlja da je štampač VEĆ podešen na 30×15 u
// TSC admin-u — NE šalje SIZE/GAP/DENSITY (kao ostali builderi; ML340P je read-only).
// Layout: oznaka (font "2"), klasa (font "1"), barkod CODE128 x=1mm y=6mm h=8mm.

export interface MiniInsertLabelSpec {
  barcode: string;
  oznaka?: string;
  klasa?: string;
  copies?: number;
}

/** Jedna mini nalepnica 30×15mm — paritet 1.0 `buildTspMiniInsertLabelProgram`. */
export function buildTspMiniInsertLabelProgram(spec: MiniInsertLabelSpec): string {
  const barcode = String(spec?.barcode ?? '').trim();
  if (!barcode) throw new Error('buildTspMiniInsertLabelProgram: barcode je obavezan');

  const oznaka = String(spec?.oznaka ?? '').trim();
  const klasa = String(spec?.klasa ?? '').trim();
  const copies = Math.max(1, Math.floor(Number(spec?.copies) || 1));

  const lines: string[] = ['CLS'];
  if (oznaka) lines.push(`TEXT ${mm(1)},${mm(0.5)},"2",0,1,1,${tsplStr(truncFit(oznaka, 14))}`);
  if (klasa && klasa !== oznaka)
    lines.push(`TEXT ${mm(1)},${mm(3)},"1",0,1,1,${tsplStr(truncFit(klasa, 18))}`);
  /* Barkod CODE128 (128M): x=1mm, y=6mm, h=8mm, narrow=2, wide=3 (uže zbog 30mm širine). */
  lines.push(`BARCODE ${mm(1)},${mm(6)},"128M",${mm(8)},0,0,2,3,${tsplStr(barcode)}`);
  lines.push(`PRINT ${copies},1`);
  return lines.join('\r\n') + '\r\n';
}

/** Jedna nalepnica police (80.34×40.3mm) — paritet 1.0 barcode/QR layout. */
export function buildTspShelfLabelProgram(spec: ShelfLabelSpec): string {
  const encode = String(spec?.barcodeValue ?? '').trim();
  if (!encode) throw new Error('buildTspShelfLabelProgram: barcodeValue je obavezan');
  const foot = String(spec?.footline ?? spec?.barcodeValue ?? '').trim();
  const copies = Math.max(1, Math.floor(Number(spec?.copies) || 1));
  const codeType = spec?.codeType === 'qr' ? 'qr' : 'barcode';

  const lines: string[] = ['CLS'];
  if (codeType === 'qr') {
    // Auto ćelija (M2) — dovoljno za LP:uuid:uuid na 80mm nalepnici.
    lines.push(`QRCODE ${mm(2)},${mm(2)},L,6,A,0,M2,${tsplStr(encode)}`);
  } else {
    lines.push(`BARCODE ${mm(2)},${mm(2)},"128M",${mm(22)},0,0,2,5,${tsplStr(encode)}`);
  }
  if (foot) {
    const yText = codeType === 'qr' ? mm(30.5) : mm(26.5);
    lines.push(`TEXT ${mm(2)},${yText},"3",0,1,1,${tsplStr(truncFit(foot, 46))}`);
  }
  lines.push(`PRINT ${copies},1`);
  return lines.join('\r\n') + '\r\n';
}

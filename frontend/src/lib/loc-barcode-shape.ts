/**
 * Lokacije/magacin — PREPOZNAVANJE OBLIKA barkoda na klijentu.
 *
 * ⚠️ Backend ostaje autoritet razrešavanja: kamera-put ide na
 * `GET /v1/locations/lookups/barcode` (`backend/src/modules/locations/barcode.ts`,
 * veran port 1.0 `barcodeParse.js`). Ovde su GRUBI predikati oblika + od
 * 04.08.2026 i `parseLocItemBarcode` (izvlačenje grupa NAD ISTIM regexima),
 * potrebni u trenucima kada nema vremena/mreže za backend:
 *
 *   1. IZBOR KODA IZ KADRA — kad nativni `BarcodeDetector` u jednom frejmu nađe
 *      više barkoda (na štampanom radnom nalogu barkodovi operacija stoje jedan
 *      pod drugim, pa kamera lako uhvati susedni red). Skener kroz
 *      `attachVideoDecoder({ preferMatching })` bira kod koji odgovara formatu
 *      koji ekran očekuje. Ako nijedan ne odgovara, dekoder vraća prvi kao i pre.
 *   2. FALLBACK PORUKA — ako backend nije odgovorio, skener ipak može da kaže da
 *      je skeniran barkod OPERACIJE (tekst je identičan `OPERATION_BARCODE_MESSAGE`
 *      sa backend-a, koji je i dalje jedini autoritet).
 *   3. FORM-WEDGE + PASTE (prijava 04.08, `movement-dialog`): stoni HID čitač
 *      kuca kod pravo u fokusirano polje forme (dijalog je otvoren, kamera
 *      overlay NIJE — nijedan dosadašnji hvatač tu ne radi), a korisnik ume i da
 *      NALEPI sirov `RNZ:…` string u „Broj naloga"/„Broj TP". Oba puta moraju
 *      SINHRONO (i offline) da rasporede kod po poljima — zato parse živi i na
 *      klijentu. ⚠️ `parseLocItemBarcode` MORA ostati poravnat sa backend
 *      `parseCleanBigTehnBarcode` (isti regexi, iste grupe); NE radi keyboard-
 *      wedge POPRAVKU (SR raspored — v. napomenu uz `RNZ_SHAPE`) ni loose-compact
 *      fallback (`]C` prefiks, GS separatori — to su kamera artefakti, BE put) i
 *      NE primenjuje 9400 fold — pozivalac ga radi kroz `normalizeLocMovementKeys`
 *      (isti redosled kao 1.0 `refreshErpFromOrderTpFields`).
 *
 * Oblici (vidi `backend/src/modules/tech-processes/barcode.ts`):
 *   • `RNZ:{idPredmeta}:{nalog}/{tp}:{varijanta}:{revizija}` — barkod NALOGA
 *     (zaglavlje štampanog RN-a gore desno) i nalepnica TP; polje 5 je verzioni
 *     pečat i može biti SLOVO (`A`) ili legacy numerički `PrnTimer` (`39757`).
 *   • `{nalog}/{crtez}` — stara „short" nalepnica (jedini oblik koji nosi crtež).
 *   • `{interniId}:{nalog}/{tp}:{varijanta}` — kompaktna nalepnica.
 *   • `S:{operacija}:{radniCentar}:0:{revizija}` — barkod OPERACIJE (red u tabeli
 *     RN-a). Služi PRIJAVI RADA na kiosku; za magacin je BEZ UPOTREBE jer ne nosi
 *     ni nalog ni TP, pa ne identifikuje deo.
 */

/** Isti „skidač šuma" kao backend `normalizeBarcodeText` (Code39 okvir + zero-width). */
function clean(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let t = raw.replace(/[\r\n\t]+/g, '').trim();
  if (t.startsWith('*') && t.endsWith('*') && t.length >= 3) t = t.slice(1, -1);
  // Nevidljivi znakovi (zero-width / BOM) se skidaju po code point-u — izvor
  // ostaje čist ASCII, isto pravilo kao backend `barcode.ts` i `scan-overlay`.
  const ZW = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);
  return [...t].filter((ch) => !ZW.has(ch.codePointAt(0)!)).join('').trim();
}

/**
 * `RNZ:…` — barkod naloga / nalepnica TP (polje 5 alfanumeričko: revizija ili PrnTimer).
 *
 * Poravnato sa backend `parseBigTehnBarcode` (30.07): separator `[:|;]` (stoni
 * keyboard-wedge čitač ume da pošalje `;` umesto `:`) i polje 5 `[A-Za-z0-9._-]{1,10}`
 * (`work_orders.revision` je slobodan tekst — „A-1", „1.2"). Ranije uži oblik je
 * značio da NAŠ odštampan nalog ne prođe predikat, pa bi kamera u koraku stavke
 * mogla da izabere susedni red — barkod OPERACIJE.
 *
 * SR raspored tastature se ovde NE normalizuje, i to namerno: izobličenje nastaje
 * na putu TASTATURE (HID čitač), a taj put ide pravo na backend (`resolve` u
 * `scan-overlay`), bez ovih predikata. Predikati rade nad tekstom koji je dekodirala
 * KAMERA, gde raspored tastature ne postoji. Dupliranje SR mape ovde ne bi ništa
 * popravilo, a moglo bi da pokvari šifre polica sa „Č"/„Ž".
 */
const RNZ_SHAPE =
  /^RNZ\s*[:|;]\s*(\d{1,10})\s*[:|;]\s*([0-9][0-9-]{0,12})\s*[/\\]\s*([A-Za-z0-9._/-]{1,64})\s*[:|;]\s*(\d+)\s*[:|;]\s*([A-Za-z0-9._-]{1,10})\s*$/i;

/** `{nalog}/{crtez}` — stara short nalepnica. */
const SHORT_SHAPE = /^(\d{1,8})\s*[/\\\-_ ]\s*(\d{1,10})$/;

/**
 * `{interniId}:{nalog}/{tp}:{varijanta}` — kompaktna nalepnica (čitač šalje i
 * `|`/`;`; BE isto pokriva kroz `normalizeNonRnzSeparators` pre `compactRe`).
 */
const COMPACT_SHAPE =
  /^(\d{1,10})\s*[:;|]\s*(\d{1,8})\s*[/\\]\s*([A-Za-z0-9._-]+)\s*[:;|]\s*(\d+)\s*$/i;

/** `S:{op}:{rc}:0:{rev}` — barkod OPERACIJE (strogo 5 polja, marker `S`). */
const OPERATION_SHAPE =
  /^S\s*[:|;]\s*[A-Za-z0-9._-]{1,16}\s*[:|;]\s*[A-Za-z0-9._-]{1,32}\s*[:|;]\s*[A-Za-z0-9._-]{1,16}\s*[:|;]\s*[A-Za-z0-9]{1,8}\s*$/i;

/** Da li kod IZGLEDA kao stavka za magacin (RNZ / short / compact). */
export function looksLikeLocItemBarcode(raw: unknown): boolean {
  return parseLocItemBarcode(raw) != null;
}

/** Rezultat klijentskog parsiranja ITEM nalepnice — podskup BE `ParsedBarcode`. */
export interface LocItemLabelParse {
  /** SIROVE grupe iz regexa — pozivalac primenjuje `normalizeLocMovementKeys` (9400 fold). */
  orderNo: string;
  itemRefId: string;
  /** Samo `short` nalepnica nosi crtež (RNZ/compact ga NEMAJU — dočitava se iz baze). */
  drawingNo: string;
  /** RNZ/compact: segment posle TP (ERP `varijanta`) — sužava lookup crteža. */
  varijanta?: string;
  format: 'rnz' | 'short' | 'compact';
  /** Očišćen tekst koji je stvarno parsiran (za banner „Skenirano: …"). */
  raw: string;
}

/**
 * Klijentsko parsiranje ITEM nalepnice (form-wedge hvatač + paste u polja
 * `movement-dialog`-a) — grupe NAD ISTIM regexima kao `looksLikeLocItemBarcode`,
 * poravnato sa BE `parseCleanBigTehnBarcode` (v. zaglavlje fajla za šta se ovde
 * NAMERNO ne radi: SR-wedge popravka, loose-compact, 9400 fold).
 */
export function parseLocItemBarcode(raw: unknown): LocItemLabelParse | null {
  const t = clean(raw);
  if (!t) return null;
  const rnz = RNZ_SHAPE.exec(t);
  if (rnz) {
    return { orderNo: rnz[2], itemRefId: rnz[3], drawingNo: '', varijanta: rnz[4], format: 'rnz', raw: t };
  }
  const short = SHORT_SHAPE.exec(t);
  if (short) {
    // Kao BE: `itemRefId = drawingNo` (short nalepnica identifikuje deo crtežom).
    return { orderNo: short[1], itemRefId: short[2], drawingNo: short[2], format: 'short', raw: t };
  }
  const compact = COMPACT_SHAPE.exec(t);
  if (compact) {
    return { orderNo: compact[2], itemRefId: compact[3], drawingNo: '', varijanta: compact[4], format: 'compact', raw: t };
  }
  return null;
}

/** Da li je kod barkod OPERACIJE (`S:…`) — za magacin neupotrebljiv. */
export function looksLikeOperationBarcode(raw: unknown): boolean {
  const t = clean(raw);
  if (!t) return false;
  return OPERATION_SHAPE.test(t);
}

/**
 * Fallback tekst kad backend ne stigne da vrati `message` za `kind:'OPERATION'`.
 * MORA ostati identičan `OPERATION_BARCODE_MESSAGE` u
 * `backend/src/modules/locations/barcode.ts` — poruka je jedna za mobilni i desktop.
 */
export const OPERATION_BARCODE_HINT =
  'Ovo je barkod OPERACIJE (red u tabeli naloga). Za magacin skeniraj barkod GORE DESNO u zaglavlju naloga ili nalepnicu TP.';

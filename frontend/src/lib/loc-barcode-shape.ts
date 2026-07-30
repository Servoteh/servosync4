/**
 * Lokacije/magacin — PREPOZNAVANJE OBLIKA barkoda na klijentu.
 *
 * ⚠️ Ovo NIJE parser i NE zamenjuje backend: razrešavanje ostaje na
 * `GET /v1/locations/lookups/barcode` (`backend/src/modules/locations/barcode.ts`,
 * veran port 1.0 `barcodeParse.js`). Ovde su samo GRUBI predikati oblika, potrebni
 * u dva trenutka kada nema vremena/mreže za backend:
 *
 *   1. IZBOR KODA IZ KADRA — kad nativni `BarcodeDetector` u jednom frejmu nađe
 *      više barkoda (na štampanom radnom nalogu barkodovi operacija stoje jedan
 *      pod drugim, pa kamera lako uhvati susedni red). Skener kroz
 *      `attachVideoDecoder({ preferMatching })` bira kod koji odgovara formatu
 *      koji ekran očekuje. Ako nijedan ne odgovara, dekoder vraća prvi kao i pre.
 *   2. FALLBACK PORUKA — ako backend nije odgovorio, skener ipak može da kaže da
 *      je skeniran barkod OPERACIJE (tekst je identičan `OPERATION_BARCODE_MESSAGE`
 *      sa backend-a, koji je i dalje jedini autoritet).
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

/** `RNZ:…` — barkod naloga / nalepnica TP (polje 5 alfanumeričko: revizija ili PrnTimer). */
const RNZ_SHAPE =
  /^RNZ\s*[:|]\s*\d{1,10}\s*[:|]\s*[0-9][0-9-]{0,12}\s*[/\\]\s*[A-Za-z0-9._/-]{1,64}\s*[:|]\s*\d+\s*[:|]\s*[A-Za-z0-9]{1,8}\s*$/i;

/** `{nalog}/{crtez}` — stara short nalepnica. */
const SHORT_SHAPE = /^\d{1,8}\s*[/\\\-_ ]\s*\d{1,10}$/;

/** `{interniId}:{nalog}/{tp}:{varijanta}` — kompaktna nalepnica (čitač šalje i `|`/`;`). */
const COMPACT_SHAPE =
  /^\d{1,10}\s*[:;|]\s*\d{1,8}\s*[/\\]\s*[A-Za-z0-9._-]+\s*[:;|]\s*\d+\s*$/i;

/** `S:{op}:{rc}:0:{rev}` — barkod OPERACIJE (strogo 5 polja, marker `S`). */
const OPERATION_SHAPE =
  /^S\s*[:|;]\s*[A-Za-z0-9._-]{1,16}\s*[:|;]\s*[A-Za-z0-9._-]{1,32}\s*[:|;]\s*[A-Za-z0-9._-]{1,16}\s*[:|;]\s*[A-Za-z0-9]{1,8}\s*$/i;

/** Da li kod IZGLEDA kao stavka za magacin (RNZ / short / compact). */
export function looksLikeLocItemBarcode(raw: unknown): boolean {
  const t = clean(raw);
  if (!t) return false;
  return RNZ_SHAPE.test(t) || SHORT_SHAPE.test(t) || COMPACT_SHAPE.test(t);
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

/**
 * Lokacije — parseri barkoda (VERAN port 1.0 `src/lib/barcodeParse.js` +
 * `src/lib/shelfBarcode.js`, MODULE_SPEC_lokacije_30.md §3, R1).
 *
 * Doktrina §C: parseri se NE pojednostavljuju. Logika je 1:1 sa 1.0 (isti
 * regexi, isti fallback lanci, iste poruke); jedina adaptacija je tipiziranje
 * za 2.0 (Prisma camelCase polja umesto snake_case) — semantika je netaknuta.
 * Fajl je čist (bez DB) da bude unit-testabilan kao 1.0 Vitest. Nevidljivi
 * znakovi u regexima su \uXXXX escape (izvor ostaje čist ASCII).
 *
 * Keyboard-wedge tolerancija (magacin, 30.07): isti stoni čitač koji radi na
 * kiosku pada u magacinu, jer je LEK postojao samo u `tech-processes/barcode.ts`.
 * Ovde se NE prepisuje — uvozi se (`normalizeScannerLayout`), vidi `repairWedgeScan`.
 */

import { normalizeScannerLayout } from "../tech-processes/barcode";

// ============================================================================
// 1) Item barkod: BigTehn RNZ / short / compact (barcodeParse.js)
// ============================================================================

export type BarcodeFormat = "rnz" | "short" | "ocr" | "compact";

export interface ParsedBarcode {
  /** Broj radnog naloga (npr. "7351"). */
  orderNo: string;
  /** Kompozitni/prost identifikator stavke → `loc_item_placements.item_ref_id`. */
  itemRefId: string;
  /** Broj crteža ako je u barkodu (short format); prazno u RNZ. */
  drawingNo: string;
  format: BarcodeFormat;
  /**
   * Očišćeni tekst koji je STVARNO parsiran. Kod keyboard-wedge očitanja to je
   * POPRAVLJENA verzija (`repairWedgeScan`), ne izobličeni original — isto kao
   * `parseBarcode.raw` na kiosku, i namerno: FE tim `raw`-om ponovo pita backend.
   */
  raw: string;
  /** RNZ: prvi broj (ID dokumenta). */
  idrn?: string;
  /** RNZ: segment posle TP (ERP kolona `varijanta`). */
  varijanta?: string;
  /**
   * RNZ polje 5 — verzioni pečat, NE koristi se za lookup. Legacy BigTehn je tu
   * imao numerički `PrnTimer` (npr. `39757`), a 3.0 štampa alfanumeričku
   * `work_orders.revision` (npr. `A`) — vidi `tech-processes/barcode.ts`.
   */
  field4?: string;
}

/**
 * Očisti sirov tekst barkoda: trim + skini CR/LF/TAB + Code39 `*...*` okvir +
 * nevidljive znakove (zero-width / BOM). Paritet 1.0 `normalizeBarcodeText`.
 */
export function normalizeBarcodeText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let t = raw.replace(/[\r\n\t]+/g, "").trim();
  if (t.startsWith("*") && t.endsWith("*") && t.length >= 3) {
    t = t.slice(1, -1);
  }
  // Nevidljivi znakovi iz dekodera / clipboard-a (U+200B–U+200D, U+FEFF).
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
  return t;
}

/**
 * Popravka očitanja sa STONOG (keyboard-wedge) čitača — identična kiosk lekovima
 * iz `tech-processes/barcode.ts` (dva zabeležena kvara iz pogona):
 *   1. 2026-07-17 — pogonski OS je na SR rasporedu, a čitač „kuca" US: svaki
 *      taster daje znak SR pozicije (`Z`→`Y`, `:`→`Č`, `/`→`-`, `-`→`'`).
 *      `normalizeScannerLayout` to vraća nazad, i to SAMO kad postoji nedvosmislen
 *      signal (SR dijakritik ili ćirilica) — bez signala vraća ulaz NEIZMENJEN,
 *      pa legitiman sadržaj sa `y`/`z`/`-` (npr. polica „ABY-1") ostaje netaknut.
 *   2. 2026-07-10 — `;` umesto `:` (čitač ne stigne da „drži" Shift). Redosled je
 *      isti kao na kiosku: prvo raspored, pa `;`→`:`, jer malo SR `č` daje `;`.
 *
 * Funkcija se koristi ISKLJUČIVO kao DRUGI POKUŠAJ (kad sirovo očitanje nije
 * prepoznato) — vidi `parseBigTehnBarcode`/`isOperationBarcode`. Time je nemoguće
 * da pokvari ijedan kod koji danas prolazi.
 */
function repairWedgeScan(clean: string): string {
  return normalizeScannerLayout(clean).trim().replace(/;/g, ":");
}

/**
 * Zamena tipičnih „šumova" samo za formate bez `RNZ` prefiksa (ne dirati `RNZ|…`).
 *
 * Zašto preskače `RNZ` (provereno 30.07): to je konzervativnost, NE poslovno
 * pravilo — nijedno polje RNZ oblika ne sme da sadrži `;`/`|` (`itemRefId` je
 * `[A-Za-z0-9._/-]`, a enkoder `assertNoSeparator` zabranjuje `:` u identu), pa
 * ovde nema šta da se pokvari. Gard ipak OSTAJE: RNZ grana `;` rešava u samom
 * regexu (klasa `[:|;]`, kao `OPERATION_BARCODE_RE`/`compactRe` u ovom fajlu),
 * a SR raspored kroz `repairWedgeScan` — pa je ovo mrtav put za RNZ.
 */
function normalizeNonRnzSeparators(s: string): string {
  if (!s || /^RNZ/i.test(s)) return s;
  return s
    .replace(/\uFF1A/g, ":") // fullwidth colon
    .replace(/\uFF0F/g, "/") // fullwidth slash
    .replace(/\|/g, ":")
    .replace(/;/g, ":")
    .trim();
}

/**
 * Skini vodeće Code128 grupne separatore (GS/RS/US = U+001D–U+001F) bez
 * regexa nad kontrolnim znakovima (eslint no-control-regex).
 */
function stripLeadingGroupSeparators(s: string): string {
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i);
    if (cp === 0x1d || cp === 0x1e || cp === 0x1f) i += 1;
    else break;
  }
  return s.slice(i);
}

/**
 * Poslednji fallback za kompakt nalepnicu (split) ako strogi regex ne prođe.
 * Uklanja Code128 prefiks `]C` + jedna cifra / GS; ne menja RNZ/short.
 */
function tryParseCompactLabelLoose(clean: string): ParsedBarcode | null {
  if (!clean || /^RNZ/i.test(clean)) return null;
  let s = stripLeadingGroupSeparators(clean)
    .replace(/^\]C\d/i, "")
    .trim();
  s = normalizeNonRnzSeparators(s);
  if (!/^\d/.test(s) || !s.includes(":") || !s.includes("/")) return null;
  const parts = s
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length !== 3) return null;
  const [idrn, mid, varijanta] = parts;
  if (!/^\d{1,10}$/.test(idrn) || !/^\d+$/.test(varijanta)) return null;
  const si = mid.indexOf("/");
  if (si < 1 || si >= mid.length - 1) return null;
  const orderNo = mid.slice(0, si).trim();
  const itemRefId = mid.slice(si + 1).trim();
  if (!/^\d{1,8}$/.test(orderNo)) return null;
  if (!itemRefId || !/^[A-Za-z0-9._-]+$/.test(itemRefId)) return null;
  return {
    orderNo,
    itemRefId,
    drawingNo: "",
    format: "compact",
    raw: clean,
    idrn,
    varijanta,
    field4: "",
  };
}

/**
 * Kanonski ključ za Lokacije (nalog + TP ref) — mora biti u skladu sa SQL
 * `loc_normalize_loc_movement_keys` (verifikovano na snapshot-u 12.07) i sa
 * `fetchBigtehnOpSnapshotByRnAndTp`. Paritet 1.0 `normalizeLocMovementKeys`.
 */
export function normalizeLocMovementKeys(
  orderNo: string | null | undefined,
  itemRefId: string | null | undefined,
): { orderNo: string; itemRefId: string } {
  const o = String(orderNo ?? "").trim();
  let r = String(itemRefId ?? "").trim();
  if (!o || !r) return { orderNo: o, itemRefId: r };
  const m9400 = o.match(/^9400-(\d+)$/);
  if (m9400 && /^\d+$/.test(r)) {
    return { orderNo: "9400", itemRefId: `${m9400[1]}/${r}` };
  }
  if (o === "9400" && /^-?\d+\/\d+$/.test(r)) {
    r = r.replace(/^-/, "");
    return { orderNo: "9400", itemRefId: r };
  }
  return { orderNo: o, itemRefId: r };
}

/**
 * RNZ „9400-2/415" → nalog 9400, TP ref 2/415. Samo ako je drugi segment RNZ-a
 * jedna numerička grana a TP čist broj. Paritet 1.0 `applyPredmet9400BranchFold`.
 */
function applyPredmet9400BranchFold(parsed: ParsedBarcode): ParsedBarcode {
  if (
    !parsed ||
    !parsed.orderNo ||
    parsed.itemRefId == null ||
    parsed.itemRefId === ""
  ) {
    return parsed;
  }
  const m = String(parsed.orderNo)
    .trim()
    .match(/^9400-(\d+)$/);
  if (!m) return parsed;
  const tp = String(parsed.itemRefId).trim();
  if (!/^\d+$/.test(tp)) return parsed;
  return { ...parsed, orderNo: "9400", itemRefId: `${m[1]}/${tp}` };
}

/**
 * Parsiraj BigTehn barkod iz RNZ, short ili kompaktne nalepnice.
 * `null` ako ni jedan format ne odgovara. Paritet 1.0 `parseBigTehnBarcode`.
 *
 * Keyboard-wedge (30.07): ako sirovo očitanje ne odgovara nijednom obliku, isti
 * ulaz se probava JOŠ JEDNOM kroz `repairWedgeScan` (SR raspored + `;`→`:`) —
 * tako stoni čitač koji već radi na kiosku radi i u magacinu. Prvi prolaz je
 * bajt-identičan dosadašnjem ponašanju, pa regresija nije moguća; drugi prolaz
 * se preskače kad popravka ništa ne menja (nema SR signala ni `;`).
 *
 * `raw` u rezultatu je tekst koji je STVARNO parsiran (dakle popravljen, kad je
 * popravka bila potrebna) — isto kao `parseBarcode` na kiosku. Bitno je jer FE
 * (`/mob/lokacije`) tim `raw`-om radi „osveži" upit ka backendu.
 */
export function parseBigTehnBarcode(raw: unknown): ParsedBarcode | null {
  const clean = normalizeBarcodeText(raw);
  if (!clean) return null;

  const direct = parseCleanBigTehnBarcode(clean);
  if (direct) return direct;

  const repaired = repairWedgeScan(clean);
  if (!repaired || repaired === clean) return null;
  return parseCleanBigTehnBarcode(repaired);
}

/** Jedan prolaz parsiranja nad već očišćenim tekstom (RNZ → short → compact). */
function parseCleanBigTehnBarcode(clean: string): ParsedBarcode | null {
  // RNZ — orderNo dozvoljava internu crticu (BigTehn revizijski sufiks), a
  // separator do tpNo je sužen na `/`/`\`; u itemRefId je dozvoljen i `/`.
  //
  // POLJE 5 JE ALFANUMERIČKO (ispravka 30.07): legacy BigTehn je tu imao
  // numerički `PrnTimer` pa je regex tražio `(\d+)`, ali zaglavlje NAŠEG
  // štampanog radnog naloga nosi `work_orders.revision` — SLOVO (`A`, VarChar(3),
  // default „A"; `formatOrderBarcode` u tech-processes/barcode.ts). Zbog toga
  // magacin NIJE mogao da pročita nalog koji sami štampamo (`RNZ:10354:9811-3/77:0:A`),
  // a stari BigTehn nalog (`RNZ:8693:7351/1088:0:39757`) je prolazio. Novi oblik je
  // NADSKUP starog (cifre i dalje prolaze) i ne dira ostala 4 polja; short/compact
  // grane su nedostupne za `RNZ…` ulaz (traže vodeću cifru), pa se ne mogu zamagliti.
  // Skup znakova polja 5 je namerno ŠIRI od „samo slova i cifre": `work_orders.revision`
  // je slobodan tekst (VarChar(3), bez validacije skupa znakova), pa enkoder sme da
  // otisne i „A-1" ili „1.2" — sa užim obrascem bi se isti kvar tiho vratio (review 30.07).
  //
  // SEPARATOR `;` (30.07): stoni keyboard-wedge čitač ume da propusti Shift pa
  // umesto `:` pošalje `;` (kvar iz pogona 2026-07-10, „rnz;10350;9400/3/120;0;44474").
  // Klasa je zato `[:|;]` — identično `OPERATION_BARCODE_RE` i `compactRe` NIŽE U
  // OVOM FAJLU, koji `;` primaju oduvek. Dvosmislenost ne nastaje: nijedno polje
  // RNZ oblika ne sme da sadrži `;` (`itemRefId` je `[A-Za-z0-9._/-]`, orderNo `[0-9-]`).
  const rnz = clean.match(
    /^RNZ\s*[:|;]\s*(\d{1,10})\s*[:|;]\s*([0-9][0-9-]{0,12})\s*[/\\]\s*([A-Za-z0-9._/-]{1,64})\s*[:|;]\s*(\d+)\s*[:|;]\s*([A-Za-z0-9._-]{1,10})\s*$/i,
  );
  if (rnz) {
    const [, idrn, orderNo, itemRefId, varijanta, field4] = rnz;
    return applyPredmet9400BranchFold({
      orderNo,
      itemRefId,
      drawingNo: "",
      format: "rnz",
      raw: clean,
      idrn,
      varijanta,
      field4,
    });
  }

  // Short format — legacy nalepnice; dozvoljene varijacije razdvajača.
  const short = clean.match(/^(\d{1,8})\s*[/\\\-_ ]\s*(\d{1,10})$/);
  if (short) {
    const [, orderNo, drawingNo] = short;
    return {
      orderNo,
      itemRefId: drawingNo,
      drawingNo,
      format: "short",
      raw: clean,
    };
  }

  // Kompaktna nalepnica: `interni:nalog/tp:var` (čitač često šalje `|` umesto `:`).
  const compactRe =
    /^(\d{1,10})\s*[:;]\s*(\d{1,8})\s*[/\\]\s*([A-Za-z0-9._-]+)\s*[:;]\s*(\d+)\s*$/i;
  const seen = new Set<string>();
  for (const cand of [clean, normalizeNonRnzSeparators(clean)]) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    const compact = cand.match(compactRe);
    if (compact) {
      const [, idrn, orderNo, itemRefId, varijanta] = compact;
      return applyPredmet9400BranchFold({
        orderNo,
        itemRefId,
        drawingNo: "",
        format: "compact",
        raw: clean,
        idrn,
        varijanta,
        field4: "",
      });
    }
  }

  const looseCompact = tryParseCompactLabelLoose(clean);
  if (looseCompact) return applyPredmet9400BranchFold(looseCompact);

  return null;
}

/**
 * Barkod OPERACIJE — `S:{operacija}:{radniCentar}:0:{revizija}` (red u tabeli
 * štampanog RN-a). Za MAGACIN je bez upotrebe: ne nosi ni nalog ni TP, pa ne
 * identifikuje deo; služi PRIJAVI RADA na kiosku (kiosk skenira prvo nalog, pa
 * operaciju — `tech-processes/barcode.ts`). Prepoznajemo ga SAMO da bi korisnik
 * dobio konkretnu poruku umesto „Nepoznat format" (na štampanom RN-u barkodovi
 * operacija stoje jedan pod drugim pa kamera lako uhvati susedni red).
 *
 * Regex je NAMERNO strog (tačno 5 polja, marker `S`) — ne sme da proglasi
 * operacijom nijedan drugi format (RNZ ima svoj prefiks, short/compact počinju
 * cifrom, `LP:` polica ima `LP` marker, a šifra police ne nosi 4 separatora).
 */
const OPERATION_BARCODE_RE =
  /^S\s*[:|;]\s*([A-Za-z0-9._-]{1,16})\s*[:|;]\s*([A-Za-z0-9._-]{1,32})\s*[:|;]\s*([A-Za-z0-9._-]{1,16})\s*[:|;]\s*([A-Za-z0-9]{1,8})\s*$/i;

/**
 * Da li je sirov tekst barkod OPERACIJE (`S:…`) — vidi `OPERATION_BARCODE_RE`.
 *
 * Isti keyboard-wedge drugi pokušaj kao u `parseBigTehnBarcode`: `;` regex prima
 * oduvek, ali SR raspored („SČ5Č1.10Č0Č33769") ne — bez popravke bi takav sken
 * ispao „Nepoznat format" umesto da dobije uputstvo gde je barkod naloga.
 */
export function isOperationBarcode(raw: unknown): boolean {
  const clean = normalizeBarcodeText(raw);
  if (!clean) return false;
  if (OPERATION_BARCODE_RE.test(clean)) return true;
  const repaired = repairWedgeScan(clean);
  return repaired !== clean && OPERATION_BARCODE_RE.test(repaired);
}

/**
 * Jedinstvena poruka za skeniran barkod operacije — backend je vraća u
 * `lookupBarcode`, pa i mobilni i desktop skener kažu ISTO (bez dupliranja
 * teksta po ekranima).
 */
export const OPERATION_BARCODE_MESSAGE =
  "Ovo je barkod OPERACIJE (red u tabeli naloga). Za magacin skeniraj barkod GORE DESNO u zaglavlju naloga ili nalepnicu TP.";

/**
 * Da li placement pripada paru (predmet, TP, crtež) — ista semantika kao JOIN u
 * `loc_tps_for_predmet` v3. Paritet 1.0 `placementRowMatchesPredmetTp`
 * (adaptirano na Prisma camelCase polja).
 */
export interface PlacementMatchRow {
  itemRefId?: string | null;
  orderNo?: string | null;
  drawingNo?: string | null;
  quantity?: unknown;
}

export function placementRowMatchesPredmetTp(
  row: PlacementMatchRow,
  orderNo: string,
  tpRef: string,
  drawingNo?: string,
): boolean {
  if (!row || Number(row.quantity) <= 0) return false;
  const norm = normalizeLocMovementKeys(
    String(orderNo ?? "").trim(),
    String(tpRef ?? "").trim(),
  );
  const o = norm.orderNo;
  const t = norm.itemRefId;
  const d = String(drawingNo ?? "").trim();
  const iid = String(row.itemRefId ?? "").trim();
  const on = String(row.orderNo ?? "").trim();
  const dn = String(row.drawingNo ?? "").trim();

  if (d && dn === d) {
    if (!o || !on || on === o) return true;
    return false;
  }

  const orderOk = !o || !on || on === o;
  if (!orderOk) return false;

  if (t && iid === t) return true;
  if (o && t && iid === `${o}/${t}`) return true;
  if (d && iid === d) return true;

  return false;
}

// ============================================================================
// 2) Shelf barkod: LP:uuid:uuid + "HALA - POLICA" + sama šifra police
//    (VERAN port shelfBarcode.js + potrebni lokacijeTypes.js predikati)
// ============================================================================

/** Poslovna klasifikacija `loc_locations.location_type` (lokacijeTypes.js). */
const HALL_TYPES = new Set([
  "WAREHOUSE",
  "PRODUCTION",
  "ASSEMBLY",
  "FIELD",
  "TEMP",
]);
const SHELF_TYPES = new Set(["SHELF", "RACK", "BIN"]);
/** Kavez (prenosivi) — globalna skladišna lokacija, šifra `KV 1`…`KV 100`. */
const CAGE_TYPES = new Set(["CAGE"]);

function normalizeLocType(type: string | null | undefined): string {
  return String(type ?? "")
    .trim()
    .toUpperCase();
}
export function isHallType(type: string | null | undefined): boolean {
  return HALL_TYPES.has(normalizeLocType(type));
}
export function isShelfType(type: string | null | undefined): boolean {
  return SHELF_TYPES.has(normalizeLocType(type));
}
export function isCageType(type: string | null | undefined): boolean {
  return CAGE_TYPES.has(normalizeLocType(type));
}

/** Lokacija kako je vidi resolver (Prisma camelCase; logika ista kao 1.0). */
export interface ShelfLoc {
  id: string;
  locationCode?: string | null;
  locationType?: string | null;
  parentId?: string | null;
  isActive?: boolean | null;
}

export type ShelfResolve =
  | { ok: true; loc: ShelfLoc; presetHallFilterId: string | null }
  | { ok: false; msg: string };

const LP_COMPOSITE =
  /^LP:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const UUID_HEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mapGetUuid(
  locById: Map<string, ShelfLoc> | undefined,
  uuid: string,
): ShelfLoc | undefined {
  if (!locById) return undefined;
  const u = String(uuid || "").trim();
  const v = locById.get(u);
  if (v) return v;
  const lower = u.toLowerCase();
  for (const [k, row] of locById) {
    if (String(k).toLowerCase() === lower) return row;
  }
  return undefined;
}

/** Najbliži predak tipa HALA za datu lokaciju. Paritet 1.0 `nearestHallAncestorId`. */
export function nearestHallAncestorId(
  loc: ShelfLoc,
  locById: Map<string, ShelfLoc>,
): string | null {
  if (!loc || !locById?.size) return null;
  let cur: ShelfLoc | undefined = loc;
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    if (!cur?.id || seen.has(cur.id)) return null;
    seen.add(cur.id);
    const pid = cur.parentId ? String(cur.parentId) : "";
    if (!pid) return null;
    const p = mapGetUuid(locById, pid);
    if (!p) return null;
    if (isHallType(p.locationType)) return String(p.id);
    cur = p;
  }
  return null;
}

function codesInsensitiveEq(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return (
    String(a ?? "")
      .trim()
      .toLowerCase() ===
    String(b ?? "")
      .trim()
      .toLowerCase()
  );
}

/** `halaŠifra - policaŠifra` — prvi blok sa „ - " deli hala|polica (Unicode crtice takođe). */
export function parseShortShelfBarcodePair(
  t: string,
): { hallCode: string; shelfCode: string } | null {
  const raw = String(t || "")
    .trim()
    .replace(/\u2013|\u2014/g, "-"); // en/em dash → ASCII crtica
  if (!raw || /^LP:/i.test(raw)) return null;
  const m = /^(.+?)\s+-\s+(.+)$/s.exec(raw.trim());
  if (!m) return null;
  const hallCode = m[1].trim();
  const shelfCode = m[2].trim();
  if (!hallCode || !shelfCode) return null;
  return { hallCode, shelfCode };
}

function locIsActiveShelfMatchingCode(l: ShelfLoc, needle: string): boolean {
  return (
    !!l &&
    l.isActive !== false &&
    isShelfType(l.locationType) &&
    codesInsensitiveEq(l.locationCode, needle)
  );
}

export function resolveShortShelfBarcodePair(
  pair: { hallCode: string; shelfCode: string },
  locs: ShelfLoc[],
  locById: Map<string, ShelfLoc>,
): ShelfResolve {
  const hc = pair.hallCode.trim();
  const sc = pair.shelfCode.trim();
  const shelvesHit = locs.filter((l) => locIsActiveShelfMatchingCode(l, sc));
  const narrowed: ShelfLoc[] = [];
  for (const sh of shelvesHit) {
    const hid = nearestHallAncestorId(sh, locById);
    if (!hid) continue;
    const hallLoc = mapGetUuid(locById, hid);
    if (
      !hallLoc ||
      hallLoc.isActive === false ||
      !isHallType(hallLoc.locationType)
    )
      continue;
    if (codesInsensitiveEq(hallLoc.locationCode, hc)) narrowed.push(sh);
  }
  if (!narrowed.length) {
    return {
      ok: false,
      msg: "Ne postoji aktivna polica za ovaj par (hala − polica) u master lokacija.",
    };
  }
  if (narrowed.length > 1) {
    return {
      ok: false,
      msg: "Dvostruko poklapanje šifara u master-u — pojedinačne šifre moraju ostati jednoznačne.",
    };
  }
  const shelf = narrowed[0];
  const hidFinal = nearestHallAncestorId(shelf, locById);
  const hallLoc = hidFinal ? mapGetUuid(locById, hidFinal) : undefined;
  if (!hidFinal || !hallLoc?.id)
    return {
      ok: false,
      msg: "Nadređena hala za ovu policu nedostaje u master-u.",
    };
  return { ok: true, loc: shelf, presetHallFilterId: String(hallLoc.id) };
}

/** Samo kod police — ako je globalno jedinstven među SHELF/RACK/BIN aktivnim lokacijama. */
function resolveShelfUniqueByShelfCodeGlobally(
  code: string,
  locs: ShelfLoc[],
  locById: Map<string, ShelfLoc>,
): ShelfResolve | null {
  const trimmed = String(code || "").trim();
  if (
    !trimmed ||
    /^LP:/i.test(trimmed) ||
    UUID_HEX.test(trimmed) ||
    trimmed.includes(" - ")
  ) {
    return null;
  }
  const shelves = locs.filter((l) => locIsActiveShelfMatchingCode(l, trimmed));
  if (shelves.length !== 1) return null;
  const shelf = shelves[0];
  const hidFinal = nearestHallAncestorId(shelf, locById);
  const hallLoc = hidFinal ? mapGetUuid(locById, hidFinal) : undefined;
  const presetHall = hallLoc?.id ? String(hallLoc.id) : null;
  return { ok: true, loc: shelf, presetHallFilterId: presetHall };
}

export function parseShelfCompositeBarcodeToken(
  t: string,
): { hallId: string; shelfId: string } | null {
  const m = LP_COMPOSITE.exec(String(t || "").trim());
  if (!m) return null;
  return { hallId: m[1], shelfId: m[2] };
}

function resolveLpUuidComposite(
  p: { hallId: string; shelfId: string },
  locById: Map<string, ShelfLoc>,
): ShelfResolve {
  const shelf = mapGetUuid(locById, p.shelfId);
  if (!shelf || shelf.isActive === false) {
    return {
      ok: false,
      msg: "Nema aktivne police za ovaj barkod (proveri štampanu nalepnicu).",
    };
  }
  if (!isShelfType(shelf.locationType)) {
    return {
      ok: false,
      msg: "Barkod pokazuje lokaciju koja nije polica/regal/KES.",
    };
  }

  const hall = mapGetUuid(locById, p.hallId);
  if (!hall || hall.isActive === false || !isHallType(hall.locationType)) {
    return {
      ok: false,
      msg: "Hala iz barkoda nije u aktivnom masteru lokacija (ILI / zastarela nalepnica).",
    };
  }

  const ancestorId = nearestHallAncestorId(shelf, locById);
  const want = String(p.hallId).toLowerCase();
  const got = ancestorId ? String(ancestorId).toLowerCase() : "";
  if (!ancestorId || got !== want) {
    return {
      ok: false,
      msg: "Barkod ne odgovara trenutnoj strukturi lokacija (proveri kojoj hali polica sad pripada).",
    };
  }

  return { ok: true, loc: shelf, presetHallFilterId: String(hall.id) };
}

// ============================================================================
// 3) GOLI kod skladišne lokacije (kavez `KV 6`…) — port 1.0 plain-lookup grane
// ============================================================================

/**
 * Skladišne HALE za goli sken — NAMERNO BEZ `FIELD`-a: na produ (izmereno
 * 04.08.2026) FIELD = 100% reversi `ZADU-R-*`/`ZADU-O-*` lične lokacije
 * zaduženja, ne skladišne destinacije (ista čistka kao FE
 * `location-select.NON_STORAGE_TYPES` — ZADU rupa se NE otvara nazad).
 */
const STORAGE_HALL_TYPES = new Set([
  "WAREHOUSE",
  "PRODUCTION",
  "ASSEMBLY",
  "TEMP",
]);

/**
 * Reversi barkod konvencija (`ZADU-R-*` radnici, `ZADU-O-*` odeljenja,
 * `ZADU-M-*` mašine — v. `reversi.service.lookupBarcode`). `ZADU-M-*` su tipa
 * PRODUCTION, pa uz tipove važi i prefiks — identično FE `isStorageLocation`.
 */
const ZADU_CODE_RE = /^ZADU-/i;

/**
 * Aktivna STVARNO skladišna lokacija — sme da se razreši golim kodom sa
 * nalepnice: kavez / polica-regal-KES / skladišna hala / mašina (pseudo-lokacija
 * mašine je legitimna destinacija — FE je nudi iza prekidača „Prikaži i mašine").
 * NE-skladišni razredi (FIELD/SERVICE/PROJECT/TRANSIT/OFFICE/SCRAPPED/OTHER i
 * svaki `ZADU-*` kod) se NIKAD ne rešavaju ovim putem.
 */
function isStorageScanLocation(l: ShelfLoc): boolean {
  if (!l || l.isActive === false) return false;
  if (ZADU_CODE_RE.test(String(l.locationCode ?? "").trim())) return false;
  const t = normalizeLocType(l.locationType);
  return (
    CAGE_TYPES.has(t) ||
    SHELF_TYPES.has(t) ||
    STORAGE_HALL_TYPES.has(t) ||
    t === "MACHINE"
  );
}

/** Šifra bez ijednog razmaka, lowercase — tolerancija skena `KV6`/`kv 6`. */
function squishLocationCode(code: string | null | undefined): string {
  return String(code ?? "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * GOLI kod aktivne SKLADIŠNE lokacije — dopuna pariteta sa 1.0 (04.08.2026).
 *
 * KOREN prijave: kamera je na mob premeštanju uredno dekodirala kavez nalepnicu
 * (CODE128 payload `KV 6` — 1.0 `labelsPrint` na kavez štampa PUN
 * `location_code`, veliki broj „6" je samo ljudski natpis), ali je 3.0 vraćao
 * „Nepoznat format: KV 6": `resolveShelfUniqueByShelfCodeGlobally` prima SAMO
 * SHELF/RACK/BIN, a 1.0-in DRUGI stepenik — plain lookup po `location_code` u
 * `scanModal.resolveDestinationByToken` (posle composite resolvera, prihvata
 * SVAKI tip pa i kavez) — nikad nije portovan.
 *
 * Ovo je taj stepenik, SUŽEN na skladišne tipove (v. `isStorageScanLocation`):
 * 1.0 bi golim kodom razrešio i `ZADU-R-*` (FIELD) — čistka od 04.08.2026 to
 * više ne dozvoljava, i ovaj port je NE vraća. Pravila:
 *   • egzaktan (case-insensitive) pogodak ima prednost; bez pogotka se probava
 *     poređenje BEZ razmaka (`KV6`/`kv 6` → `KV 6`);
 *   • tačno 1 skladišni pogodak → lokacija (+ najbliža hala kao preset filter;
 *     kavezi su globalni — parent uglavnom NULL → preset nema, i to je u redu);
 *   • više pogodaka → jasna poruka (nikad nasumičan izbor) — za duple šifre
 *     polica ostaje kompozit „ŠIFRA HALE - ŠIFRA POLICE" jedini put;
 *   • pogodak SAMO na ne-skladišnoj lokaciji → poruka ZAŠTO (ne „Nepoznat
 *     format"); nula pogodaka → `null` (dalje važi „Nepoznat format").
 */
export function resolveStorageLocationByCode(
  code: string,
  locs: ShelfLoc[],
  locById: Map<string, ShelfLoc>,
): ShelfResolve | null {
  const trimmed = String(code || "").trim();
  if (
    !trimmed ||
    /^LP:/i.test(trimmed) ||
    UUID_HEX.test(trimmed) ||
    trimmed.includes(" - ")
  ) {
    return null;
  }

  const isActive = (l: ShelfLoc) => !!l && l.isActive !== false;
  let hits = locs.filter(
    (l) => isActive(l) && codesInsensitiveEq(l.locationCode, trimmed),
  );
  if (!hits.length) {
    const sq = squishLocationCode(trimmed);
    if (sq) {
      hits = locs.filter(
        (l) => isActive(l) && squishLocationCode(l.locationCode) === sq,
      );
    }
  }
  if (!hits.length) return null;

  const storage = hits.filter(isStorageScanLocation);
  if (!storage.length) {
    const display = String(hits[0].locationCode ?? "").trim() || trimmed;
    if (
      hits.some((l) => ZADU_CODE_RE.test(String(l.locationCode ?? "").trim()))
    ) {
      return {
        ok: false,
        msg: `Lokacija „${display}" je reversi zaduženje (lična/mašinska), ne skladišna — ne može biti polazna ni odredišna lokacija.`,
      };
    }
    const t = normalizeLocType(hits[0].locationType) || "?";
    return {
      ok: false,
      msg: `Lokacija „${display}" nije skladišna (tip ${t}) — ne može biti polazna ni odredišna lokacija.`,
    };
  }
  if (storage.length > 1) {
    return {
      ok: false,
      msg: `Šifra „${trimmed}" nije jednoznačna — nosi je ${storage.length} aktivnih lokacija. Za policu skeniraj kompozitnu nalepnicu („ŠIFRA HALE - ŠIFRA POLICE") ili izaberi lokaciju ručno.`,
    };
  }

  const loc = storage[0];
  const hid = nearestHallAncestorId(loc, locById);
  const hall = hid ? mapGetUuid(locById, hid) : undefined;
  return {
    ok: true,
    loc,
    presetHallFilterId: hall?.id ? String(hall.id) : null,
  };
}

/**
 * Jednoznačno odredi policu + halu: `LP:…`, kratko `ŠIF_HALE - ŠIF_POLICE`, ili
 * sama šifra police ako je jedinstvena. `null` kad format nije naš kompozit.
 * Paritet 1.0 `resolveCompositeShelfScan` + (04.08.2026) goli kod skladišne
 * lokacije (`resolveStorageLocationByCode` — 1.0 plain-lookup stepenik iz
 * `scanModal.resolveDestinationByToken`, sužen na skladišne tipove). Redosled je
 * 1.0-ov: composite (LP → par → jedinstvena polica) pre golog koda, pa
 * jedinstvena šifra police i dalje ide istom granom kao do sada.
 */
export function resolveCompositeShelfScan(
  trimmedNormalized: string,
  locs: ShelfLoc[],
  locById: Map<string, ShelfLoc>,
): ShelfResolve | null {
  const t = String(trimmedNormalized || "").trim();
  const lpTok = parseShelfCompositeBarcodeToken(t);
  if (lpTok) return resolveLpUuidComposite(lpTok, locById);

  const pair = parseShortShelfBarcodePair(t);
  if (pair) return resolveShortShelfBarcodePair(pair, locs, locById);

  const uniq = resolveShelfUniqueByShelfCodeGlobally(t, locs, locById);
  if (uniq) return uniq;

  return resolveStorageLocationByCode(t, locs, locById);
}

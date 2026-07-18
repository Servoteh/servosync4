import { BadRequestException } from "@nestjs/common";

/**
 * Barkod prijave rada (kiosk write-path) + generisanje barkoda za štampu RN-a
 * (MODULE_SPEC_stampa §3). NISU jedan nego **DVA** barkoda, svaki 5 polja
 * (4 separatora `:`):
 *   - **nalog**     `RNZ:projectId:identNumber:variant:revision`
 *   - **operacija** `S:operationNumber:workCenterCode:0:revision`
 *
 * **Polje 5 = `revision`** RN-a (verzioni pečat). Nalog i sve njegove operacije
 * dele ISTU reviziju, pa `revision` služi dvostruko:
 *   1. „isti otisak" — operacioni barkod mora imati istu `revision` kao nalog
 *      (provera u servisu; barkodovi sa različitom revizijom ne pripadaju istom otisku);
 *   2. detekcija **zastarelog otiska** — skenirana `revision` se poredi sa tekućom
 *      `work_orders.revision`; neslaganje = štampan pre izmene tehnologije/crteža
 *      → UPOZORENJE (ne blokada). Vidi MODULE_SPEC_stampa §5.
 *
 * Istorija: legacy QBigTehn je u polju 5 imao `PrnTimer` (= `CLng(Timer)`, sekunde
 * od ponoći) kao verzioni pečat — 2.0 to menja u `revision` (logičnije, bez reseta
 * i sudara). Polje 4 operacije = literal `0` (verno legacy `rRN`; skener ga čita kao
 * `identMark`). Marker: TAČAN prvi segment (`RNZ` nalog / `S` operacija).
 *
 * Keyboard-wedge tolerancija (pogon): skener „kuca" kao tastatura, pa raspored i
 * modifikatori OS-a izobličavaju znakove pre nego što stignu do `parseBarcode`.
 * Normalizujemo ih pre parsiranja:
 *   1. 2026-07-10 — `;`→`:` (propušten Shift) + marker/revizija case-insensitive
 *      (nestabilan CapsLock/brzina); npr. "rnz;10350;9400/3/120;0;44474".
 *   2. 2026-07-17 — SR raspored tastature (`normalizeScannerLayout`): skener je
 *      programiran za US raspored, a pogonski OS je na SR latinici/ćirilici, pa
 *      svaki taster daje znak SR pozicije — npr. očitano "RNYČ9470Č9000-236Č0Č33769"
 *      umesto "RNZ:9470:9000/236:0:33769". Inverzno mapiramo po poziciji tastera.
 */

/** Polja iz nalog-barkoda (`RNZ:projectId:identNumber:variant:revision`). */
export interface OrderBarcodeFields {
  /** IDPredmet → `work_orders.projectId` / `tech_processes.projectId`. */
  projectId: number;
  /** IdentBroj → `identNumber` (broj RN-a, npr. `1234/5`). */
  identNumber: string;
  /** Varijanta → `variant`. */
  variant: number;
  /** Revizija RN-a → `work_orders.revision` (verzioni pečat; legacy: PrnTimer). */
  revision: string;
}

/** Polja iz operacija-barkoda (`S:operationNumber:workCenterCode:0:revision`). */
export interface OperationBarcodeFields {
  /** Operacija → `tech_processes.operationNumber` (null ako nije ceo broj). */
  operationNumber: number | null;
  /** Sirova vrednost polja Operacija (za dijagnostiku/echo). */
  operationRaw: string;
  /** RJgrupaRC → `tech_processes.workCenterCode` (FK ka `operations`). */
  workCenterCode: string;
  /** Polje 4 (Toznaka u legacy `rRNStavke`; u `rRN` i 2.0 = literal `0`). */
  identMark: string;
  /** Revizija RN-a → `work_orders.revision` (isti kao nalog; legacy: PrnTimer). */
  revision: string;
}

export type DecodedBarcode =
  | { type: "nalog"; raw: string; marker: "RNZ"; fields: OrderBarcodeFields }
  | {
      type: "operacija";
      raw: string;
      marker: "S";
      fields: OperationBarcodeFields;
    };

function parseIntStrict(value: string, name: string): number {
  const s = value.trim();
  if (!/^-?\d+$/.test(s))
    throw new BadRequestException(
      `Barkod polje '${name}' mora biti ceo broj (dobijeno: '${value}').`,
    );
  const n = Number.parseInt(s, 10);
  if (!Number.isSafeInteger(n))
    throw new BadRequestException(`Barkod polje '${name}' je van opsega.`);
  return n;
}

/**
 * Polje 5 = revizija (string). Legacy barkodovi tu nose numerički `PrnTimer`, a
 * 2.0 alfanumeričku reviziju (npr. `A`) — zato NE parsiramo kao ceo broj, samo
 * tražimo da je neprazno. Poređenje sa `work_orders.revision` radi servis.
 */
function parseRevision(value: string): string {
  // Uppercase: keyboard-wedge skener sa nestabilnim CapsLock-om sme da pošalje "a"
  // u jednom skenu a "A" u drugom — poređenje „isti otisak" ne sme da padne na tome.
  const s = value.trim().toUpperCase();
  if (!s)
    throw new BadRequestException(
      "Barkod polje 'Revizija' (polje 5) je obavezno.",
    );
  return s;
}

/**
 * Inverzna mapa SR LATINICA (Windows „Serbian (Latin)", QWERTZ) → US raspored,
 * po POZICIJI tastera. Skener šalje keystroke za US znak, a OS na SR latinici
 * vrati znak sa te iste pozicije; ovde vraćamo original. Jedan prolaz (bez
 * lančanja) — svaki izvorni znak ima tačno jedan cilj, pa se `ć`→`'` i `'`→`-`
 * ne primenjuju dvaput. `;` NAMERNO nije u mapi (ostaje `;` → hvata ga postojeća
 * `;`→`:` zamena; tako i mala `č`→`;`→`:`).
 */
const SR_LATIN_TO_US: Record<string, string> = {
  // dijakritici → interpunkcija (pozicija tastera)
  č: ";",
  Č: ":",
  ć: "'",
  Ć: '"',
  š: "[",
  Š: "{",
  đ: "]",
  Đ: "}",
  ž: "\\",
  Ž: "|",
  // QWERTZ zamena slova (bijekcija, čuva velika/mala)
  y: "z",
  z: "y",
  Y: "Z",
  Z: "Y",
  // interpunkcija po poziciji tastera
  "-": "/",
  "'": "-",
  _: "?",
  "?": "_",
  "+": "=",
  "*": "+",
};

/**
 * Inverzna mapa SR ĆIRILICA (Windows „Serbian (Cyrillic)") → US raspored, po
 * poziciji tastera — za pogonske računare na ćirilici. Slova mapiraju na US
 * poziciju; interpunkcija na istim pozicijama kao latinica. Neizvestan znak
 * radije izostavljen nego pogrešno zamenjen.
 */
const SR_CYRILLIC_TO_US: Record<string, string> = {
  // red Q (QWERTY)
  љ: "q",
  њ: "w",
  е: "e",
  р: "r",
  т: "t",
  з: "y",
  у: "u",
  и: "i",
  о: "o",
  п: "p",
  ш: "[",
  ђ: "]",
  // red A
  а: "a",
  с: "s",
  д: "d",
  ф: "f",
  г: "g",
  х: "h",
  ј: "j",
  к: "k",
  л: "l",
  ч: ";",
  ћ: "'",
  ж: "\\",
  // red Z
  ѕ: "z",
  џ: "x",
  ц: "c",
  в: "v",
  б: "b",
  н: "n",
  м: "m",
  // velika slova (shift verzije istih pozicija)
  Љ: "Q",
  Њ: "W",
  Е: "E",
  Р: "R",
  Т: "T",
  З: "Y",
  У: "U",
  И: "I",
  О: "O",
  П: "P",
  Ш: "{",
  Ђ: "}",
  А: "A",
  С: "S",
  Д: "D",
  Ф: "F",
  Г: "G",
  Х: "H",
  Ј: "J",
  К: "K",
  Л: "L",
  Ч: ":",
  Ћ: '"',
  Ж: "|",
  Ѕ: "Z",
  Џ: "X",
  Ц: "C",
  В: "V",
  Б: "B",
  Н: "N",
  М: "M",
  // interpunkcija po poziciji tastera (iste pozicije kao latinica)
  "-": "/",
  "'": "-",
  _: "?",
  "?": "_",
  "+": "=",
  "*": "+",
};

/** Prisustvo bilo kog SR-latiničnog dijakritika = nedvosmislen signal izobličenja. */
const SR_LATIN_SIGNAL = /[čćšđžČĆŠĐŽ]/;
/** Prisustvo bilo kog ćiriličnog znaka = nedvosmislen signal izobličenja. */
const SR_CYRILLIC_SIGNAL = /[Ѐ-ӿ]/;

function remapByPosition(input: string, map: Record<string, string>): string {
  return Array.from(input, (ch) => map[ch] ?? ch).join("");
}

/**
 * Normalizuje sken sa pogonskog računara koji je na SR rasporedu tastature nazad
 * u US raspored (za koji je skener programiran). Primenjuje se SAMO kad postoji
 * nedvosmislen signal izobličenja (SR dijakritik ili ćirilica) — bez signala se
 * ulaz vraća NEIZMENJEN, da legitiman sadržaj sa `y`/`z`/`-` (npr. „ABY-1") ne
 * bi bio pogrešno preslikan. Ćirilica ima prednost (specifičniji signal).
 * Pogon 2026-07-17: očitano "RNYČ9470Č…" umesto "RNZ:9470:…".
 */
export function normalizeScannerLayout(input: string): string {
  if (SR_CYRILLIC_SIGNAL.test(input))
    return remapByPosition(input, SR_CYRILLIC_TO_US);
  if (SR_LATIN_SIGNAL.test(input))
    return remapByPosition(input, SR_LATIN_TO_US);
  return input;
}

/**
 * Parsira i validira JEDAN barkod (nalog ili operacija). Baca `BadRequestException`
 * (→ 400) na svaki nevalidan ulaz. Ne dodiruje bazu.
 */
export function parseBarcode(input: string): DecodedBarcode {
  if (typeof input !== "string")
    throw new BadRequestException("Barkod mora biti string.");
  // Keyboard-wedge tolerancija (pogon, prod logovi). Redosled je bitan:
  //   1. SR raspored tastature (2026-07-17): skener programiran za US, OS na SR
  //      latinici/ćirilici → znak SR pozicije; inverzno mapiramo PRE svega, jer
  //      SR-latinično malo 'č' daje ';' koje tek sledeći korak pretvara u ':'.
  //      Bez SR signala (dijakritik/ćirilica) ostaje neizmenjeno.
  //   2. ';'→':' (2026-07-10): skener ne stigne da „drži" Shift (identi ne sadrže
  //      ';'). Marker i revizija su case-insensitive (nestabilan CapsLock/brzina).
  //   npr. "RNYČ9470Č9000-236Č0Č33769" → "RNZ:9470:9000/236:0:33769".
  const raw = normalizeScannerLayout(input).trim().replace(/;/g, ":");
  if (!raw) throw new BadRequestException("Barkod je prazan.");

  // 🔴 Struktura: tačno 4 separatora → 5 polja. Greška PRIKAZUJE očitani sadržaj
  // (dijagnostika iz pogona: pogrešan barkod sa papira — npr. broj crteža, presečen
  // sken, pogrešan raspored tastature skenera...).
  const separatorCount = (raw.match(/:/g) ?? []).length;
  if (separatorCount !== 4) {
    const shown = raw.length > 48 ? `${raw.slice(0, 48)}…` : raw;
    throw new BadRequestException(
      `Barkod mora imati tačno 4 separatora ':' (5 polja), a ima ${separatorCount}. Očitano: „${shown}" — skenirajte barkod NALOGA (RNZ) ili OPERACIJE (S), ne npr. barkod crteža.`,
    );
  }
  const parts = raw.split(":");

  // Marker case-insensitive (CapsLock na skener-terminalu: "rnz"/"rNZ"/"s").
  const marker = parts[0].toUpperCase();
  if (marker === "RNZ") {
    const fields: OrderBarcodeFields = {
      projectId: parseIntStrict(parts[1], "IDPredmet"),
      identNumber: parts[2].trim(),
      variant: parseIntStrict(parts[3], "Varijanta"),
      revision: parseRevision(parts[4]),
    };
    if (fields.projectId <= 0)
      throw new BadRequestException(
        "Barkod polje 'IDPredmet' mora biti pozitivan ceo broj.",
      );
    if (!fields.identNumber)
      throw new BadRequestException("Barkod polje 'IdentBroj' je obavezno.");
    return { type: "nalog", raw, marker: "RNZ", fields };
  }

  if (marker === "S") {
    const operationRaw = parts[1].trim();
    const workCenterCode = parts[2].trim();
    const fields: OperationBarcodeFields = {
      operationRaw,
      operationNumber: /^-?\d+$/.test(operationRaw)
        ? Number.parseInt(operationRaw, 10)
        : null,
      workCenterCode,
      identMark: parts[3].trim(),
      revision: parseRevision(parts[4]),
    };
    if (!workCenterCode)
      throw new BadRequestException(
        "Barkod polje 'RJgrupaRC' (radni centar) je obavezno.",
      );
    return { type: "operacija", raw, marker: "S", fields };
  }

  throw new BadRequestException(
    `Nepoznat marker barkoda '${marker}' — očekivano 'RNZ' (nalog) ili 'S' (operacija).`,
  );
}

// ---------------------------------------------------------------------------
// Enkoderi — generisanje barkod stringa za štampu RN-a (MODULE_SPEC_stampa §3).
// Rezultat mora biti round-trip kompatibilan sa `parseBarcode` iznad.
// ---------------------------------------------------------------------------

/** Nijedno polje barkoda ne sme sadržati separator `:`. */
function assertNoSeparator(value: string, name: string): void {
  if (value.includes(":"))
    throw new Error(
      `Barkod polje '${name}' ne sme sadržati ':' (dobijeno: '${value}').`,
    );
}

/**
 * Sastavlja nalog-barkod `RNZ:projectId:identNumber:variant:revision`.
 * Baca `Error` na nevalidan ulaz (podaci iz `work_orders`, ne korisnički unos).
 */
export function formatOrderBarcode(fields: {
  projectId: number;
  identNumber: string;
  variant: number;
  revision: string;
}): string {
  const { projectId, identNumber, variant, revision } = fields;
  if (!Number.isInteger(projectId) || projectId <= 0)
    throw new Error(
      `formatOrderBarcode: projectId mora biti pozitivan ceo broj (dobijeno: ${projectId}).`,
    );
  if (!Number.isInteger(variant) || variant < 0)
    throw new Error(
      `formatOrderBarcode: variant mora biti nenegativan ceo broj (dobijeno: ${variant}).`,
    );
  const ident = String(identNumber ?? "").trim();
  if (!ident) throw new Error("formatOrderBarcode: identNumber je obavezan.");
  const rev = String(revision ?? "").trim();
  if (!rev) throw new Error("formatOrderBarcode: revision je obavezna.");
  assertNoSeparator(ident, "identNumber");
  assertNoSeparator(rev, "revision");
  return `RNZ:${projectId}:${ident}:${variant}:${rev}`;
}

/**
 * Sastavlja operacija-barkod `S:operationNumber:workCenterCode:{identMark}:revision`.
 * `identMark` je podrazumevano `"0"` (verno legacy `rRN`; §10.4 — može postati
 * Toznaka uz potvrdu Negovana). Baca `Error` na nevalidan ulaz.
 */
export function formatOperationBarcode(fields: {
  operationNumber: number;
  workCenterCode: string;
  revision: string;
  identMark?: string;
}): string {
  const { operationNumber, workCenterCode, revision, identMark = "0" } = fields;
  if (!Number.isInteger(operationNumber))
    throw new Error(
      `formatOperationBarcode: operationNumber mora biti ceo broj (dobijeno: ${operationNumber}).`,
    );
  const rc = String(workCenterCode ?? "").trim();
  if (!rc)
    throw new Error(
      "formatOperationBarcode: workCenterCode (RJgrupaRC) je obavezan.",
    );
  const mark = String(identMark ?? "0").trim() || "0";
  const rev = String(revision ?? "").trim();
  if (!rev) throw new Error("formatOperationBarcode: revision je obavezna.");
  assertNoSeparator(rc, "workCenterCode");
  assertNoSeparator(mark, "identMark");
  assertNoSeparator(rev, "revision");
  return `S:${operationNumber}:${rc}:${mark}:${rev}`;
}

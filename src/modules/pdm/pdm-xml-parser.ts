import { XmlDocument, type XmlElement } from "xmldoc";

/**
 * Čist parser SolidWorks PDM export XML-a (bez Nest importa — testabilan).
 *
 * Kontrakt POTVRĐEN na stvarnom fajlu (PLAN_primopredaja_tp_cutover §2.8,
 * uzorak _analiza/pdm-xml-primeri/1126982_B.xml):
 *  - UTF-8 BEZ XML deklaracije i BEZ BOM-a — pozivalac dekodira
 *    `buffer.toString("utf8")` EKSPLICITNO, ovde stiže već string.
 *  - `<xml><transactions><transaction date="{epoch s}"
 *    type="wf_export_document_attributes">` → rekurzivno `<document>` /
 *    `<configuration>` / `<attribute name value/>` + `<references>`.
 *  - Imena atributa SA RAZMACIMA ("Approved by", "Document Number",
 *    "Reference Count") — čitaju se kao obični Record ključevi.
 *  - `document/@id` ume biti NENUMERIČKI (K00693, EGE2) — uvek string.
 *  - `State` mešano ODOBRENO/Odobreno → poređenje case-insensitive.
 *  - `Revision` prazan → "A"; vrednosti sa ugrađenim newline (ZiliS="S&#xA;")
 *    → trim SVIH vrednosti; datumi u haotičnim formatima → best-effort,
 *    NIKAD fail.
 */

/** Jedan `<document>` čvor (ista pojava = jedan red; isti deo se ponavlja pod više roditelja). */
export interface PdmDocRow {
  /** `document/@id` — broj crteža; STRING (ume nenumerički: K00693, EGE2). */
  docId: string;
  /** `document/@pdmweid` — PDM-ov interni id (→ drawings.external_id). */
  pdmWeId: string | null;
  /** `docId` roditelja; null za root dokument. */
  parentDocId: string | null;
  /**
   * Index (u `rows`) roditeljske POJAVE — opseg „četvrtog uslova": isti deo
   * dva puta u ISTOM `<references>` bloku je greška; ponovljeno CELO
   * podstablo pod drugim roditeljem je legalno (stvarni fajl: K16725 sa
   * decom K16724/K16723 se javlja pod 6 roditelja).
   */
  parentRowIndex: number | null;
  isRoot: boolean;
  /** Svi `<attribute>` parovi, vrednosti TRIM-ovane (ključevi sa razmacima!). */
  attrs: Record<string, string>;
  /** Revision normalizovan: prazan → "A". */
  revision: string;
  /** Weight paritet (UpisiPDMSklopoveUTabeluCrtezi l.222–234): ""→0, nenumerički→-1. */
  weight: number;
  /** Kolicina = round(Number("Reference Count")), min 1. */
  quantity: number;
  /** Best-effort parse — null na neuspeh, NIKAD fail. */
  approvedDate: Date | null;
  designDate: Date | null;
  /** Dokument u OVOM fajlu ima `<references>` (nosilac §6.6 delete/recreate BOM-a). */
  hasReferences: boolean;
}

export interface ParsedPdmFile {
  /** `transaction/@date` (epoch sekundi) → Date; null ako nenumerički/odsutan. */
  transactionDate: Date | null;
  /** Flat lista SVIH pojava dokumenata (pre-order; dedup radi pozivalac). */
  rows: PdmDocRow[];
}

/** Paritet legacy poruke iz ProveriXMLFajl (PDM_Common.bas l.603+). */
export const XML_STRUCTURE_ERROR = "XML fajl NIJE DOBRO struktuiran";

/** Strukturna greška XML-a — pozivalac je pretvara u kritičan log, ne u 500. */
export class PdmXmlStructureError extends Error {
  constructor(message = XML_STRUCTURE_ERROR) {
    super(message);
    this.name = "PdmXmlStructureError";
  }
}

/** State vrednosti koje prolaze uvoz (trim + lowercase poređenje). */
const VALID_STATES = new Set(["odobreno", "izmena bez revizije"]);

/** Maks. dužina broja crteža / oznake (kolone drawings VarChar(20)). */
const MAX_DOC_ID_LENGTH = 20;
const MAX_MARKING_LENGTH = 20;
/** Maks. dužina revizije (kolona drawings.revision VarChar(3)). */
const MAX_REVISION_LENGTH = 3;

// ---------------------------------------------------------------- NORMALIZACIJA

/** Revizija: trim + prazna → "A" (legacy pravilo, važi i za matching). */
export function normalizeRevision(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  return v === "" ? "A" : v;
}

/** Weight: ""→0, nenumerički→-1, inače broj (legacy IsNumeric semantika). */
export function parseWeight(raw: string | null | undefined): number {
  const v = (raw ?? "").trim();
  if (v === "") return 0;
  const n = Number(v);
  return Number.isNaN(n) ? -1 : n;
}

/** Kolicina = round("Reference Count"), min 1 (nevalidno → 1). */
export function parseQuantity(raw: string | null | undefined): number {
  const n = Number((raw ?? "").trim());
  if (Number.isNaN(n)) return 1;
  return Math.max(1, Math.round(n));
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Best-effort parse datuma iz PDM atributa. Formati viđeni u ISTOM fajlu:
 * `10.07.2026`, `7.6.2024.` (d.M.yyyy sa završnom tačkom), `24-Nov-23`,
 * `7/15/2025` (M/d/yyyy). Neuspeh → null, NIKAD exception.
 */
export function parsePdmDate(raw: string | null | undefined): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;

  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/.exec(s);
  if (m) {
    day = Number(m[1]);
    month = Number(m[2]);
    year = Number(m[3]);
  } else if ((m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(s))) {
    day = Number(m[1]);
    month = MONTHS[m[2].toLowerCase()];
    year = 2000 + Number(m[3]);
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {
    month = Number(m[1]);
    day = Number(m[2]);
    year = Number(m[3]);
  }

  if (!day || !month || !year || month > 12 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Preliv (npr. 31.02.) bi tiho prešao u sledeći mesec — odbaci.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return null;
  return date;
}

/**
 * NABAVKA flag — paritet legacy `Like "*[!0-9]*"`: oznaka sadrži BILO KOJI
 * ne-cifra znak. `MakeOrBuy` atribut je nepouzdan i namerno se ignoriše
 * (§2.8, potvrda Negovan).
 */
export function isProcurementMarking(marking: string): boolean {
  return /[^0-9]/.test(marking);
}

// ---------------------------------------------------------------- PARSER

/**
 * Parsira PDM export XML (već dekodiran UTF-8 string) u flat listu dokumenata.
 * Strukturni problem (nevalidan XML, pogrešan root, bez transakcije) →
 * `PdmXmlStructureError` (poslovna greška, ne 500).
 */
export function parseImportXml(xml: string): ParsedPdmFile {
  let doc: XmlDocument;
  try {
    doc = new XmlDocument(xml);
  } catch {
    throw new PdmXmlStructureError();
  }

  if (doc.name !== "xml") throw new PdmXmlStructureError();
  const transactions = doc
    .childNamed("transactions")
    ?.childrenNamed("transaction")
    .filter(
      (t) =>
        (t.attr["type"] ?? "").trim().toLowerCase() ===
        "wf_export_document_attributes",
    );
  if (!transactions?.length) throw new PdmXmlStructureError();

  const epoch = Number((transactions[0].attr["date"] ?? "").trim());
  const transactionDate =
    Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : null;

  const rows: PdmDocRow[] = [];
  for (const transaction of transactions)
    for (const document of transaction.childrenNamed("document"))
      walkDocument(document, null, null, true, rows);
  if (!rows.length) throw new PdmXmlStructureError();

  return { transactionDate, rows };
}

function walkDocument(
  el: XmlElement,
  parentDocId: string | null,
  parentRowIndex: number | null,
  isRoot: boolean,
  out: PdmDocRow[],
): void {
  const docId = (el.attr["id"] ?? "").trim();
  const pdmWeId = (el.attr["pdmweid"] ?? "").trim() || null;

  const configuration = el.childNamed("configuration");
  const attrs: Record<string, string> = {};
  for (const attribute of configuration?.childrenNamed("attribute") ?? []) {
    const name = attribute.attr["name"];
    if (name) attrs[name] = (attribute.attr["value"] ?? "").trim();
  }
  const references = configuration?.childNamed("references");

  const rowIndex = out.length;
  out.push({
    docId,
    pdmWeId,
    parentDocId,
    parentRowIndex,
    isRoot,
    attrs,
    revision: normalizeRevision(attrs["Revision"]),
    weight: parseWeight(attrs["Weight"]),
    quantity: parseQuantity(attrs["Reference Count"]),
    approvedDate: parsePdmDate(attrs["ApprovedDate"]),
    designDate: parsePdmDate(attrs["DesignDate"]),
    hasReferences: references !== undefined,
  });

  for (const child of references?.childrenNamed("document") ?? [])
    walkDocument(child, docId, rowIndex, false, out);
}

// ---------------------------------------------------------------- VALIDACIJE

/**
 * Paritet ProveriXMLFajl (PDM_Common.bas l.603+) — SVE-ILI-NIŠTA: jedna
 * greška = ceo fajl odbijen, ništa se ne upisuje. Vraća listu razloga
 * (prazna = fajl validan):
 *  1. obavezno po dokumentu: docId, Oznaka, "Reference Count" (posle trim);
 *  2. State trim + case-insensitive ∈ {odobreno, izmena bez revizije};
 *  3. dužine: docId ≤ 20, Oznaka ≤ 20 i Revision ≤ 3 znaka (kolone drawings);
 *  4. duplikati unutar fajla po (Oznaka, Revision normalizovan, ParentDocID)
 *     — „četvrti uslov". Opseg roditelja = POJAVA (`parentRowIndex`): isti
 *     deo dva puta u istom `<references>` bloku = greška; ponovljeno celo
 *     podstablo pod drugim roditeljem je legalno (stvarni fajl to sadrži,
 *     legacy ga uspešno uvozi).
 */
export function validateParsedFile(file: ParsedPdmFile): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  file.rows.forEach((row, index) => {
    const label = row.docId || `dokument #${index + 1}`;
    const marking = row.attrs["Oznaka"] ?? "";
    const referenceCount = row.attrs["Reference Count"] ?? "";
    const state = row.attrs["State"] ?? "";

    if (!row.docId) errors.push(`Dokument #${index + 1}: nedostaje id`);
    if (!marking) errors.push(`${label}: nedostaje Oznaka`);
    if (!referenceCount) errors.push(`${label}: nedostaje Reference Count`);

    if (!VALID_STATES.has(state.toLowerCase()))
      errors.push(`${label}: nevalidan State "${state}"`);

    if (row.docId.length > MAX_DOC_ID_LENGTH)
      errors.push(`${label}: id duži od ${MAX_DOC_ID_LENGTH} znakova`);
    if (marking.length > MAX_MARKING_LENGTH)
      errors.push(`${label}: Oznaka duža od ${MAX_MARKING_LENGTH} znakova`);
    // Kolona drawings.revision je VarChar(3): bez ove provere bi se revizija
    // tiho sekla (clipRequired), pa bi dve različite revizije sa istim
    // prefiksom pale na uq constraint kao 500 umesto validacione poruke.
    if (row.revision.length > MAX_REVISION_LENGTH)
      errors.push(
        `${label}: Revision duža od ${MAX_REVISION_LENGTH} znakova ("${row.revision}")`,
      );

    // „Četvrti uslov": isti deo dva puta pod ISTOM POJAVOM roditelja = greška.
    const key = `${marking}|${row.revision}|${row.parentRowIndex ?? "root"}`;
    if (seen.has(key))
      errors.push(
        `${label}: duplikat (Oznaka=${marking}, rev=${row.revision}, roditelj=${row.parentDocId ?? "koren"}) — četvrti uslov`,
      );
    else seen.add(key);
  });

  return errors;
}

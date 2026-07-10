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
 */

export type BarcodeType = "nalog" | "operacija";

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
  const s = value.trim();
  if (!s)
    throw new BadRequestException(
      "Barkod polje 'Revizija' (polje 5) je obavezno.",
    );
  return s;
}

/**
 * Parsira i validira JEDAN barkod (nalog ili operacija). Baca `BadRequestException`
 * (→ 400) na svaki nevalidan ulaz. Ne dodiruje bazu.
 */
export function parseBarcode(input: string): DecodedBarcode {
  if (typeof input !== "string")
    throw new BadRequestException("Barkod mora biti string.");
  const raw = input.trim();
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

  const marker = parts[0];
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

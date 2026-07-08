import { BadRequestException } from "@nestjs/common";

/**
 * Barkod prijave rada (kiosk write-path) — MODULE_SPEC_tehnologija §3 pravilo 1
 * (ISPRAVLJENO, migration/15 §5.1). NISU jedan nego **DVA** barkoda, svaki 5 polja
 * (4 separatora `:`):
 *   - **nalog**     `RNZ:IDPredmet:IdentBroj:Varijanta:PrnTimer`
 *   - **operacija** `S:Operacija:RJgrupaRC:Toznaka:PrnTimer`
 *
 * `PrnTimer` je **vezni ključ** — operacioni barkod mora imati isti `PrnTimer` kao
 * nalog (proverava se u servisu, ne ovde: ovaj modul parsira JEDAN barkod).
 *
 * Legacy validacija: `BrojSeparatora=4 AND (Left(bc,3)='RNZ' OR Left(bc,1)='S')`.
 * Ovde je marker provera pooštrena na TAČAN prvi segment (`parts[0] === 'RNZ' | 'S'`)
 * da `RNZX:...` ne prođe kao nalog — semantika ista, samo stroža (spec §6: bez
 * legacy zamki). Stari jednobarkodni `PredmetID:...:RJgrupaRC` je mrtav test-kod.
 */

export type BarcodeType = "nalog" | "operacija";

/** Polja iz nalog-barkoda (`RNZ:IDPredmet:IdentBroj:Varijanta:PrnTimer`). */
export interface OrderBarcodeFields {
  /** IDPredmet → `tech_processes.projectId` / `work_orders.projectId`. */
  projectId: number;
  /** IdentBroj → `identNumber` (broj RN-a, npr. `1234/5`). */
  identNumber: string;
  /** Varijanta → `variant`. */
  variant: number;
  /** PrnTimer → `printTimer` (vezni ključ nalog↔operacija). */
  printTimer: number;
}

/** Polja iz operacija-barkoda (`S:Operacija:RJgrupaRC:Toznaka:PrnTimer`). */
export interface OperationBarcodeFields {
  /** Operacija → `tech_processes.operationNumber` (null ako nije ceo broj). */
  operationNumber: number | null;
  /** Sirova vrednost polja Operacija (za dijagnostiku/echo). */
  operationRaw: string;
  /** RJgrupaRC → `tech_processes.workCenterCode` (FK ka `operations`). */
  workCenterCode: string;
  /** Toznaka → `tech_processes.identMark`. */
  identMark: string;
  /** PrnTimer → `printTimer` (vezni ključ nalog↔operacija). */
  printTimer: number;
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
 * Parsira i validira JEDAN barkod (nalog ili operacija). Baca `BadRequestException`
 * (→ 400) na svaki nevalidan ulaz. Ne dodiruje bazu.
 */
export function parseBarcode(input: string): DecodedBarcode {
  if (typeof input !== "string")
    throw new BadRequestException("Barkod mora biti string.");
  const raw = input.trim();
  if (!raw) throw new BadRequestException("Barkod je prazan.");

  // 🔴 Struktura: tačno 4 separatora → 5 polja.
  const separatorCount = (raw.match(/:/g) ?? []).length;
  if (separatorCount !== 4)
    throw new BadRequestException(
      `Barkod mora imati tačno 4 separatora ':' (5 polja), a ima ${separatorCount}.`,
    );
  const parts = raw.split(":");

  const marker = parts[0];
  if (marker === "RNZ") {
    const fields: OrderBarcodeFields = {
      projectId: parseIntStrict(parts[1], "IDPredmet"),
      identNumber: parts[2].trim(),
      variant: parseIntStrict(parts[3], "Varijanta"),
      printTimer: parseIntStrict(parts[4], "PrnTimer"),
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
      printTimer: parseIntStrict(parts[4], "PrnTimer"),
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

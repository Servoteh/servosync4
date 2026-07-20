import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * DocumentNumberSequenceService — jedna DB sekvenca po (documentType, year, companyId).
 * ZAMENJUJE „crvenu svesku" (WorkParameter per-username).
 *
 * Broj se rezerviše tek pri knjiženju (level 0), UNUTAR transakcije knjiženja:
 *   • SELECT … FOR UPDATE reda sekvence (ako postoji) ILI upsert (kreiraj sa 0),
 *   • increment lastNumber,
 *   • format = prefix + zero-pad(seq) + '/' + year.
 * Ako knjiženje padne, rollback transakcije poništava i rezervaciju broja (bez rupa).
 *
 * Prefiks: iz `DocumentType.documentNumberPrefix` ako postoji, inače iz statičke mape
 * (PON/PROF/IFR/…); fallback = sam `documentType`.
 */

/** Statička mapa prefiksa po vrsti dokumenta (fallback kad DocumentType nema prefiks). */
const PREFIX_BY_TYPE: Readonly<Record<string, string>> = {
  PON: "PON",
  PROF: "PROF",
  IFR: "IFR",
  IFGP: "IFGP",
  IFUSL: "IFUSL",
  IZVRO: "IZVRO",
  IZVGP: "IZVGP",
  IZVUS: "IZVUS",
  AVR: "AVR",
  REV: "REV",
};

@Injectable()
export class DocumentNumberSequenceService {
  /**
   * Rezerviši sledeći broj dokumenta u transakciji `tx`.
   * @returns npr. `IFR0043/2026`
   */
  async next(
    tx: Prisma.TransactionClient,
    documentType: string,
    year: number,
    companyId: number,
  ): Promise<string> {
    // 1) Zaključaj / kreiraj red sekvence. Row-lock (FOR UPDATE) serijalizuje
    //    konkurentne knjiženja iste vrste/godine/firme (bez dupliranih brojeva).
    const rows = await tx.$queryRaw<Array<{ id: number; last_number: number }>>`
      SELECT id, last_number
      FROM document_number_sequences
      WHERE document_type = ${documentType}
        AND year = ${year}
        AND company_id = ${companyId}
      FOR UPDATE
    `;

    let seq: number;
    if (rows.length === 0) {
      // Nema reda — kreiraj sa lastNumber=1 (prvi broj). Jedinstveni ključ štiti
      // od trke: ako drugi commit stigne prvi, ovaj bacia P2002 → tx rollback/retry.
      await tx.documentNumberSequence.create({
        data: { documentType, year, companyId, lastNumber: 1 },
      });
      seq = 1;
    } else {
      seq = rows[0].last_number + 1;
      await tx.documentNumberSequence.update({
        where: { id: rows[0].id },
        data: { lastNumber: seq },
      });
    }

    const prefix = await this.resolvePrefix(tx, documentType);
    return `${prefix}${String(seq).padStart(4, "0")}/${year}`;
  }

  /** Prefiks iz DocumentType.documentNumberPrefix; fallback na statičku mapu / sam tip. */
  private async resolvePrefix(
    tx: Prisma.TransactionClient,
    documentType: string,
  ): Promise<string> {
    const docType = await tx.documentType.findFirst({
      where: { code: documentType },
      select: { documentNumberPrefix: true },
    });
    const dbPrefix = docType?.documentNumberPrefix?.trim();
    if (dbPrefix) return dbPrefix;
    return PREFIX_BY_TYPE[documentType] ?? documentType;
  }
}

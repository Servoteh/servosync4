import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Numeracija robnih dokumenata (`stock_documents.document_number`), format BigBit `NNNN/god`.
 *
 * Obrazac 1:1 iz `nabavka/purchase-numbering.service.ts` / `handovers/draft-numbering.service.ts`:
 *   • poziva se UNUTAR `$transaction` (prima `tx`),
 *   • `pg_advisory_xact_lock(hashtext(key))` serijalizuje konkurentno kreiranje (bez DMax+1 trke),
 *   • MAX se računa NUMERIČKI u JS-u (ne SQL string sort) da '999' < '1000' ne pravi tihe duplikate.
 *
 * Brojač je segmentiran po (companyId, documentTypeCode, year) — isto kao `uq_stock_documents_number`
 * unique constraint u schema.prisma (`[companyId, documentTypeCode, year, documentNumber]`).
 */
@Injectable()
export class StockDocumentNumberingService {
  /**
   * Sledeći broj `NNNN/god` za dati tip dokumenta i godinu.
   * Vraća `{ documentNumber, year }` — pozivalac upisuje i `year` kolonu (deo unique ključa).
   */
  async next(
    tx: Prisma.TransactionClient,
    companyId: number,
    documentTypeCode: string,
    year: number,
  ): Promise<{ documentNumber: string; year: number }> {
    const suffix = `/${year}`;
    const lockKey = `robno:stockDoc:${companyId}:${documentTypeCode}:${year}`;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    // Numerički MAX preko svih redova (companyId, tip, godina) — ne string orderBy.
    const rows = await tx.stockDocument.findMany({
      where: {
        companyId,
        documentTypeCode,
        year,
        documentNumber: { endsWith: suffix },
      },
      select: { documentNumber: true },
    });
    let maxSeq = 0;
    for (const r of rows) {
      const raw = r.documentNumber.slice(0, -suffix.length); // "0042"
      const n = Number.parseInt(raw, 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }

    return {
      documentNumber: `${String(maxSeq + 1).padStart(4, "0")}${suffix}`, // "0043/2026"
      year,
    };
  }
}

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Numeracija neusaglašenosti na montaži (MODULE_SPEC §1/§3) — format `NM-NNN/YY`
 * (npr. "NM-024/26"), brojač po godini. Obrazac 1:1 iz `request-numbering.service.ts`:
 *   • poziva se UNUTAR $transaction (prima tx),
 *   • DVO-argumentni `pg_advisory_xact_lock(hashtext('montaza:nm'), godina::int)` serijalizuje
 *     konkurentno kreiranje. `::int` cast je OBAVEZAN — Prisma binduje JS number kao bigint, a
 *     dvo-argumentna forma postoji samo kao (int4, int4) → bez cast-a 42883 na prod-u
 *     (lekcija 22.07). hashtext samo nad fiksnim modul-ključem, godina kao drugi ključ.
 *   • MAX se računa u JS-u (ne string orderBy) da "099" < "100" ne pravi tihe duplikate;
 *     padding na 3 cifre (0..999 → "001".."999", preko toga bez pada).
 */
@Injectable()
export class MontazaNmNumberingService {
  /** Sledeći broj: `NM-NNN/YY` sa godišnjim brojačem. */
  async nextReportNumber(tx: Prisma.TransactionClient): Promise<string> {
    const year = new Date().getFullYear();
    const yy = String(year).slice(-2); // "26"
    const prefix = "NM-";
    const suffix = `/${yy}`;

    // Dvo-argumentni advisory lock — (hashtext('montaza:nm'), godina). ::int cast OBAVEZAN.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('montaza:nm'), ${year}::int)`;

    // Numerički MAX preko svih redova godine (ne string sort).
    const rows = await tx.montageNonconformity.findMany({
      where: { reportNumber: { startsWith: prefix, endsWith: suffix } },
      select: { reportNumber: true },
    });
    let maxSeq = 0;
    for (const r of rows) {
      // "NM-024/26" → srednji deo "024"
      const mid = r.reportNumber.slice(
        prefix.length,
        r.reportNumber.length - suffix.length,
      );
      const n = Number.parseInt(mid, 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }

    return `${prefix}${String(maxSeq + 1).padStart(3, "0")}${suffix}`; // "NM-025/26"
  }
}

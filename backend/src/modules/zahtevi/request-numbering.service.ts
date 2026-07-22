import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Numeracija zahteva (MODULE_SPEC_zahtevi §3) — format `NNN/YY` (npr. "023/26"),
 * brojač po godini. Obrazac 1:1 iz `nabavka/purchase-numbering.service.ts`:
 *   • poziva se UNUTAR $transaction (prima tx)
 *   • pg_advisory_xact_lock(hashtext(lockKey)) serijalizuje konkurentno kreiranje
 *   • MAX se računa u JS-u (ne SQL MAX, ne string orderBy) da "099" < "100" ne pravi
 *     tihe duplikate; padding na 3 cifre (0..999 → "001".."999", preko toga bez pada).
 */
@Injectable()
export class RequestNumberingService {
  /** Sledeći broj zahteva: `NNN/YY` sa godišnjim brojačem. */
  async nextReqNo(tx: Prisma.TransactionClient): Promise<string> {
    const year = new Date().getFullYear();
    const yy = String(year).slice(-2); // "26"
    const suffix = `/${yy}`;
    const lockKey = `zahtevi:reqNo:${year}`;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    // Numerički MAX preko svih redova godine (ne string sort).
    const rows = await tx.changeRequest.findMany({
      where: { reqNo: { endsWith: suffix } },
      select: { reqNo: true },
    });
    let maxSeq = 0;
    for (const r of rows) {
      const raw = r.reqNo.slice(0, -suffix.length); // "023"
      const n = Number.parseInt(raw, 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }

    return `${String(maxSeq + 1).padStart(3, "0")}${suffix}`; // "024/26"
  }
}

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * NACRT — numeracija dokumenata nabavke (BigBit format `NNNN/god`).
 * Ne aktivira se dok modeli nisu u schema.prisma (.nacrt ekstenzija = van build-a).
 *
 * Obrazac 1:1 iz `handovers/draft-numbering.service.ts`:
 *   • poziva se UNUTAR $transaction (prima tx)
 *   • pg_advisory_xact_lock(hashtext(prefix)) serijalizuje konkurentno kreiranje
 *   • MAX se računa u JS-u (ne SQL MAX, ne string orderBy) da '999' < '1000' ne pravi tihe duplikate
 *
 * Zahtev/narudžbenica: prefiks je GODINA → broj `NNNN/god` (npr. `0042/2026`).
 * Upit dobavljaču: prefiks je PREDMET → broj `{predmet}-N` (BigBit rok, doc 24).
 */
@Injectable()
export class PurchaseNumberingService {
  /** Zahtev za nabavku / narudžbenica: NNNN/god, godišnji brojač. */
  async nextYearlyRequest(tx: Prisma.TransactionClient): Promise<string> {
    return this.nextYearly(tx, "purchaseRequest", "requestNumber");
  }

  async nextYearlyOrder(tx: Prisma.TransactionClient): Promise<string> {
    return this.nextYearly(tx, "purchaseOrder", "orderNumber");
  }

  private async nextYearly(
    tx: Prisma.TransactionClient,
    // model/field su literali iz koda (nikad korisnički unos) — bezbedno za dinamički pristup
    model: "purchaseRequest" | "purchaseOrder",
    field: "requestNumber" | "orderNumber",
  ): Promise<string> {
    const year = new Date().getFullYear();
    const suffix = `/${year}`;
    const lockKey = `nabavka:${model}:${year}`;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    // Numerički MAX preko svih redova godine (kao nextWorkOrderIdent), ne string sort.
    const rows = await (tx[model] as any).findMany({
      where: { [field]: { endsWith: suffix } },
      select: { [field]: true },
    });
    let maxSeq = 0;
    for (const r of rows) {
      const raw = String(r[field]).slice(0, -suffix.length); // "0042"
      const n = Number.parseInt(raw, 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }

    return `${String(maxSeq + 1).padStart(4, "0")}${suffix}`; // "0043/2026"
  }

  /** Upit dobavljaču: `{projectNumber}-N` — brojač po predmetu (BigBit prefiks=predmet-N). */
  async nextRfqForProject(
    tx: Prisma.TransactionClient,
    projectNumber: string,
  ): Promise<string> {
    const prefix = `${projectNumber}-`;
    const lockKey = `nabavka:supplierRfq:${projectNumber}`;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const rows = await tx.supplierRfq.findMany({
      where: { rfqNumber: { startsWith: prefix } },
      select: { rfqNumber: true },
    });
    let maxSeq = 0;
    for (const r of rows) {
      const n = Number.parseInt(r.rfqNumber.slice(prefix.length), 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }

    return `${prefix}${maxSeq + 1}`; // "2026-0042-1"
  }
}

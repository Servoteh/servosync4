import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Generisanje broja nacrta: `draftNumber = G-{yymmdd}-{seq}` (npr. `G-260424-001`
 * za prvi nacrt 24.04.2026) — MODULE_SPEC_nacrti_primopredaje §7.1.
 *
 * Poziva se UNUTAR transakcije. Advisory lock po danu (hashtext string-key →
 * bigint, `pg_advisory_xact_lock` traži bigint) serijalizuje konkurentno
 * kreiranje nacrta istog dana → nema duplikata i nema legacy DMax+1 trke
 * (isti obrazac kao `work-order-numbering.service.ts`, ali dnevni umesto
 * po-predmetu ključ).
 */
@Injectable()
export class DraftNumberingService {
  async next(tx: Prisma.TransactionClient): Promise<string> {
    const now = new Date();
    const yy = String(now.getFullYear() % 100).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const prefix = `G-${yy}${mm}${dd}-`;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`;

    const latestToday = await tx.handoverDraft.findFirst({
      where: { draftNumber: { startsWith: prefix } },
      orderBy: { draftNumber: "desc" },
      select: { draftNumber: true },
    });

    const lastSeq = latestToday
      ? Number.parseInt(latestToday.draftNumber.slice(prefix.length), 10)
      : 0;
    const seq = Number.isNaN(lastSeq) ? 1 : lastSeq + 1;

    return `${prefix}${String(seq).padStart(3, "0")}`;
  }
}

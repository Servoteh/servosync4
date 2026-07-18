import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Generisanje broja radnog naloga: `identNumber = <projectNumber>/<ordinal>`.
 *
 * Poziva se UNUTAR transakcije. Advisory lock po `projectId` serijalizuje
 * konkurentne unose za isti predmet → nema race-a i nema legacy string-DMax
 * logike (MODULE_SPEC_radni_nalozi §3, migration/05 DOMEN 3.1).
 */
@Injectable()
export class WorkOrderNumberingService {
  async next(
    tx: Prisma.TransactionClient,
    projectId: number,
  ): Promise<{ identNumber: string; variant: number }> {
    // Serijalizuj po predmetu do kraja transakcije.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${projectId})`;

    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { projectNumber: true },
    });
    if (!project)
      throw new NotFoundException(`Predmet ${projectId} ne postoji`);

    // ordinal = MAX postojećeg ordinala za taj predmet + 1 (bez duplikata).
    const rows = await tx.workOrder.findMany({
      where: { projectId },
      select: { identNumber: true },
    });
    let maxOrd = 0;
    for (const r of rows) {
      const ord = Number.parseInt(r.identNumber.split("/").pop() ?? "", 10);
      if (!Number.isNaN(ord) && ord > maxOrd) maxOrd = ord;
    }

    // V1: prva varijanta = 0. (Varijante iste kombinacije crtež/predmet — kasnije.)
    return {
      identNumber: `${project.projectNumber}/${maxOrd + 1}`,
      variant: 0,
    };
  }
}

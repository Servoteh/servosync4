import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * Sanity prag za ordinal pri MAX+1 dodeli broja RN (incident 030/26 — dva
 * talasa: 21.01/23.07. i 03.08.2026, oba u predmetu 7701).
 *
 * Izmereno na produ 03.08.2026 (40.786 idents sa kosom crtom, 237 bez nje):
 *   - najveći LEGITIMAN ordinal IGDE = 2.273 (predmet 7701; sledeći 2.122
 *     u predmetu 6938) — istorijski plafon posle 10 godina podataka;
 *   - opseg 10.000–99.999 je POTPUNO PRAZAN (0 od 40.786 redova);
 *   - otrov počinje tek na 770.171.832 (kaskada koju je pokrenuo legacy typo
 *     red '770171831' — ukucana „7" umesto „/", wo.id 40199).
 * Prag 100.000 je ≥40× iznad najvećeg legitimnog ordinala, a red veličine
 * ispod najmanjeg otrova → nijedan legitiman RN se ne odbacuje i nijedan
 * otrov ne prolazi. Ordinal ≥ praga se pri računanju maksimuma IGNORIŠE
 * (bez greške — zatečeni otrovni redovi po presudi od 27.07. ostaju u bazi
 * i samo ne smeju da hrane brojač).
 */
export const SANITY_MAX_ORDINAL = 100_000;

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
    // Bug 030/26: dve klase otrovnih redova su preko split('/').pop() davale
    // maxOrd od stotina miliona:
    //   (1) idents BEZ `<projectNumber>/` prefiksa — legacy typo/uvoz (na
    //       produ 237 takvih, npr. '770171831'); ceo string je postajao
    //       „ordinal". Prefiks-provera pokriva i predmete sa '/' u broju
    //       (npr. '9400/7' → prefiks '9400/7/', idents '9400/7/72').
    //   (2) već kaskadirani apsurdni ordinali (7701/770171832…844) — jednom
    //       nastali, sami su hranili MAX+1. Sanity prag ih isključuje.
    const prefix = `${project.projectNumber}/`;
    let maxOrd = 0;
    for (const r of rows) {
      if (!r.identNumber.startsWith(prefix)) continue;
      const ord = Number.parseInt(r.identNumber.slice(prefix.length), 10);
      if (Number.isNaN(ord) || ord >= SANITY_MAX_ORDINAL) continue;
      if (ord > maxOrd) maxOrd = ord;
    }
    // Ako su SVI redovi otrovni (ili predmet prazan) → maxOrd=0 → `<broj>/1`.
    // NAMERNO: bolje krenuti od /1 nego nastaviti kaskadu (770171845…);
    // uq trojka (projectId, identNumber, variant) je mreža — eventualna
    // kolizija obara transakciju umesto tihog duplikata.

    // V1: prva varijanta = 0. (Varijante iste kombinacije crtež/predmet — kasnije.)
    return {
      identNumber: `${project.projectNumber}/${maxOrd + 1}`,
      variant: 0,
    };
  }
}

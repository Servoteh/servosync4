import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * NACRT — numeracija predmeta (BigBit `DMax([BrojPredmet])+1`).
 * Ne aktivira se dok CustomerRfq / write-path nisu spremni (.nacrt = van build-a).
 *
 * Obrazac iz `handovers/draft-numbering.service.ts` i `nabavka/purchase-numbering`:
 *   • poziva se UNUTAR $transaction (prima tx)
 *   • pg_advisory_xact_lock(hashtext(key)) serijalizuje konkurentno kreiranje predmeta
 *     → nema DMax+1 trke (Traka B rizik „numeracija race")
 *   • MAX se računa NUMERIČKI (project_number::int), ne string orderBy: leksikografski
 *     bi '999' bio veći od '1000' pa bi se broj dodeljivao iznova (project_number nema
 *     unique constraint u schema.prisma → tihi duplikati bez ove zaštite).
 *
 * NAPOMENA (N3 / dual-run): dok BigBit sync još kreira predmete, 2.0 numeracija čeka
 *   cutover (Traka B §Odluke). Advisory lock štiti samo od 2.0↔2.0 trke; koegzistencija
 *   sa BigBit-om zahteva da je 2.0 jedini pisac (odluka N3 = 2.0 MASTER).
 */
@Injectable()
export class ProjectNumberingService {
  /** Sledeći broj predmeta: MAX(project_number::int) + 1 preko cele tabele. */
  async next(tx: Prisma.TransactionClient): Promise<string> {
    // Jedan globalni ključ — numeracija predmeta nije segmentirana (BigBit DMax bez filtera).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('projects:number'))`;

    // Numerički MAX u SQL-u: samo redovi čiji je project_number ceo broj (regex),
    // NULL/prazno/nenumeričko se ignoriše. COALESCE → 0 kad je tabela prazna.
    const rows = await tx.$queryRaw<Array<{ max_num: number }>>`
      SELECT COALESCE(MAX(project_number::int), 0) AS max_num
      FROM projects
      WHERE project_number ~ '^[0-9]+$'
    `;
    const maxNum = rows[0]?.max_num ?? 0;
    return String(maxNum + 1);
  }
}

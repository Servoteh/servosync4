import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { NOT_DELETED } from "../../common/soft-delete.util";
import { computeKepuEntries, writeKepuEntries } from "./kepu-book.util";

/**
 * KepuService — KEPU knjiga (maloprodajna evidencija) iz robnog toka.
 *
 * ZAŠTO JE ODVOJEN OD `RobnoService` (04.08.2026): KEPU je zasebna zakonska knjiga sa
 * sopstvenim pravilima (smer zaduženja/razduženja, MP vrednost, idempotencija po
 * dokumentu). Stajao je u istoj klasi sa kreiranjem dokumenta i izveštajima samo zato
 * što je tamo prvi put napisan — nijedan njegov razlog za izmenu nema veze sa
 * transakcijom kreiranja.
 *
 * Računanje redova je u `kepu-book.util` (čista funkcija, testabilna bez baze); ovde je
 * samo dovlačenje podataka i upis.
 */
@Injectable()
export class KepuService {
  private readonly logger = new Logger(KepuService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sinhronizuj KEPU red(ove) za jedan robni dokument (doc 39 §E, task D5be) — idempotentno
   * po documentId. Poziva se iz `robno post` toka (posle knjiženja IZ/NIV/…) i iz retro-punjenja.
   * Učitava zaglavlje + stavke + nivelacione parove + `DocumentType.kepuDefault*` (default smer),
   * računa red(ove) u `kepu-book.util` i briše+upisuje po documentId. Vraća broj upisanih redova.
   */
  async writeKepuForDocument(docId: number): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.stockDocument.findUnique({
        where: { id: docId },
        include: {
          // Soft-delete (Batch B): obrisana stavka NE ulazi u KEPU vrednost.
          items: { where: NOT_DELETED, orderBy: { id: "asc" } },
          stockLevelingItems: { orderBy: { id: "asc" } },
        },
      });
      if (!doc)
        throw new NotFoundException(`Robni dokument ${docId} ne postoji.`);

      const docType = await tx.documentType.findFirst({
        where: { code: doc.documentTypeCode },
        select: {
          kepuDefaultCharge: true,
          kepuDefaultDischarge: true,
          // Smer je obavezan za stranu para prenosa (PREIZ razdužuje, PREUL zadužuje).
          isInbound: true,
        },
      });
      const entries = computeKepuEntries(
        doc,
        doc.items,
        doc.stockLevelingItems,
        docType,
      );
      return writeKepuEntries(tx, doc.id, entries);
    });
  }

  /**
   * Retro-punjenje KEPU knjige za postojeće dokumente (task D5be). Idempotentno prolazi kroz
   * sve dokumente van DRAFT-a (imaju finalne vrednosti) i (pre)računava KEPU redove. Opcioni
   * filter po godini. Svaki dokument ide u SOPSTVENOJ transakciji (delete+insert po
   * documentId) — bezbedno za ponovni poziv i za prekid usred posla.
   *
   * ⚠️ POZNATO OGRANIČENJE (nalaz 04.08.2026, nije popravljeno u ovom prolazu):
   * ovo je sinhrona HTTP ruta koja radi JEDNU TRANSAKCIJU PO DOKUMENTU, bez gornje granice.
   * Na nekoliko stotina dokumenata prolazi; na desetinama hiljada je zahtev koji nijedan
   * proxy neće dočekati, a posao ostaje delimično urađen (doduše bez nekonzistentnosti,
   * jer je svaki dokument atomičan). Ispravno rešenje je pozadinski posao sa parčanjem i
   * izveštajem o napretku — zaseban zadatak, jer menja ugovor rute. Do tada:
   * pozivati SA `year` filterom, godinu po godinu.
   */
  async rebuildKepu(query: { year?: number } = {}): Promise<{
    documents: number;
    entries: number;
  }> {
    const where: Prisma.StockDocumentWhereInput = { status: { not: "DRAFT" } };
    if (query.year != null) where.year = query.year;

    const docs = await this.prisma.stockDocument.findMany({
      where,
      select: { id: true },
      orderBy: [{ documentDate: "asc" }, { id: "asc" }],
    });

    let entries = 0;
    for (const d of docs) {
      entries += await this.writeKepuForDocument(d.id);
    }
    this.logger.log(
      `KEPU rebuild: obrađeno ${docs.length} dokumenata, upisano ${entries} redova` +
        (query.year != null ? ` (godina ${query.year})` : "") +
        ".",
    );
    return { documents: docs.length, entries };
  }
}

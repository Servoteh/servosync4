import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PostingModule } from "../gl/posting/posting.module";
import { DocumentsModule } from "../documents/documents.module";
import { BlagajnaController } from "./blagajna.controller";
import { BlagajnaService } from "./blagajna.service";
import { CashJournalPdfService } from "./print/cash-journal-pdf.service";

/**
 * Blagajna (gotovinski dnevnik) — XL modul. Auto-knjiženje uplatnica/isplatnica
 * kroz PostingEngine (blagajna ↔ protivkonto). PrismaModule je @Global.
 *
 * `DocumentsModule` daje deljeni `PdfService` (pdfmake) za blagajnički izveštaj —
 * isti put štampe kao robno/sales, bez novih zavisnosti.
 */
@Module({
  imports: [PrismaModule, PostingModule, DocumentsModule],
  controllers: [BlagajnaController],
  providers: [BlagajnaService, CashJournalPdfService],
  exports: [BlagajnaService],
})
export class BlagajnaModule {}

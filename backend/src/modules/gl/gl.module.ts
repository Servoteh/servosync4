import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { DocumentsModule } from "../documents/documents.module";
import { PostingModule } from "./posting/posting.module";
import { GlController } from "./gl.controller";
import { GlReadService } from "./gl-read.service";
import { GlWriteService } from "./gl-write.service";
import { JournalPrintService } from "./journal-print.service";
import { JournalBookPrintService } from "./print/journal-book-print.service";
import { AccountCardPrintService } from "./print/account-card-print.service";
import { TrialBalancePrintService } from "./print/trial-balance-print.service";
import { YearOpenService } from "./year-open.service";

/**
 * Glavna knjiga (Faza 2) — READ (dnevnik/kartica konta/kontni plan) + WRITE
 * (ručni unos naloga/temeljnica, proknjiži/zaključaj/storno). Knjižni motor je
 * PostingModule (postManualEntry, numeracija); ovaj modul ga koristi za write.
 */
@Module({
  imports: [PrismaModule, PostingModule, DocumentsModule], // DocumentsModule → PdfService (T2 štampa temeljnice)
  controllers: [GlController],
  providers: [
    GlReadService,
    GlWriteService,
    JournalPrintService,
    // Štampa knjiga GK (dnevnik / kartica konta / bruto bilans) — v. print/doc-layout.ts.
    JournalBookPrintService,
    AccountCardPrintService,
    TrialBalancePrintService,
    YearOpenService,
  ],
  exports: [GlReadService, GlWriteService],
})
export class GlModule {}

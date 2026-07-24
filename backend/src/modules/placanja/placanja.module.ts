import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { DocumentsModule } from "../documents/documents.module";
import { PlacanjaController } from "./placanja.controller";
import { PaymentPreparationService } from "./payment-preparation.service";
import { PaymentExportService } from "./payment-export.service";
import { PaymentOrderPdfService } from "./payment-order-pdf.service";

/**
 * Modul Priprema plaćanja / virmani (Faza 4 §C).
 *   PaymentPreparationService — dospele obaveze iz otvorenih stavaka GK → PaymentOrder
 *     (DEDUP protiv dvostrukog plaćanja, status-mašina CREATED→SIGNED→PAID).
 *   PaymentExportService — izvoz naloga u banku (fiksni TXT FX / Banca Intesa, doc 21 §B).
 *
 * Zavisi samo od PrismaModule (čita ledger_entries / saldakonto_accounts, piše payment_orders).
 * NE registruje se u app.module ovde — to radi integrator.
 */
@Module({
  imports: [PrismaModule, DocumentsModule], // DocumentsModule → PdfService (T2 štampa virmana)
  controllers: [PlacanjaController],
  providers: [PaymentPreparationService, PaymentExportService, PaymentOrderPdfService],
  exports: [PaymentPreparationService, PaymentExportService],
})
export class PlacanjaModule {}

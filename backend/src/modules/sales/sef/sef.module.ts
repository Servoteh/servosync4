import { Module } from "@nestjs/common";
import { PrismaModule } from "../../../prisma/prisma.module";
import { DocumentsModule } from "../../documents/documents.module";
import { SalesPrintModule } from "../print/sales-print.module";
import { SefController } from "./sef.controller";
import { SefService } from "./sef.service";
import { SefClientService } from "./sef-client.service";
import { SefIncomingService } from "./sef-incoming.service";
import { SefPrintService } from "./sef-print.service";
import { UblBuilderService } from "./ubl-builder.service";

/**
 * Modul SEF (Faza 5 §B) — izlazne e-fakture ka MFIN portalu.
 * Zavisnosti: PrismaModule (Invoice/SefOutbox/Company/Customer).
 * UblBuilderService (čist XML) + SefClientService (REST, throttle, DRY-RUN) +
 * SefService (orkestracija). Registruje se u app.module od strane integratora.
 */
@Module({
  // SalesPrintModule → InvoicePdfService za D7 PDF prilog uz SEF;
  // DocumentsModule → PdfService za čitljivu štampu e-fakture (SefPrintService).
  imports: [PrismaModule, SalesPrintModule, DocumentsModule],
  controllers: [SefController],
  providers: [
    SefService,
    SefClientService,
    SefIncomingService, // E1 ulazne fakture
    SefPrintService, // čitljiv prikaz UBL-a (izlazna + ulazna e-faktura)
    UblBuilderService,
  ],
  exports: [SefService],
})
export class SefModule {}

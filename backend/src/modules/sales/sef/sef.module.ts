import { Module } from "@nestjs/common";
import { PrismaModule } from "../../../prisma/prisma.module";
import { SalesPrintModule } from "../print/sales-print.module";
import { SefController } from "./sef.controller";
import { SefService } from "./sef.service";
import { SefClientService } from "./sef-client.service";
import { UblBuilderService } from "./ubl-builder.service";

/**
 * Modul SEF (Faza 5 §B) — izlazne e-fakture ka MFIN portalu.
 * Zavisnosti: PrismaModule (Invoice/SefOutbox/Company/Customer).
 * UblBuilderService (čist XML) + SefClientService (REST, throttle, DRY-RUN) +
 * SefService (orkestracija). Registruje se u app.module od strane integratora.
 */
@Module({
  imports: [PrismaModule, SalesPrintModule], // SalesPrintModule → InvoicePdfService za D7 PDF prilog uz SEF
  controllers: [SefController],
  providers: [SefService, SefClientService, UblBuilderService],
  exports: [SefService],
})
export class SefModule {}

import { Module } from "@nestjs/common";
import { PostingModule } from "../gl/posting/posting.module";
import { SalesController } from "./sales.controller";
import { FakturisanjeService } from "./fakturisanje.service";
import { PricingService } from "./pricing.service";
import { DocumentNumberSequenceService } from "./numbering.service";
import { DocumentCarryOverService } from "./carry-over.service";

/**
 * Modul Sales / Fakturisanje (Faza 5 §A — izlazni računi + carry-over + numeracija).
 * Zavisnosti:
 *   PostingModule (PostingEngineService — auto-robno knjiženje IFR/IFGP),
 *   PrismaModule je @Global (ne uvozi se).
 *
 * NAPOMENA: modul se NE registruje u app.module ovde (integrator to radi).
 */
@Module({
  imports: [PostingModule],
  controllers: [SalesController],
  providers: [
    FakturisanjeService,
    PricingService,
    DocumentNumberSequenceService,
    DocumentCarryOverService,
  ],
  exports: [
    FakturisanjeService,
    PricingService,
    DocumentNumberSequenceService,
    DocumentCarryOverService,
  ],
})
export class SalesModule {}

import { Module } from "@nestjs/common";
import { PostingModule } from "../gl/posting/posting.module";
import { GlModule } from "../gl/gl.module";
import { SefModule } from "./sef/sef.module";
import { SalesPrintModule } from "./print/sales-print.module";
import { SalesController } from "./sales.controller";
import { FakturisanjeService } from "./fakturisanje.service";
import { PricingService } from "./pricing.service";
import { DocumentNumberSequenceService } from "./numbering.service";
import { DocumentCarryOverService } from "./carry-over.service";
import { AdvanceInvoiceService } from "./advance-invoice.service";
import { SalesService } from "./sales.service";
import { ServiceRevenueTypeService } from "./service-revenue-type.service";
import { VatExemptionBasisService } from "./vat-exemption-basis.service";
import { RobnoModule } from "../robno/robno.module";

/**
 * Modul Sales / Fakturisanje (Faza 5 §A — izlazni računi + carry-over + numeracija).
 * Zavisnosti:
 *   PostingModule (PostingEngineService — auto-robno knjiženje IFR/IFGP),
 *   PrismaModule je @Global (ne uvozi se).
 *
 * NAPOMENA: modul se NE registruje u app.module ovde (integrator to radi).
 */
@Module({
  // GlModule → GlWriteService (T2 SEF storno = reverse GL); SefModule → SefService (cancel pri stornu).
  // Jednosmerno Sales→Gl/Sef, bez ciklusa (gl/ i sef/ ne uvoze sales provajdere).
  // RobnoModule → ReservationService: storno predračuna mora da OSLOBODI rezervisanu
  // robu, inače rezervacija večno drži zalihu (Batch C review, nalaz F). Jednosmerno
  // Sales→Robno; robno/ ne uvozi sales provajdere, pa nema ciklusa.
  imports: [PostingModule, GlModule, SefModule, SalesPrintModule, RobnoModule],
  controllers: [SalesController],
  providers: [
    FakturisanjeService,
    PricingService,
    DocumentNumberSequenceService,
    DocumentCarryOverService,
    AdvanceInvoiceService, // Batch C: avansni računi (AVR)
    SalesService, // izmena nacrta prodajnog dokumenta (zaglavlje + stavke)
    ServiceRevenueTypeService, // šifarnik vrsta usluge (konto prihoda + poreski tretman)
    VatExemptionBasisService, // šifarnik osnova oslobođenja (papir + SEF šifra + SEF kapija)
  ],
  exports: [
    FakturisanjeService,
    PricingService,
    DocumentNumberSequenceService,
    DocumentCarryOverService,
    AdvanceInvoiceService,
    SalesService,
    ServiceRevenueTypeService,
    VatExemptionBasisService,
  ],
})
export class SalesModule {}

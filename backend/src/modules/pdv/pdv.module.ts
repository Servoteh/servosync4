import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { DocumentsModule } from "../documents/documents.module";
import { PdvController } from "./pdv.controller";
import { VatLedgerService } from "./vat-ledger.service";
import { PopdvService } from "./popdv.service";
import { KepuService } from "./kepu.service";
import { PdvPrintController } from "./pdv-print.controller";
import { PdvPrintService } from "./pdv-print.service";
import { TaxRatesController } from "./tax-rates.controller";
import { TaxRatesService } from "./tax-rates.service";

/**
 * Modul PDV / POPDV (Faza 6). Izvedena PDV evidencija iz glavne knjige:
 *   - VatLedgerService: KIF/KUF punjenje iz ledger_entries preko VatAccountMap
 *   - PopdvService: POPDV obračun (deklarativne AOP formule + osnovni obračun)
 *   - KepuService: KEPU rekapitulacija po magacinu/periodu
 *
 * NAPOMENA: modul se NE registruje u app.module ovde (radi se odvojeno pri
 * aktivaciji Faze 6 — kao ostali Faza-4/5 moduli). Zavisi samo od PrismaModule
 * i reuse-a Faza-2 expression parsera (import po putanji, ne kroz modul).
 */
@Module({
  imports: [PrismaModule, DocumentsModule], // DocumentsModule → PdfService za D2 štampu (nije @Global)
  controllers: [PdvController, PdvPrintController, TaxRatesController],
  providers: [VatLedgerService, PopdvService, KepuService, PdvPrintService, TaxRatesService],
})
export class PdvModule {}

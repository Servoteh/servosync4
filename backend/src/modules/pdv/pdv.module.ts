import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PdvController } from "./pdv.controller";
import { VatLedgerService } from "./vat-ledger.service";
import { PopdvService } from "./popdv.service";
import { KepuService } from "./kepu.service";

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
  imports: [PrismaModule],
  controllers: [PdvController],
  providers: [VatLedgerService, PopdvService, KepuService],
})
export class PdvModule {}

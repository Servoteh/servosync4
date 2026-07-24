import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PostingModule } from "../gl/posting/posting.module";
import { DocumentsModule } from "../documents/documents.module";
import { SaldakontiController } from "./saldakonti.controller";
import { OpenItemsService } from "./open-items.service";
import { ReconciliationService } from "./reconciliation.service";
import { CompensationService } from "./compensation.service";
import { IosPdfService } from "./ios-pdf.service";

/**
 * Modul Saldakonti (Faza 4 §A) — otvorene stavke / aging / uparivanje / kompenzacija.
 * Izveden pogled nad glavnom knjigom (ledger_entries): otvorena stavka = konto u
 * SaldakontoAccount registru + nalog proknjižen + reconciled_at IS NULL.
 *
 * Zavisnosti: PrismaModule (baza; sve preko $queryRaw za GROUP BY/HAVING/aging).
 * Knjiženje kompenzacije ide preko PostingEngineService — v. TODO hook u
 * compensation.service.ts (PostingModule se dodaje kad taj servis dobije
 * generički ulaz za KMP nalog).
 *
 * NAPOMENA (integrator): ovaj modul se NE registruje u app.module.ts ovde —
 * registraciju radi integrator pri aktivaciji Faze 4.
 */
@Module({
  imports: [PrismaModule, PostingModule, DocumentsModule], // DocumentsModule → PdfService za IOS obrazac (E3)
  controllers: [SaldakontiController],
  providers: [OpenItemsService, ReconciliationService, CompensationService, IosPdfService],
  exports: [OpenItemsService, ReconciliationService, CompensationService],
})
export class SaldakontiModule {}

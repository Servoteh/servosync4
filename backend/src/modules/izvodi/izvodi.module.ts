import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { DocumentsModule } from "../documents/documents.module";
import { IzvodiController } from "./izvodi.controller";
import { BankStatementService } from "./bank-statement.service";
import { BankStatementPrintService } from "./bank-statement-print.service";
import { BankStatementParserService } from "./bank-statement-parser.service";
import { ExchangeRateController } from "./exchange-rate.controller";
import { ExchangeRateService } from "./exchange-rate.service";

/**
 * Modul IZVODI (Faza 4 §B) — uvoz bankovnih izvoda (TXT fiksne kolone, FX format),
 * uparivanje komitenta/otvorene stavke i auto-knjiženje u GK (banka↔analitika).
 *
 * NAPOMENA (integrator): ovaj modul se NE registruje u app.module.ts ovde — to radi
 * integrator. Auto-knjiženje kreira JournalEntry/LedgerEntry direktno (izvod se ne knjiži
 * kroz šemu za kontiranje — doc 21 §A), pa modul zavisi samo od PrismaModule.
 *
 * ZATVARANJE UPARIVANJA (uplata↔faktura) posle knjiženja radi `ReconciliationService` iz
 * modula saldakonti (defekt D3, 04.08.2026). Taj modul se OVDE NE UVOZI: `SaldakontiModule`
 * već uvozi `IzvodiModule` (kursna lista za revalorizaciju), pa bi obrnut uvoz bio ciklus
 * modula — servis se vadi kroz `ModuleRef` sa `strict: false`
 * (v. `BankStatementService.resolveReconciliationService`).
 */
@Module({
  // DocumentsModule → PdfService (štampa izvoda; renderer je zajednički, v. bank-statement-print.service.ts).
  imports: [PrismaModule, DocumentsModule],
  controllers: [IzvodiController, ExchangeRateController],
  providers: [
    BankStatementService,
    BankStatementParserService,
    BankStatementPrintService,
    ExchangeRateService,
  ],
  exports: [BankStatementService, ExchangeRateService], // ExchangeRateService: devizna konverzija (E6) + budući cross-modul (blagajna srednji kurs)
})
export class IzvodiModule {}

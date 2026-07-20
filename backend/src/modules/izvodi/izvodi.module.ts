import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { IzvodiController } from "./izvodi.controller";
import { BankStatementService } from "./bank-statement.service";
import { BankStatementParserService } from "./bank-statement-parser.service";

/**
 * Modul IZVODI (Faza 4 §B) — uvoz bankovnih izvoda (TXT fiksne kolone, FX format),
 * uparivanje komitenta/otvorene stavke i auto-knjiženje u GK (banka↔analitika).
 *
 * NAPOMENA (integrator): ovaj modul se NE registruje u app.module.ts ovde — to radi
 * integrator. Auto-knjiženje kreira JournalEntry/LedgerEntry direktno (izvod se ne knjiži
 * kroz šemu za kontiranje — doc 21 §A), pa modul zavisi samo od PrismaModule. Uparivanje
 * uplate↔faktura (ReconciliationService iz modula saldakonti) je cross-modul hook (TODO u servisu).
 */
@Module({
  imports: [PrismaModule],
  controllers: [IzvodiController],
  providers: [BankStatementService, BankStatementParserService],
  exports: [BankStatementService],
})
export class IzvodiModule {}

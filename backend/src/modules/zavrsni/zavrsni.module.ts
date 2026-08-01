import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { DocumentsModule } from "../documents/documents.module";
import { ZavrsniController } from "./zavrsni.controller";
import { BalanceSheetService } from "./balance-sheet.service";
import { GkEvalService } from "./gkeval.service";
import { AprXmlService } from "./apr-xml.service";
import { ControlRulesService } from "./control-rules.service";
import { StatementPdfService } from "./statement-pdf.service";

/**
 * Modul Završni račun / bilansi (Faza 7). Izvedeni obračuni nad glavnom knjigom
 * (ledger_entries) preko GKEval bilansnog formula-engine-a. Bez sopstvenih tabela
 * osim FinancialStatement/FinancialStatementLine (persist obračuna) i
 * BalanceFormulaDefinition (deklarativne AOP formule).
 *
 * NIJE registrovan u app.module (aktivacija odvojeno) — konzistentno sa Faza 6/7
 * konvencijom (modul se uvezuje kad se aktivira ceo finansijski stack).
 */
@Module({
  // DocumentsModule daje zajednički `PdfService` (pdfmake) za štampu bilansa —
  // isti renderer kao sve ostale štampe u aplikaciji, bez novih zavisnosti.
  imports: [PrismaModule, DocumentsModule],
  controllers: [ZavrsniController],
  providers: [
    GkEvalService,
    BalanceSheetService,
    AprXmlService,
    ControlRulesService,
    StatementPdfService,
  ],
  exports: [
    GkEvalService,
    BalanceSheetService,
    AprXmlService,
    ControlRulesService,
    StatementPdfService,
  ],
})
export class ZavrsniModule {}

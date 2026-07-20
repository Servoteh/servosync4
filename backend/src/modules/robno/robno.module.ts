import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PostingModule } from "../gl/posting/posting.module";
import { RobnoController } from "./robno.controller";
import { RobnoService } from "./robno.service";
import { CalculationService } from "./calculation.service";
import { StockDocumentNumberingService } from "./stock-document-numbering.service";
import { CostingService } from "./costing.service";
import { NivelacijaService, COSTING_SERVICE } from "./nivelacija.service";
import { NIVELACIJA_HOOK } from "./nivelacija.hook";

/**
 * Robno / magacin (Faza 3) — costing, kalkulacija (landed cost), nivelacija, lager, popis (doc 39).
 *
 * DI portovi (labava sprega — paralelni servisi ne uvoze jedni druge direktno):
 *   - `COSTING_SERVICE` (StateProvider)      → `CostingService` (stateAsOf za nivelaciju)
 *   - `NIVELACIJA_HOOK` (hook iz kalkulacije) → `NivelacijaService`
 * Kada su vezani, ulaz robe (UL) posle kalkulacije AUTOMATSKI okida uprosečavanje
 * (doc 39 §F): |ulaznaVP−staraVP|≥0.01 → nova ponderisana valuaciona cena + NIV dokument + GK razlika.
 *
 * `NIV_NUMBERING` se NAMERNO ne vezuje — potpis `StockDocumentNumberingService.next` se razlikuje od
 * `NivNumberingProvider.nextNivNumber`; NivelacijaService pada na ugrađeni advisory-lock MAX fallback.
 *
 * Registracija u `app.module.ts` je posao integratora (dodati `RobnoModule` u `imports`).
 */
@Module({
  imports: [PrismaModule, PostingModule],
  controllers: [RobnoController],
  providers: [
    RobnoService,
    CalculationService,
    StockDocumentNumberingService,
    CostingService,
    NivelacijaService,
    { provide: COSTING_SERVICE, useExisting: CostingService },
    { provide: NIVELACIJA_HOOK, useExisting: NivelacijaService },
  ],
  exports: [RobnoService, CalculationService, CostingService],
})
export class RobnoModule {}

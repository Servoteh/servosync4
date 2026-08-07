import { Module } from "@nestjs/common";
import { PlanMontazeController } from "./plan-montaze.controller";
import { PlanMontazeService } from "./plan-montaze.service";

/**
 * Plan montaže + izveštaji montera — 3.0 TALAS C (podaci u sy15 bazi — Sy15Module,
 * globalan). Matični podaci (predmeti/komitenti) od 07.08.2026 idu iz 3.0 glavne baze
 * kroz `PrismaService` — PrismaModule je `@Global`, pa provajder nije potreban ovde.
 */
@Module({
  controllers: [PlanMontazeController],
  providers: [PlanMontazeService],
})
export class PlanMontazeModule {}

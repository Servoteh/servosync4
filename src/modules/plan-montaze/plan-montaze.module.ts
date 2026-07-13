import { Module } from "@nestjs/common";
import { PlanMontazeController } from "./plan-montaze.controller";
import { PlanMontazeService } from "./plan-montaze.service";

/** Plan montaže + izveštaji montera — 3.0 TALAS C (podaci u sy15 bazi — Sy15Module, globalan). */
@Module({
  controllers: [PlanMontazeController],
  providers: [PlanMontazeService],
})
export class PlanMontazeModule {}

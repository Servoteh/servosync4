import { Module } from "@nestjs/common";
import { PlanProizvodnjeController } from "./plan-proizvodnje.controller";
import { PlanProizvodnjeService } from "./plan-proizvodnje.service";

/** Plan proizvodnje — 3.0 TALAS C (podaci u sy15 bazi — Sy15Module, globalan). */
@Module({
  controllers: [PlanProizvodnjeController],
  providers: [PlanProizvodnjeService],
})
export class PlanProizvodnjeModule {}

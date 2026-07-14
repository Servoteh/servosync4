import { Module } from "@nestjs/common";
import { EnergetikaController } from "./energetika.controller";
import { EnergetikaService } from "./energetika.service";

/**
 * Energetika / SCADA — 3.0 TALAS E (nadzor kotlarnica/solara). Podaci u sy15 (1.0)
 * bazi (Sy15Module, @Global). R1 = read sloj; komande su R2 (MODULE_SPEC_scada_30.md).
 */
@Module({
  controllers: [EnergetikaController],
  providers: [EnergetikaService],
})
export class EnergetikaModule {}

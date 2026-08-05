import { Module } from "@nestjs/common";
import { ProjektniBiroController } from "./projektni-biro.controller";
import { ProjektniBiroService } from "./projektni-biro.service";
import { SastanciPbSourceService } from "../../common/sy15/sastanci-pb-source.service";

/**
 * Projektni biro — 3.0 TALAS D.
 *
 * Podaci danas žive u sy15 bazi (Sy15Module, globalan). Šema i podaci su preneti u
 * 3.0 (docs/SEOBA_SASTANCI_PB_2026-08-05.md), ali modul pod `SASTANCI_PB_IZVOR=3.0`
 * NAMERNO vraća 503 u celini: sva njegova prava izvode se iz `pb_current_employee_id()`,
 * tj. iz `employees` koji je još u sy15 (kadrovska = korak 4).
 */
@Module({
  controllers: [ProjektniBiroController],
  providers: [ProjektniBiroService, SastanciPbSourceService],
})
export class ProjektniBiroModule {}

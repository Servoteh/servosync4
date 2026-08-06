import { Module } from "@nestjs/common";
import { ProjektniBiroController } from "./projektni-biro.controller";
import { ProjektniBiroService } from "./projektni-biro.service";
import { PbSourceService } from "../../common/sy15/pb-source.service";

/**
 * Projektni biro — 3.0 TALAS D.
 *
 * Podaci danas žive u sy15 bazi (Sy15Module, globalan). Šema i podaci su preneti u
 * 3.0 (docs/SEOBA_SASTANCI_PB_2026-08-05.md), ali modul pod `PB_IZVOR=3.0`
 * NAMERNO vraća 503 u celini: sva njegova prava izvode se iz `pb_current_employee_id()`,
 * tj. iz `employees` koji je još u sy15 (kadrovska = korak 4).
 *
 * 🔴 `PB_IZVOR` je ZASEBAN prekidač od 06.08.2026 (§7h runbook-a). Ranije je PB
 * delio `SASTANCI_PB_IZVOR` sa sastancima, pa je preklop SASTANAKA na `3.0`
 * oborio ceo ovaj modul u 503. PB ostaje na `sy15` dok kadrovska ne pređe
 * (korak 4b plana gašenja) — bez obzira gde stoji `SASTANCI_IZVOR`.
 */
@Module({
  controllers: [ProjektniBiroController],
  providers: [ProjektniBiroService, PbSourceService],
})
export class ProjektniBiroModule {}

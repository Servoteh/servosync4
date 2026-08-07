import { Module } from "@nestjs/common";
import { EnergetikaController } from "./energetika.controller";
import { EnergetikaService } from "./energetika.service";
import { ScadaSourceService } from "../../common/sy15/scada-source.service";

/**
 * Energetika / SCADA — 3.0 TALAS E (nadzor kotlarnica/solara).
 *
 * Izvor podataka je na prekidaču `SCADA_IZVOR` (`ScadaSourceService`): `sy15`
 * (podrazumevano, Sy15Module @Global) ili `3.0` (PrismaService @Global).
 * Seoba: docs/SEOBA_SCADA_2026-08-07.md.
 *
 * Prekidač se provajduje po modulu (kao `PbSourceService` / `OdrzavanjeSourceService`) —
 * bez stanja je, samo čita env, pa zasebne instance ne mogu da se raziđu.
 * R1 = read sloj; komande su R2 (MODULE_SPEC_scada_30.md).
 */
@Module({
  controllers: [EnergetikaController],
  providers: [EnergetikaService, ScadaSourceService],
})
export class EnergetikaModule {}

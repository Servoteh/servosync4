import { Module } from "@nestjs/common";
import { SastanciController } from "./sastanci.controller";
import { SastanciService } from "./sastanci.service";
import { SastanciSamouslugaService } from "./sastanci-samousluga.service";
import { SastanciPbSourceService } from "../../common/sy15/sastanci-pb-source.service";

/**
 * Sastanci — 3.0 TALAS B.
 *
 * Podaci danas žive u sy15 bazi (Sy15Module, globalan). Seoba u 3.0 je pripremljena
 * i stoji iza prekidača `SASTANCI_PB_IZVOR` (docs/SEOBA_SASTANCI_PB_2026-08-05.md):
 * pod `3.0` samouslužne putanje idu kroz `SastanciSamouslugaService` (3.0 Prisma),
 * a sve ostalo namerno vraća 503.
 */
@Module({
  controllers: [SastanciController],
  providers: [
    SastanciService,
    SastanciSamouslugaService,
    SastanciPbSourceService,
  ],
})
export class SastanciModule {}

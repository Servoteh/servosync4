import { Module } from "@nestjs/common";
import { SastanciController } from "./sastanci.controller";
import { SastanciService } from "./sastanci.service";

/** Sastanci — 3.0 TALAS B (podaci u sy15 bazi — Sy15Module, globalan). */
@Module({
  controllers: [SastanciController],
  providers: [SastanciService],
})
export class SastanciModule {}

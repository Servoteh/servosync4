import { Module } from "@nestjs/common";
import { KadrovskaController } from "./kadrovska.controller";
import { KadrovskaService } from "./kadrovska.service";

/** Kadrovska (HR) — 3.0 TALAS G (podaci u sy15 bazi — Sy15Module, globalan). */
@Module({
  controllers: [KadrovskaController],
  providers: [KadrovskaService],
})
export class KadrovskaModule {}

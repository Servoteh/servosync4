import { Module } from "@nestjs/common";
import { KadrovskaController } from "./kadrovska.controller";
import { KadrovskaService } from "./kadrovska.service";
import { KadrovskaMutationsController } from "./kadrovska-mutations.controller";
import { KadrovskaMutationsService } from "./kadrovska-mutations.service";

/** Kadrovska (HR) — 3.0 TALAS G (podaci u sy15 bazi — Sy15Module, globalan).
 *  R1 read (KadrovskaController/Service) + R2 mutacije (Mutations*). */
@Module({
  controllers: [KadrovskaController, KadrovskaMutationsController],
  providers: [KadrovskaService, KadrovskaMutationsService],
})
export class KadrovskaModule {}

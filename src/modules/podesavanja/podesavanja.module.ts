import { Module } from "@nestjs/common";
import { PodesavanjaController } from "./podesavanja.controller";
import { PodesavanjaService } from "./podesavanja.service";

/** Podešavanja (RBAC admin + matični + sistem) — 3.0 TALAS D (podaci u sy15 — Sy15Module). */
@Module({
  controllers: [PodesavanjaController],
  providers: [PodesavanjaService],
})
export class PodesavanjaModule {}

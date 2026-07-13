import { Module } from "@nestjs/common";
import { PodesavanjaController } from "./podesavanja.controller";
import { PodesavanjaService } from "./podesavanja.service";
import { PodesavanjaUsersService } from "./podesavanja-users.service";

/** Podešavanja (RBAC admin + matični + sistem) — 3.0 TALAS D (podaci u sy15 — Sy15Module).
 *  D1 (R2) dvostrano upravljanje nalozima = `PodesavanjaUsersService` (GoTrue+sy15+2.0). */
@Module({
  controllers: [PodesavanjaController],
  providers: [PodesavanjaService, PodesavanjaUsersService],
})
export class PodesavanjaModule {}

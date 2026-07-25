import { Module } from "@nestjs/common";
import { PodesavanjaController } from "./podesavanja.controller";
import { PodesavanjaService } from "./podesavanja.service";
import { PodesavanjaUsersService } from "./podesavanja-users.service";
import { PredmetPlaneriService } from "./predmet-planeri.service";

/** Podešavanja (RBAC admin + matični + sistem) — 3.0 TALAS D (podaci u sy15 — Sy15Module).
 *  D1 (R2) dvostrano upravljanje nalozima = `PodesavanjaUsersService` (GoTrue+sy15+2.0).
 *  Planeri predmeta (016/26) = `PredmetPlaneriService` (3.0-native, glavna baza). */
@Module({
  controllers: [PodesavanjaController],
  providers: [PodesavanjaService, PodesavanjaUsersService, PredmetPlaneriService],
})
export class PodesavanjaModule {}

import { Module } from "@nestjs/common";
import { PodesavanjaController } from "./podesavanja.controller";
import { PodesavanjaService } from "./podesavanja.service";
import { PodesavanjaUsersService } from "./podesavanja-users.service";
import { PredmetPlaneriService } from "./predmet-planeri.service";
import { SyncSwitchService } from "./sync-switch.service";
import { CompanyDetailsService } from "./company-details.service";

/** Podešavanja (RBAC admin + matični + sistem) — 3.0 TALAS D (podaci u sy15 — Sy15Module).
 *  D1 (R2) dvostrano upravljanje nalozima = `PodesavanjaUsersService` (GoTrue+sy15+2.0).
 *  Planeri predmeta (016/26) = `PredmetPlaneriService` (3.0-native, glavna baza).
 *  `SyncSwitchService` je EKSPORTOVAN namerno: prekidač noćnog BigBit uvoza mora da se
 *  poštuje i u sync/scheduler modulima (uvezu `PodesavanjaModule` i injektuju servis).
 *  Nema ciklusa — Podešavanja ne zavise ni od sync-a ni od scheduler-a. */
@Module({
  controllers: [PodesavanjaController],
  providers: [
    PodesavanjaService,
    PodesavanjaUsersService,
    PredmetPlaneriService,
    SyncSwitchService,
    // Matični podaci firme (memorandum + IBAN/SWIFT za ino fakturu). Do 27.07.2026.
    // tabela `companies` nije imala nijednog pisca — podaci su stizali samo iz BigBita.
    CompanyDetailsService,
  ],
  exports: [SyncSwitchService],
})
export class PodesavanjaModule {}

import { Module } from "@nestjs/common";
import { SastanciController } from "./sastanci.controller";
import { SastanciRsvpController } from "./sastanci-rsvp.controller";
import { SastanciService } from "./sastanci.service";
import { SastanciSamouslugaService } from "./sastanci-samousluga.service";
import { SastanciAuthzService } from "./sastanci-authz.service";
import { SastanciFnService } from "./sastanci-fn.service";
import { SastanciPredmetService } from "./sastanci-predmet.service";
import { SastanciSourceService } from "../../common/sy15/sastanci-source.service";

/**
 * Sastanci — 3.0 TALAS B.
 *
 * Podaci danas žive u sy15 bazi (Sy15Module, globalan). Seoba u 3.0 stoji iza
 * prekidača `SASTANCI_IZVOR` (docs/SEOBA_SASTANCI_PB_2026-08-05.md §7h — od
 * 06.08. je odvojen od `PB_IZVOR`, pa preklop sastanaka ne dira projektni biro).
 * Pod `3.0`:
 *  - `SastanciSamouslugaService` — 4 samouslužne DEFINER fn (RSVP, priprema,
 *    status moje akcije, moja podešavanja),
 *  - `SastanciFnService` — 17 pozvanih DEFINER fn + 6 logičkih trigera domena,
 *  - `SastanciAuthzService` — 3.0 parnjak sy15 gejtova (`current_user_is_management`,
 *    `has_edit_role`, `is_sastanak_ucesnik`, `sast_user_can_move_weekly`),
 * a putanje koje JOŠ NISU prenete i dalje namerno vraćaju 503 (brana u
 * `withUserMapped`/`runIdem`).
 *
 * Servisi su izvezeni jer ih koristi i scheduler (enqueue/dispatch poslovi).
 *
 * ⚠️ `SastanciRsvpController` je JAVAN (bez `JwtAuthGuard`) — magic-link „Dolazim /
 * Ne dolazim" iz mejla je sam sebi autentikacija, i klikće ga i onaj ko NEMA nalog
 * u 3.0. Zato je zaseban kontroler, a ne metoda u `SastanciController` koji na nivou
 * klase nosi `@UseGuards(JwtAuthGuard, PermissionsGuard)`.
 */
@Module({
  controllers: [SastanciController, SastanciRsvpController],
  providers: [
    SastanciService,
    SastanciSamouslugaService,
    SastanciAuthzService,
    SastanciFnService,
    SastanciPredmetService,
    SastanciSourceService,
  ],
  exports: [SastanciFnService, SastanciAuthzService, SastanciSourceService],
})
export class SastanciModule {}

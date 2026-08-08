import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { IdempotencyModule } from "../../common/idempotency/idempotency.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
import { ReversiLokacijeIzvorModule } from "../../common/sy15/reversi-lokacije-izvor.module";
import { MasinaOtpisNotifyService } from "./masina-otpis-notify.service";
import { OdrzavanjeAuthzService } from "./odrzavanje-authz.service";
import { OdrzavanjeFnService } from "./odrzavanje-fn.service";
import { OdrzavanjeLokacijeMostService } from "./odrzavanje-lokacije-most.service";
import { OdrzavanjeController } from "./odrzavanje.controller";
import { OdrzavanjeService } from "./odrzavanje.service";

/**
 * Održavanje (CMMS) — 3.0 TALAS F; podaci u sy15 (1.0) bazi (Sy15Module, doktrina §A.1).
 *
 * `PrismaModule`/`NotificationsModule` su tu SAMO zbog obaveštenja o otpisu mašine
 * (zahtev 037/26): primaoci (šef proizvodnje) i inbox zvonceta žive u GLAVNOJ bazi,
 * a CMMS outbox za mejl je mrtav po dizajnu — obrazloženje u
 * `masina-otpis-notify.service.ts`. `MailService` je globalan (@Global), pa nije u imports.
 *
 * `IdempotencyModule` je registar idempotencije 3.0 baze (`api_idempotency`) — 3.0
 * parnjak sy15 `rev_api_idempotency` koji `runIdem` koristi pod `ODRZAVANJE_IZVOR=3.0`.
 * Modul JESTE `@Global` (app.module.ts), ali se navodi izričito: zavisnost se vidi na
 * mestu gde nastaje, i modul se može dići samostalno u testu bez cele aplikacije.
 */
@Module({
  imports: [
    PrismaModule,
    IdempotencyModule,
    NotificationsModule,
    // 🔴 NALAZ C (08.08.2026): most ka `loc_locations` mora da VIDI `LOKACIJE_IZVOR`.
    // Bez ovog uvoza `@Optional()` prekidač u mostu ostaje `undefined` — dakle MRTAV
    // (tačno kvar iz prvog kruga: prekidač provajdovan, a nigde injektovan).
    // Uvoz je bezopasan: `ReversiModule`/`LocationsModule` ga već uvoze, pa
    // `assertSpojeniIzvori` u njegovom `onModuleInit` ne dodaje nov način pada.
    ReversiLokacijeIzvorModule,
  ],
  controllers: [OdrzavanjeController],
  providers: [
    OdrzavanjeService,
    MasinaOtpisNotifyService,
    // Korak 2 gašenja sy15: prekidač `ODRZAVANJE_IZVOR` + 3.0 parnjak RLS-a.
    // `OdrzavanjeSourceService` se EXPORT-uje jer ga koriste i scheduler
    // (`maint-deadlines`, `maint-notify-dispatch`), AI-chat (maint alati) i
    // Reversi (čitanje mašina kroz `v_rev_machines`) — v. zaglavlje tog servisa.
    OdrzavanjeSourceService,
    OdrzavanjeAuthzService,
    // Prepis 14 DEFINER funkcija + 11 logičkih trigera nad 3.0 bazom.
    OdrzavanjeFnService,
    // 🔴 Privremeni MOST ka `loc_locations` (sy15) — dug za korak 3 (Lokacije).
    // Jedini upis održavanja u sy15 pod `ODRZAVANJE_IZVOR=3.0`; v. zaglavlje.
    OdrzavanjeLokacijeMostService,
  ],
  exports: [
    OdrzavanjeSourceService,
    OdrzavanjeAuthzService,
    OdrzavanjeFnService,
    OdrzavanjeLokacijeMostService,
  ],
})
export class OdrzavanjeModule {}

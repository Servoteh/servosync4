import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
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
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
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

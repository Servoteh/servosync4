import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { MasinaOtpisNotifyService } from "./masina-otpis-notify.service";
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
  providers: [OdrzavanjeService, MasinaOtpisNotifyService],
})
export class OdrzavanjeModule {}

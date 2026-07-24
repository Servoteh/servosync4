import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { MontazaNeusaglasenostiController } from "./montaza-neusaglasenosti.controller";
import { MontazaNeusaglasenostiService } from "./montaza-neusaglasenosti.service";
import { MontazaNmNumberingService } from "./montaza-nm-numbering.service";
import { MontazaNmMailService } from "./montaza-nm-mail.service";

/**
 * Neusaglašenosti na montaži — zaseban 2.0-native modul (zahtev 004/26,
 * MODULE_SPEC_montaza_neusaglasenosti). App-owned tabele (`montage_nonconformities*`),
 * nula sprege sa Kvalitetom i sy15. Zavisnosti: PrismaModule (baza), NotificationsModule
 * (in-app zvonce menadžmentu), MailService je @Global (MailModule) → injektuje se bez importa.
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [MontazaNeusaglasenostiController],
  providers: [
    MontazaNeusaglasenostiService,
    MontazaNmNumberingService,
    MontazaNmMailService,
  ],
})
export class MontazaNeusaglasenostiModule {}

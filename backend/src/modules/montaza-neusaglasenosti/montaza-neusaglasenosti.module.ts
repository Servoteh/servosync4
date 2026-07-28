import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { MontazaNeusaglasenostiController } from "./montaza-neusaglasenosti.controller";
import { MontazaNeusaglasenostiService } from "./montaza-neusaglasenosti.service";
import { MontazaNmNumberingService } from "./montaza-nm-numbering.service";
import { MontazaNmMailService } from "./montaza-nm-mail.service";
import { MontazaNmKarticaService } from "./montaza-nm-kartica.service";
import { PdmModule } from "../pdm/pdm.module";

/**
 * Neusaglašenosti na montaži — zaseban 2.0-native modul (zahtev 004/26,
 * MODULE_SPEC_montaza_neusaglasenosti). App-owned tabele (`montage_nonconformities*`),
 * nula sprege sa Kvalitetom i sy15. Zavisnosti: PrismaModule (baza), NotificationsModule
 * (in-app zvonce menadžmentu), MailService je @Global (MailModule) → injektuje se bez importa.
 */
@Module({
  // PdmModule (034/26): deljeni `PdmService.getPdfContent` za „Otvori crtež" — isti
  // obrazac kao kiosk PDF ruta u TechProcessesModule. Barkod se parsira čistom
  // funkcijom (`tech-processes/barcode`), bez sprege sa tim servisom.
  imports: [PrismaModule, NotificationsModule, PdmModule],
  controllers: [MontazaNeusaglasenostiController],
  providers: [
    MontazaNeusaglasenostiService,
    MontazaNmNumberingService,
    MontazaNmMailService,
    MontazaNmKarticaService,
  ],
})
export class MontazaNeusaglasenostiModule {}

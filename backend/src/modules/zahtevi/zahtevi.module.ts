import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ZahteviController } from "./zahtevi.controller";
import { ZahteviService } from "./zahtevi.service";
import { ZahteviAiService } from "./zahtevi-ai.service";
import { ZahteviRewardsService } from "./zahtevi-rewards.service";
import { ZahteviDecisionsService } from "./zahtevi-decisions.service";
import { ZahteviMailService } from "./zahtevi-mail.service";
import { RequestNumberingService } from "./request-numbering.service";

/**
 * Zahtevi — AI PM modul (MODULE_SPEC_zahtevi §0). Platformski modul (kao sastanci/nabavka).
 * Zavisnosti: PrismaModule (baza); Sy15StorageService (prilozi), AiProviderService (STT/AI) i
 * MailService (obaveštenja) su @Global() (Sy15Module / AiModule / MailModule) → injektuju se
 * bez importa. Nula sprege sa drugim domenima.
 * F3 (AI): trijaža/detaljna analiza/Claude paket/restore/transkripcija.
 * F4: nagrade (ZahteviRewardsService), Decision Log (ZahteviDecisionsService),
 *     obaveštenja podnosiocu (ZahteviMailService).
 */
@Module({
  imports: [PrismaModule],
  controllers: [ZahteviController],
  providers: [
    ZahteviService,
    ZahteviAiService,
    ZahteviRewardsService,
    ZahteviDecisionsService,
    ZahteviMailService,
    RequestNumberingService,
  ],
})
export class ZahteviModule {}

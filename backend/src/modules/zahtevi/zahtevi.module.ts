import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ZahteviController } from "./zahtevi.controller";
import { ZahteviService } from "./zahtevi.service";
import { RequestNumberingService } from "./request-numbering.service";

/**
 * Zahtevi — AI PM modul (MODULE_SPEC_zahtevi §0). Platformski modul (kao sastanci/nabavka).
 * Zavisnosti: PrismaModule (baza); Sy15StorageService (prilozi) i AiProviderService (STT) su
 * @Global() (Sy15Module / AiModule) → injektuju se bez importa. Nula sprege sa drugim domenima.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ZahteviController],
  providers: [ZahteviService, RequestNumberingService],
})
export class ZahteviModule {}

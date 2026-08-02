import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { DictationInboxController } from "./dictation-inbox.controller";
import { DictationInboxService } from "./dictation-inbox.service";
import { DictationDelegatesController } from "./dictation-delegates.controller";
import { DictationDelegatesService } from "./dictation-delegates.service";

/**
 * Diktafon „sanduče" (scenario B — telefon diktira, agent povlači). Presečna
 * infra STT/refine (`MediaAiModule`) i dalje radi transkripciju; ovaj modul ODLAŽE
 * sređen tekst (`dictation_inbox`) i daje dva puta za preuzimanje: dosadašnji
 * read-only psql iz lokalne mreže, i `POST …/claim` preko HTTP-a za agenta koji je
 * VAN nje (oblak). `dictation_delegates` + `DictationDelegatesController`
 * (permisija `settings.users`) presuđuju ko sme u čije sanduče.
 *
 * Bez novih zavisnosti; guard `ai.chat` kroz PermissionsGuard (AuthzModule je
 * global, guard je dostupan svuda).
 */
@Module({
  imports: [PrismaModule],
  controllers: [DictationInboxController, DictationDelegatesController],
  providers: [DictationInboxService, DictationDelegatesService],
})
export class DictationInboxModule {}

import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { DictationInboxController } from "./dictation-inbox.controller";
import { DictationInboxService } from "./dictation-inbox.service";

/**
 * Diktafon „sanduče" (scenario B — telefon diktira, Claude povlači). Presečna
 * infra STT/refine (`MediaAiModule`) i dalje radi transkripciju; ovaj modul samo
 * ODLAŽE sređen tekst (`dictation_inbox`) da ga Claude Code povuče read-only iz
 * baze. Bez novih zavisnosti; guard `ai.chat` kroz PermissionsGuard (AuthzModule
 * je global, guard je dostupan svuda).
 */
@Module({
  imports: [PrismaModule],
  controllers: [DictationInboxController],
  providers: [DictationInboxService],
})
export class DictationInboxModule {}

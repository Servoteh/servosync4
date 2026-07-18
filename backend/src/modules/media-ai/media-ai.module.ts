import { Module } from "@nestjs/common";
import { MediaAiController } from "./media-ai.controller";
import { MediaAiService } from "./media-ai.service";

/**
 * Media/AI (Talas B, presuda B4) — STT + refine; AiProviderService je globalan.
 * Zaseban modul da ga C/D/G talasi reuse-uju bez zavisnosti od Sastanci/AI chat.
 */
@Module({
  controllers: [MediaAiController],
  providers: [MediaAiService],
})
export class MediaAiModule {}

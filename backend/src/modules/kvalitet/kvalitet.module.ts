import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { QualityController } from "./kvalitet.controller";
import { QualityService } from "./kvalitet.service";

/**
 * Kontrola kvaliteta — evidencija neusaglašenosti (škart + dorada), K1
 * (MODULE_SPEC_kontrola_kvaliteta §4–§7). Registrovan u `app.module.ts`.
 * `QualityService` se EXPORT-uje jer ga `tech-processes` (`control()`) zove za
 * auto-draft iz kucanja kontrole (`createDraftFromControl`, best-effort — §5).
 */
@Module({
  imports: [PrismaModule],
  controllers: [QualityController],
  providers: [QualityService],
  exports: [QualityService],
})
export class QualityModule {}

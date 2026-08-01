import { Module } from "@nestjs/common";
import { DocumentTypesController } from "./document-types.controller";
import { DocumentTypesService } from "./document-types.service";

/**
 * Registar vrsta dokumenata — konfiguracija ekrana unosa (PLAN_UNOS_DOKUMENATA §5.1/§5.7).
 * Read-only; `PrismaModule` je @Global pa se ne uvozi. Servis se izvozi da ga dokumentski
 * moduli (sales/robno/nabavka) mogu čitati bez HTTP poziva.
 */
@Module({
  controllers: [DocumentTypesController],
  providers: [DocumentTypesService],
  exports: [DocumentTypesService],
})
export class DocumentTypesModule {}

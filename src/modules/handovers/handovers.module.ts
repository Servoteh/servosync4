import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { HandoversController } from "./handovers.controller";
import { HandoversService } from "./handovers.service";
import { HandoverDraftsController } from "./handover-drafts.controller";
import { HandoverDraftsService } from "./handover-drafts.service";
import { DraftNumberingService } from "./draft-numbering.service";
import { PrintBundleService } from "./print-bundle.service";

/**
 * Nacrti + Primopredaje (MODULE_SPEC_nacrti_primopredaje) — jedan modul,
 * dva pod-resursa (kao `directory/` i `structures/`):
 *   - `handover-drafts` (Nacrti): CRUD osnovnog unosa nad `handover_drafts`/`handover_draft_items`.
 *   - `handovers` (Primopredaje): pregled + approve/reject/launch nad `drawing_handovers`.
 *   - `PrintBundleService` (P3): štampa svih crteža nacrta/primopredaje — spojen PDF (pdf-lib),
 *     grupisanje po formatu strane; zajednički helper za oba nivoa.
 *
 * BEZ notifikacionog podsistema (nema `app_notifications` tabele ovog talasa — inbox
 * se rešava filtriranjem, ne "zvoncem"). BEZ šema izmena/migracija. Ne dira work-orders folder.
 *
 * Registracija u `app.module.ts` je posao integratora (dodati `HandoversModule` u `imports`).
 */
@Module({
  imports: [PrismaModule],
  controllers: [HandoversController, HandoverDraftsController],
  providers: [
    HandoversService,
    HandoverDraftsService,
    DraftNumberingService,
    PrintBundleService,
  ],
})
export class HandoversModule {}

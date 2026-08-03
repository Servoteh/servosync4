import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { WorkOrdersModule } from "../work-orders/work-orders.module";
import { LaunchNotifyModule } from "./launch-notify.module";
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
 * D8: `handover-drafts.submit()` emituje in-app notifikaciju grupi TEHNOLOG
 * („Kreirana nova primopredaja…") preko `NotificationsService` (NotificationsModule).
 *
 * 016/26: obaveštenje planerima o lansiranju živi u `LaunchNotifyModule` (deljeno sa
 * `WorkOrdersModule` — lansiranje sa ekrana „Radni nalozi" je isti događaj).
 *
 * 030/26: `WorkOrdersModule` se uvozi zbog deljenog `WorkOrderNumberingService` —
 * numeracija RN iz primopredaje je bila lokalna KOPIJA te logike, pa je fix
 * brojača od 27.07. pokrio samo work-orders put dok je primopredaja nastavila
 * da deli otrovne brojeve (7701/770171835…844, 03.08). Zavisnost je
 * jednosmerna (WorkOrdersModule NE uvozi HandoversModule — samo mini
 * LaunchNotifyModule), pa nema ciklusa.
 *
 * Registracija u `app.module.ts` je posao integratora (dodati `HandoversModule` u `imports`).
 */
@Module({
  imports: [PrismaModule, NotificationsModule, LaunchNotifyModule, WorkOrdersModule],
  controllers: [HandoversController, HandoverDraftsController],
  providers: [
    HandoversService,
    HandoverDraftsService,
    DraftNumberingService,
    PrintBundleService,
  ],
})
export class HandoversModule {}

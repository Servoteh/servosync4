import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { QualityController } from "./kvalitet.controller";
import { QualityService } from "./kvalitet.service";
import { QualityEventsController } from "./quality-events.controller";
import { QualityEventsService } from "./quality-events.service";
import { QualityEventsMailService } from "./quality-events-mail.service";

/**
 * Kontrola kvaliteta. Dva ko-locirana toka pod istom bazom putanje „kvalitet":
 *  1) K1 — evidencija neusaglašenosti (nonconformity_reports; MODULE_SPEC_kontrola_kvaliteta §4/§7).
 *     `QualityService` se EXPORT-uje jer ga `tech-processes` (`control()`) zove za auto-draft.
 *  2) Škart i dorada — događaj-tok sa TRI statusa (quality_events + quality_reason_codes;
 *     MODULE_SPEC_kvalitet_skart_dorada, presuda 26.07). Zvonce menadžmentu iznad praga
 *     (in-app + mail) → import NotificationsModule; MailService je @Global (MailModule).
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [QualityController, QualityEventsController],
  providers: [QualityService, QualityEventsService, QualityEventsMailService],
  exports: [QualityService],
})
export class QualityModule {}

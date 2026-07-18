import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";

/**
 * In-app notifikacije (`app_notifications`, D8 prva faza — PLAN_dorade §D8):
 * inbox/unread-count/mark-read REST + `NotificationsService.notifyWorkers()`
 * kao jedina write tačka za domenske emit-ove (tech-processes control() na
 * doradu/škart, handover-drafts submit() na novu primopredaju).
 *
 * Email/nedeljni izveštaj škarta je BACKLOG (D8-v2) — NIJE deo ovog modula.
 * Servis se eksportuje da ga emit moduli injektuju (import NotificationsModule).
 */
@Module({
  imports: [PrismaModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

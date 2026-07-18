import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthUser } from "../auth/jwt.strategy";
import { NotificationsService } from "./notifications.service";
import type { ListNotificationsQuery } from "./notifications.service";

/**
 * In-app notifikacije („zvonce", D8 prva faza):
 *   GET  /api/v1/notifications              — inbox radnika iz JWT-a (unreadOnly, limit)
 *   GET  /api/v1/notifications/unread-count — broj nepročitanih (polling 30 s)
 *   POST /api/v1/notifications/:id/read     — označi pročitanu (403 tuđa)
 *   POST /api/v1/notifications/read-all     — označi sve pročitane
 *
 * Samo JWT, BEZ posebne permisije (odluka zadatka D4): svako vidi ISKLJUČIVO
 * svoje notifikacije — filter po `request.user.workerId` (users.worker_id).
 * Nalog bez vezanog radnika (deljeni terminali) ima prazan inbox — nije greška.
 */
@UseGuards(JwtAuthGuard)
@Controller({ path: "notifications", version: "1" })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Query() query: ListNotificationsQuery, @Req() req: { user: AuthUser }) {
    return this.notifications.list(req.user, query);
  }

  @Get("unread-count")
  unreadCount(@Req() req: { user: AuthUser }) {
    return this.notifications.unreadCount(req.user);
  }

  @Post("read-all")
  markAllRead(@Req() req: { user: AuthUser }) {
    return this.notifications.markAllRead(req.user);
  }

  @Post(":id/read")
  markRead(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.notifications.markRead(req.user, id);
  }
}

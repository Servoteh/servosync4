import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../auth/jwt.strategy";
import { uniqueIds } from "../../common/relations";

/**
 * `worker_types.name` for the technologist group (prod: id 1, name 'Tehnolog').
 * Matched by name (case-insensitive) rather than a hard-coded id so a reseeded
 * lookup table keeps working; multiple matching types are all included.
 */
const TECHNOLOGIST_TYPE_NAME = "Tehnolog";

/** Payload for one logical notification, fanned out to N recipient workers. */
export interface NotifyPayload {
  /** Kind, e.g. 'kontrola.skart' | 'kontrola.dorada' | 'primopredaja.nova'. */
  type: string;
  /** Fully rendered Serbian message (truncated to the 500-char column). */
  message: string;
  /** Referenced table for UI navigation ('work_orders', 'handover_drafts'…). */
  refTable?: string | null;
  refId?: number | null;
}

export interface ListNotificationsQuery {
  /** `"true"` = only unread. */
  unreadOnly?: string;
  /** Max rows (default 30, cap 100). */
  limit?: string;
}

/**
 * In-app notifications (`app_notifications`, D8 first phase) — materialised
 * per-recipient rows keyed by `workers.id`.
 *
 * Read/mark endpoints are scoped by the JWT's `workerId` (users.worker_id
 * bridge): an account without a linked worker simply sees an empty inbox —
 * that is not an error (shared terminal accounts have no worker link by
 * design, Nesa 2026-07-09).
 *
 * `notifyWorkers()` is the single write entry point for domain emits. Emit
 * call sites MUST wrap it in try/catch — a failed notification must never
 * break the business mutation it accompanies (PLAN_dorade §D8).
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- WRITE (emit)

  /**
   * Create one notification row per recipient worker (deduplicated, 0/null
   * recipients dropped). Returns the number of rows created.
   */
  async notifyWorkers(
    workerIds: number[],
    payload: NotifyPayload,
  ): Promise<number> {
    const recipients = uniqueIds(workerIds);
    if (!recipients.length) return 0;

    const result = await this.prisma.appNotification.createMany({
      data: recipients.map((recipientWorkerId) => ({
        type: payload.type,
        message: payload.message.slice(0, 500),
        refTable: payload.refTable ?? null,
        refId: payload.refId ?? null,
        recipientWorkerId,
      })),
    });
    return result.count;
  }

  /**
   * Recipient group TEHNOLOG: active workers whose worker type is 'Tehnolog'
   * (worker_types id 1 on prod; matched by name). Two batch queries — no
   * required JOIN (orphan `workerTypeId` must not 500, legacy-read rule).
   */
  async resolveTechnologistWorkerIds(): Promise<number[]> {
    const types = await this.prisma.workerType.findMany({
      where: { name: { equals: TECHNOLOGIST_TYPE_NAME, mode: "insensitive" } },
      select: { id: true },
    });
    const typeIds = types.map((t) => t.id).filter((id) => id > 0);
    if (!typeIds.length) return [];

    const workers = await this.prisma.worker.findMany({
      where: { active: true, workerTypeId: { in: typeIds } },
      select: { id: true },
    });
    return workers.map((w) => w.id);
  }

  // ---------------------------------------------------------------- READ

  /** Inbox of the JWT's worker, newest first. No worker link → empty inbox. */
  async list(user: AuthUser | undefined, query: ListNotificationsQuery) {
    const workerId = user?.workerId ?? null;
    const limitParsed = Number.parseInt(query.limit ?? "", 10);
    const limit = Number.isNaN(limitParsed)
      ? 30
      : Math.min(100, Math.max(1, limitParsed));

    if (!workerId) {
      return { data: [], meta: { workerId: null, limit, unreadCount: 0 } };
    }

    const unreadWhere = { recipientWorkerId: workerId, readAt: null };
    const [rows, unreadCount] = await this.prisma.$transaction([
      this.prisma.appNotification.findMany({
        where:
          query.unreadOnly === "true"
            ? unreadWhere
            : { recipientWorkerId: workerId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
      this.prisma.appNotification.count({ where: unreadWhere }),
    ]);

    return { data: rows, meta: { workerId, limit, unreadCount } };
  }

  /** Lightweight unread counter for the bell badge (30 s polling target). */
  async unreadCount(user: AuthUser | undefined) {
    const workerId = user?.workerId ?? null;
    if (!workerId) return { data: { unread: 0 } };

    const unread = await this.prisma.appNotification.count({
      where: { recipientWorkerId: workerId, readAt: null },
    });
    return { data: { unread } };
  }

  // ---------------------------------------------------------------- MARK READ

  /** Mark one notification read. 403 when it belongs to another worker; idempotent. */
  async markRead(user: AuthUser | undefined, id: number) {
    const notification = await this.prisma.appNotification.findUnique({
      where: { id },
    });
    if (!notification)
      throw new NotFoundException(`Notifikacija ${id} ne postoji.`);

    const workerId = user?.workerId ?? null;
    if (!workerId || notification.recipientWorkerId !== workerId)
      throw new ForbiddenException(
        "Notifikacija pripada drugom radniku — ne može se označiti kao pročitana.",
      );

    if (notification.readAt) return { data: notification }; // idempotent

    const updated = await this.prisma.appNotification.update({
      where: { id },
      data: { readAt: new Date() },
    });
    return { data: updated };
  }

  /** Mark all of the worker's unread notifications read. */
  async markAllRead(user: AuthUser | undefined) {
    const workerId = user?.workerId ?? null;
    if (!workerId) return { data: { updated: 0 } };

    const result = await this.prisma.appNotification.updateMany({
      where: { recipientWorkerId: workerId, readAt: null },
      data: { readAt: new Date() },
    });
    return { data: { updated: result.count } };
  }
}

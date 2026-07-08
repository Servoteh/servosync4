import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { PrismaService } from "../../prisma/prisma.service";

interface RequestLike {
  method: string;
  originalUrl?: string;
  url: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  user?: { userId: number; email: string };
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Globalni audit mutirajućih HTTP operacija → `audit_log` (BACKEND_RULES §8).
 * Append-only; upis je fire-and-forget (audit ne sme da obori zahtev).
 * entityType/entityId se izvode iz URL-a (/api/v1/<resurs>/<id>/<akcija>).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestLike>();
    if (!MUTATING.has(req.method)) return next.handle();

    const url = req.originalUrl ?? req.url;
    // /api/v1/work-orders/123/approve -> entityType=work-orders, entityId=123, action=approve
    const parts = url.split("?")[0].split("/").filter(Boolean); // [api, v1, resurs, id?, akcija?]
    const resource = parts[2] ?? "unknown";
    const maybeId = parts[3];
    const maybeAction = parts[4];

    return next.handle().pipe(
      tap(() => {
        const ua = req.headers["user-agent"];
        this.prisma.auditLog
          .create({
            data: {
              actorUserId: req.user?.userId ?? null,
              actorUsername: req.user?.email ?? null,
              action: `${req.method} ${maybeAction ?? resource}`.toUpperCase(),
              entityType: resource,
              entityId: maybeId ?? null,
              afterData: this.safeBody(req.body),
              ipAddress: req.ip ?? null,
              userAgent: Array.isArray(ua) ? ua[0] : (ua ?? null),
            },
          })
          .catch((err: unknown) =>
            this.logger.warn(
              `Audit upis nije uspeo za ${req.method} ${url}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }),
    );
  }

  /** Telo zahteva bez očiglednih tajni; ograničeno da ne naduva audit_log. */
  private safeBody(body: unknown): object | undefined {
    if (!body || typeof body !== "object") return undefined;
    const clone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      clone[k] = /password|token|secret/i.test(k) ? "[redacted]" : v;
    }
    const json = JSON.stringify(clone);
    return json.length > 8_000 ? { _truncated: true } : clone;
  }
}

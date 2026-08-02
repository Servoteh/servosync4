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
 * Polja koja se po RESURSU (treći segment URL-a) NE smeju naći u `audit_log`.
 *
 * Podrazumevano ovaj interceptor upisuje celo telo zahteva — što je za većinu ruta
 * korisno (vidi se šta je tačno promenjeno). Ali za diktafon je to bio TIH PROPUST:
 * spec modula tvrdi „tekst diktata se NIKAD ne loguje", a globalni audit je uz svaki
 * `POST /api/v1/dictation-inbox` upisivao ceo diktat u `after_data` (potvrđeno na
 * produkciji: 3 postojeća reda sa punim tekstom). Sanduče je komandni kanal i tekst
 * ume da nosi poslovne podatke, pa u audit ide samo DOKAZ da je nešto poslato.
 *
 * Isto važi za `POST /api/v1/ai/refine`: telefon kroz njega provuče SIROV transkript
 * pre nego što ga odloži u sanduče, pa bi bez ovoga isti tekst i dalje curio u audit —
 * samo kroz susednu rutu.
 *
 * Umesto redigovane vrednosti upisuje se `<polje>_len` (dužina) — dovoljno da se vidi
 * da je poruka bila tu i kolika je, bez sadržaja. Ostale rute se NE diraju.
 */
const REDACTED_BODY_FIELDS: Record<string, readonly string[]> = {
  "dictation-inbox": ["text"],
  ai: ["tekst"],
};

/** Ista oznaka kao za lozinke/tokene niže — jedan obrazac za ceo audit. */
const REDACTED = "[redacted]";

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
              afterData: this.safeBody(req.body, resource),
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

  /**
   * Telo zahteva bez očiglednih tajni; ograničeno da ne naduva audit_log.
   * `resource` (treći segment URL-a) bira dodatna polja koja se skidaju iz tela —
   * vidi `REDACTED_BODY_FIELDS`.
   */
  private safeBody(body: unknown, resource = ""): object | undefined {
    if (!body || typeof body !== "object") return undefined;
    const perRoute = REDACTED_BODY_FIELDS[resource] ?? [];
    const clone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (perRoute.includes(k)) {
        // Sadržaj NIKAD ne ulazi u audit; ostaje dokaz da ga je bilo i kolika je dužina.
        clone[k] = REDACTED;
        clone[`${k}_len`] = typeof v === "string" ? v.length : null;
        continue;
      }
      clone[k] = /password|token|secret/i.test(k) ? REDACTED : v;
    }
    const json = JSON.stringify(clone);
    return json.length > 8_000 ? { _truncated: true } : clone;
  }
}

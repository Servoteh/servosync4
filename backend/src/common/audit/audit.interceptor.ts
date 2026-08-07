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
  /**
   * Imenovani parametri rute (`:id`, `:sourceId`, `:opId`…). Express ih popuni
   * pri uparivanju rute, a interceptor se izvršava POSLE toga — pa su ovde
   * dostupni. Ako neki drugi transport ne popuni `params`, pada se na segmente
   * putanje (v. `routeTrail`).
   */
  params?: Record<string, unknown>;
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
 * E-mail u SEGMENTU PUTANJE (`…/ucesnici/pera@servoteh.com`), i u `%40` obliku.
 *
 * 🔴 Zašto postoji: dodavanje putanje u `metadata` inače uvodi NOV podatak u audit.
 * `PATCH`/`DELETE /api/v1/sastanci/:id/ucesnici/:email` nose tuđu adresu (učesnikovu,
 * ne akterovu) kao šesti segment; do sada je nije bilo nigde u `audit_log`, a
 * retencija je 24 meseca. Trag rute sme da kaže KOJA je ruta pozvana — ne i čija je
 * adresa u njoj. `actor_username` (ko je radio) se ne dira i ostaje kao i pre.
 */
const EMAIL_U_PUTANJI = /[^/@\s]+(?:@|%40)[^/@\s]+\.[A-Za-z]{2,}/g;

function redactEmails(s: string): string {
  return s.replace(EMAIL_U_PUTANJI, REDACTED);
}

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
              metadata: this.routeTrail(req.params, url),
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
   * 🔴 TRAG RUTE — puna putanja + SVI imenovani parametri (odluka Nenad 07.08.2026).
   *
   * Zašto: `entityId` se izvodi iz ČETVRTOG segmenta URL-a, a `action` iz petog.
   * Sve dalje se do sada trajno gubilo. Praktična posledica, izmereno na produkciji:
   *
   *   • `POST /work-orders/:id/copy-from/:sourceId` (346 poziva u 30 dana) upisivao je
   *     samo cilj — IZ KOG naloga je postupak prepisan nije se moglo saznati. Kad je
   *     07.08. prijavljeno da se „postupak sam pojavio" na nalogu 9811-2/120, audit je
   *     mogao da kaže KO i KADA, ali ne i ODAKLE. Bez toga se promašen izbor izvora ne
   *     razlikuje od kvara u kodu, pa se dan potroši na lov na duha.
   *   • `PATCH` i `DELETE /work-orders/:id/operations/:opId` (2.171 poziv u 30 dana)
   *     gube `opId` — vidi se da je operacija dirnuta, ne i KOJA.
   *   • `PATCH /work-orders/operations/:opId/priority` uparuje se pogrešno
   *     (`entityId = "operations"`), jer `:opId` stoji na mestu akcije.
   *
   * Namerno se NE dira izvođenje `action`/`entityType`/`entityId` — po njima se već
   * pretražuje istorija i postojeći upiti bi se raspali. Trag se DODAJE u `metadata`,
   * koja je do sada bila prazna na svim rutama, pa nema šta da se pokvari.
   *
   * `params` su izvor istine (semantični su: `{id, sourceId}`), a putanja ide uz njih
   * kao dokaz — po njoj se sanira i slučaj gde `params` iz bilo kog razloga izostanu.
   * (Da Nest u trenutku globalnog interceptora popuni `params` NIJE dokazano nad
   * pravim rutiranjem — zato `path` stoji UVEK i nosi isti podatak i bez njih.)
   */
  private routeTrail(
    params: Record<string, unknown> | undefined,
    url: string,
  ): object {
    const path = redactEmails(url.split("?")[0]);
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(params ?? {})) {
      // Express ume da doda i numeričke ključeve za neimenovane grupe — ti ne znače
      // ništa čitaocu audita, pa u trag idu samo imenovani parametri.
      if (/^\d+$/.test(k)) continue;
      if (typeof v === "string" || typeof v === "number")
        clean[k] = redactEmails(String(v));
    }
    return Object.keys(clean).length > 0 ? { path, params: clean } : { path };
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

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSION_KEY_METADATA } from "./require-permission.decorator";
import { resolvePermissionDecision } from "./effective-permission";
import { PrismaService } from "../../prisma/prisma.service";
import type { PermissionKey } from "./permissions";

/**
 * Permission guard with a staged rollout (AUTHZ_UNIFIED §6.1/§8 — prod-only environment):
 *
 *  - AUTHZ_ENFORCE=false (default) → SHADOW MODE: evaluates the decision, logs
 *    would-be denials (user, role, permission, route), but ALLOWS.
 *    Run this on prod first; review logs; only then flip the flag.
 *  - AUTHZ_ENFORCE=true → enforces: missing permission returns 403.
 *    Rollback = flip env + restart (no deploy).
 *
 * Decision = role map + per-user overrides in precedence **deny > grant > rola**
 * (`resolvePermissionDecision`). Overrides are read FRESH from the DB per request
 * (not from the JWT) so a grant/deny added after a token was issued takes effect
 * without a re-login. The DB read happens only on guarded routes; the deny branch
 * is why the role grant alone can't short-circuit it. Worker-flag gates
 * (definesLaunch/definesApproval) remain separate service-level checks.
 * Registers alongside `JwtAuthGuard` on controllers carrying `@RequirePermission`.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);
  /**
   * FAIL-CLOSED U PRODUKCIJI (review Opus 5): ranije je default bio `false`, pa je
   * SVAKO okruženje bez eksplicitnog `AUTHZ_ENFORCE=true` (nov kontejner, DR restore,
   * nova mašina, zaboravljen env) tiho radilo BEZ ijedne provere permisija — sve
   * `@RequirePermission` rute su bile otvorene. Sada: u produkciji je enforce podrazumevan,
   * a shadow režim se mora TRAŽITI eksplicitno (`AUTHZ_ENFORCE=false`). Van produkcije
   * (dev/test) ostaje stari default (shadow) da lokalni rad i e2e ne traže env.
   */
  private readonly enforce =
    process.env.AUTHZ_ENFORCE === "true" ||
    (process.env.NODE_ENV === "production" &&
      process.env.AUTHZ_ENFORCE !== "false");

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      PermissionKey | undefined
    >(PERMISSION_KEY_METADATA, [context.getHandler(), context.getClass()]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<{
      user?: { userId: number; email: string; role: string };
      method: string;
      url: string;
    }>();
    const user = request.user;
    // Authentication is JwtAuthGuard's job; without an identity there is nothing to evaluate.
    if (!user) return true;

    const decision = await resolvePermissionDecision(
      this.prisma,
      user.userId,
      user.role,
      required,
      user.email,
    );
    if (decision === "allow") return true;

    const detail = `user=${user.userId} (${user.email}) role="${user.role}" permission="${required}" ${request.method} ${request.url}`;
    if (this.enforce) {
      this.logger.warn(`DENY ${detail}`);
      return false; // Nest → 403 Forbidden
    }
    this.logger.warn(
      `SHADOW would-deny ${detail} (AUTHZ_ENFORCE=false, allowing)`,
    );
    return true;
  }
}

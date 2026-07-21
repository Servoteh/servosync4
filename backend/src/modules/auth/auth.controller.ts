import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthService, RequestMeta } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { AuthUser } from "./jwt.strategy";
import { permissionsForRoles } from "../../common/authz/role-permissions";
import { applyOverrides } from "../../common/authz/effective-permission";
import { OVERRIDE_KEYS } from "../../common/authz/permissions";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15Service } from "../../common/sy15/sy15.service";

interface LoginBody {
  email?: string;
  password?: string;
}

interface SsoBody {
  token?: string;
}

interface RefreshBody {
  refreshToken?: string;
}

/** Minimalni oblik Express zahteva iz koga vadimo trag refresh tokena. */
interface RequestLike {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/** user-agent / IP iz zahteva za trag (audit) izdatog refresh tokena. */
function requestMeta(req: RequestLike): RequestMeta {
  const ua = req?.headers?.["user-agent"];
  return {
    userAgent: Array.isArray(ua) ? ua[0] : (ua ?? null),
    ipAddress: req?.ip ?? null,
  };
}

@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly sy15: Sy15Service,
  ) {}

  @Post("login")
  async login(@Body() body: LoginBody, @Req() req: RequestLike) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException("email and password are required");
    }
    return this.auth.login(body.email, body.password, requestMeta(req));
  }

  /** SSO sa ServoSync 1.0 shell-a (iframe modul „Tehnologija") — vidi AuthService.ssoLogin. */
  @Post("sso")
  async sso(@Body() body: SsoBody, @Req() req: RequestLike) {
    if (!body?.token) {
      throw new BadRequestException("token is required");
    }
    return this.auth.ssoLogin(body.token, requestMeta(req));
  }

  /**
   * Rotira refresh token: telo `{ refreshToken }` → nov par `{ accessToken, refreshToken, user }`.
   * Bez auth guarda (access JWT je verovatno istekao — to je i razlog refresh-a).
   * 400 bez tokena; 401 za nepoznat/istekao/opozvan/ponovo-upotrebljen (neutralno).
   */
  @Post("refresh")
  async refresh(@Body() body: RefreshBody, @Req() req: RequestLike) {
    // Telo je interface-tipovano pa zaobilazi global ValidationPipe — eksplicitno
    // tražimo string (ne-string truthy vrednost bi oborila crypto hash → 500).
    if (typeof body?.refreshToken !== "string" || !body.refreshToken) {
      throw new BadRequestException("refreshToken is required");
    }
    return this.auth.refresh(body.refreshToken, requestMeta(req));
  }

  /**
   * Best-effort odjava: opozove dati refresh token ako postoji. Idempotentno,
   * bez auth guarda; uvek `{ ok: true }` (nepoznat/izostavljen/nevalidan token nije greška).
   */
  @Post("logout")
  async logout(@Body() body: RefreshBody) {
    // Ne-string vrednost tretiramo kao izostavljen token (ne prosleđujemo je u hash) —
    // logout ugovor je „uvek { ok: true }", nikad 500 na proizvoljno telo.
    const token =
      typeof body?.refreshToken === "string" ? body.refreshToken : undefined;
    return this.auth.logout(token);
  }

  @UseGuards(JwtAuthGuard)
  @Get("me")
  me(@Req() req: { user: AuthUser }) {
    return this.auth.me(req.user.userId);
  }

  /**
   * Effective permission keys for the logged-in user (AUTHZ_UNIFIED §8 Faza 2).
   * Role layer (ROLE_PERMISSIONS map) + per-user `UserPermissionOverride` in the
   * documented precedence deny > grant > rola (`applyOverrides` — the bulk twin of
   * the guard's `resolvePermissionDecision`, so FE `can()` and the backend 403 can
   * never disagree). Without the override merge, allowlist keys that no role
   * carries (kadrovska.grid_edit/vacation_edit — spec §2.5) would stay invisible
   * to the FE even when granted. Overrides are read FRESH per request (not baked
   * into the JWT) — a grant lands on the next FE fetch without a re-login.
   * `enforced` tells the FE whether the backend also denies.
   * Bridge: reads the single `users.role` (JWT claim) until `user_roles` data lands.
   */
  @UseGuards(JwtAuthGuard)
  @Get("me/permissions")
  async mePermissions(@Req() req: { user: AuthUser }) {
    await this.reconcileAllowlistMirror(req.user);
    const overrides = await this.prisma.userPermissionOverride.findMany({
      where: { userId: req.user.userId },
      select: { key: true, allow: true },
    });
    return {
      role: req.user.role,
      permissions: applyOverrides(
        permissionsForRoles([req.user.role]),
        overrides,
        req.user.email, // tvrda brava: kadrovska.salary samo allowlisti
      ),
      enforced: process.env.AUTHZ_ENFORCE === "true",
    };
  }

  /**
   * Self-heal ogledala allowlist ključeva (spec kadrovska §2.5; adversarni review
   * 20.07): dual-write je best-effort a backfill ručni, pa ogledalo ume da ostane
   * bez reda (nalog kreiran POSLE dodavanja na listu — JIT/invite; pad mirror-a;
   * vanpojasna 1.0/SQL izmena allowliste) ili sa zaostalim grantom posle opoziva.
   * Živa istina se čita per-user kroz SECURITY DEFINER fns — one rade pod
   * `authenticated` BEZ table grant-a (kadr_vacation_editor_allowlist NEMA SELECT
   * za authenticated!) — i ogledalo se poravna na svakom učitavanju dozvola.
   *
   * Best-effort: pad sy15 NE obara odgovor (rola + zatečeni override i dalje važe).
   * Deny redovi (allow=false) se NE diraju ni u jednom smeru (deny > grant):
   * grant-upsert ima prazan `update` (postojeći red, i deny, ostaje), a skidanje
   * briše SAMO `allow=true` redove.
   */
  private async reconcileAllowlistMirror(user: AuthUser): Promise<void> {
    try {
      const rows = await this.sy15.withUserRls(
        user.email,
        (tx) =>
          tx.$queryRaw<{ grid: boolean; vacation: boolean }[]>`
            SELECT can_edit_kadrovska_grid() AS grid,
                   can_edit_vacation_balance() AS vacation`,
      );
      const r = rows[0];
      if (!r) return;
      const mirror: ReadonlyArray<readonly [string, boolean]> = [
        [OVERRIDE_KEYS.KADROVSKA_GRID_EDIT, r.grid === true],
        [OVERRIDE_KEYS.KADROVSKA_VACATION_EDIT, r.vacation === true],
      ];
      for (const [key, allowed] of mirror) {
        if (allowed) {
          await this.prisma.userPermissionOverride.upsert({
            where: { userId_key: { userId: user.userId, key } },
            create: { userId: user.userId, key, allow: true },
            update: {}, // postojeći red (uklj. eksplicitni deny) se NE prepisuje
          });
        } else {
          await this.prisma.userPermissionOverride.deleteMany({
            where: { userId: user.userId, key, allow: true },
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `allowlist mirror reconcile (${user.email}) failed: ${String(err)}`,
      );
    }
  }
}

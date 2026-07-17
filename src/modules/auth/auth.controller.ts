import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService, RequestMeta } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthUser } from './jwt.strategy';
import { permissionsForRoles } from '../../common/authz/role-permissions';

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
  const ua = req?.headers?.['user-agent'];
  return {
    userAgent: Array.isArray(ua) ? ua[0] : (ua ?? null),
    ipAddress: req?.ip ?? null,
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() body: LoginBody, @Req() req: RequestLike) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException('email and password are required');
    }
    return this.auth.login(body.email, body.password, requestMeta(req));
  }

  /** SSO sa ServoSync 1.0 shell-a (iframe modul „Tehnologija") — vidi AuthService.ssoLogin. */
  @Post('sso')
  async sso(@Body() body: SsoBody, @Req() req: RequestLike) {
    if (!body?.token) {
      throw new BadRequestException('token is required');
    }
    return this.auth.ssoLogin(body.token, requestMeta(req));
  }

  /**
   * Rotira refresh token: telo `{ refreshToken }` → nov par `{ accessToken, refreshToken, user }`.
   * Bez auth guarda (access JWT je verovatno istekao — to je i razlog refresh-a).
   * 400 bez tokena; 401 za nepoznat/istekao/opozvan/ponovo-upotrebljen (neutralno).
   */
  @Post('refresh')
  async refresh(@Body() body: RefreshBody, @Req() req: RequestLike) {
    // Telo je interface-tipovano pa zaobilazi global ValidationPipe — eksplicitno
    // tražimo string (ne-string truthy vrednost bi oborila crypto hash → 500).
    if (typeof body?.refreshToken !== 'string' || !body.refreshToken) {
      throw new BadRequestException('refreshToken is required');
    }
    return this.auth.refresh(body.refreshToken, requestMeta(req));
  }

  /**
   * Best-effort odjava: opozove dati refresh token ako postoji. Idempotentno,
   * bez auth guarda; uvek `{ ok: true }` (nepoznat/izostavljen/nevalidan token nije greška).
   */
  @Post('logout')
  async logout(@Body() body: RefreshBody) {
    // Ne-string vrednost tretiramo kao izostavljen token (ne prosleđujemo je u hash) —
    // logout ugovor je „uvek { ok: true }", nikad 500 na proizvoljno telo.
    const token =
      typeof body?.refreshToken === 'string' ? body.refreshToken : undefined;
    return this.auth.logout(token);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: { user: AuthUser }) {
    return this.auth.me(req.user.userId);
  }

  /**
   * Role-derived permission keys for the logged-in user (AUTHZ_UNIFIED §8 Faza 2).
   * Single source: ROLE_PERMISSIONS map — the frontend hides/shows actions from this
   * BEFORE any enforcement exists. `enforced` tells the FE whether the backend also denies.
   * Bridge: reads the single `users.role` (JWT claim) until `user_roles` data lands.
   */
  @UseGuards(JwtAuthGuard)
  @Get('me/permissions')
  mePermissions(@Req() req: { user: AuthUser }) {
    return {
      role: req.user.role,
      permissions: permissionsForRoles([req.user.role]),
      enforced: process.env.AUTHZ_ENFORCE === 'true',
    };
  }
}

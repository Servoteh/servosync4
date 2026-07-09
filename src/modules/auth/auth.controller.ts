import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthUser } from './jwt.strategy';
import { permissionsForRoles } from '../../common/authz/role-permissions';

interface LoginBody {
  email?: string;
  password?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(@Body() body: LoginBody) {
    if (!body?.email || !body?.password) {
      throw new BadRequestException('email and password are required');
    }
    return this.auth.login(body.email, body.password);
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

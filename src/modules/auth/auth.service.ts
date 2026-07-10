import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';

export interface PublicUser {
  id: number;
  email: string;
  fullName: string | null;
  role: string;
}

/** PublicUser + JWT-internal fields (never returned to the client). */
interface AuthenticatedUser extends PublicUser {
  workerId: number | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** Validate credentials; returns the user or throws 401. */
  async validate(email: string, password: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (!user || !user.active) throw new UnauthorizedException('Invalid credentials');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      workerId: user.workerId,
    };
  }

  /** Issue a signed access token for an already-validated user. */
  async login(email: string, password: string) {
    const user = await this.validate(email, password);
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      workerId: user.workerId,
    });
    // `workerId` is JWT-internal (row-scope); PublicUser stays as-is for the client.
    const { workerId: _workerId, ...publicUser } = user;
    return { accessToken, user: publicUser };
  }

  async me(userId: number): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    return { id: user.id, email: user.email, fullName: user.fullName, role: user.role };
  }

  /**
   * SSO sa ServoSync 1.0 (shell → iframe modul „Tehnologija", 10.07.2026):
   * prima 1.0/1.5 GoTrue access token (HS256, deljeni `SY15_JWT_SECRET` — oba
   * sistema žive na istom serveru), verifikuje potpis/istek, pa po EMAIL-u
   * (jedinstven u `users`) izda NAŠ standardni token — identično `login()`.
   * Autorizacija = postojanje AKTIVNOG 2.0 naloga: admin/tehnolozi/kontrolori
   * ulaze bez kucanja lozinke; ko nema nalog dobija 401 → front pada nazad
   * na običan login ekran. Rola/permisije ostaju 2.0-ove (users.role).
   */
  async ssoLogin(ssToken: string) {
    const secret = process.env.SY15_JWT_SECRET ?? '';
    if (!secret) throw new UnauthorizedException('SSO nije konfigurisan');

    let payload: { email?: string };
    try {
      payload = await this.jwt.verifyAsync(ssToken, { secret, algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Invalid SSO token');
    }
    const email = String(payload?.email ?? '').toLowerCase().trim();
    if (!email) throw new UnauthorizedException('Invalid SSO token');

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.active) throw new UnauthorizedException('Nema 2.0 naloga za ovaj email');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      workerId: user.workerId,
    });
    return {
      accessToken,
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
    };
  }
}

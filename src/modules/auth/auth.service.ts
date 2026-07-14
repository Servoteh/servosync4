import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { ROLES } from "../../common/authz/roles";
import { isReadOnlyUserId } from "../../common/authz/read-only.interceptor";

export interface PublicUser {
  id: number;
  email: string;
  fullName: string | null;
  role: string;
  /** True za test naloge iz AUTHZ_READONLY_USER_IDS — front prikazuje baner, mutacije padaju 403. */
  readOnly: boolean;
}

/** PublicUser + JWT-internal fields (never returned to the client). */
interface AuthenticatedUser extends PublicUser {
  workerId: number | null;
}

/** Claims 1.0/1.5 GoTrue access tokena koje SSO koristi. */
interface Sy15TokenPayload {
  email?: string;
  user_metadata?: {
    full_name?: unknown;
    name?: unknown;
    display_name?: unknown;
  };
}

/** Podrazumevani sy15 PostgREST kad env nije postavljen (javni gateway). */
const SY15_REST_URL_DEFAULT = "https://api.servosync.servoteh.com/rest/v1";

/**
 * Gde 2.0 čita 1.0 role: sy15 PostgREST (Bearer = isti verifikovani SSO token).
 * Čita se pri pozivu (ne na module-load) i prazan string se tretira kao neuneto
 * — inače bi `SY15_REST_URL=` iz env_file-a napravio relativan URL i oborio JIT.
 */
function sy15RestUrl(): string {
  return (process.env.SY15_REST_URL || "").trim() || SY15_REST_URL_DEFAULT;
}

/**
 * Prioritet 1.0 rola — bit-paritet sa 1.0 `effectiveRoleFromMatches`
 * (servoteh-plan-montaze `src/services/userRoles.js`). Ključevi su iz
 * zajedničkog kataloga (roles.ts / AUTHZ_UNIFIED §3), pa se 1.0 rola
 * upisuje 1:1 u `users.role`.
 */
const SY15_ROLE_PRIORITY: string[] = [
  ROLES.ADMIN,
  ROLES.LEADPM,
  ROLES.PM,
  ROLES.MENADZMENT,
  ROLES.HR,
  ROLES.POSLOVNI_ADMIN,
  ROLES.PROJEKTANT_VODJA,
  ROLES.INZENJER,
  ROLES.TIM_LIDER,
  ROLES.CNC_OPERATER,
  ROLES.MAGACIONER,
  ROLES.MONTER,
  ROLES.PROIZVODNI_RADNIK,
  ROLES.VIEWER,
];

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
    if (!user || !user.active)
      throw new UnauthorizedException("Invalid credentials");

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("Invalid credentials");

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      readOnly: isReadOnlyUserId(user.id),
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
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      readOnly: isReadOnlyUserId(user.id),
    };
  }

  /**
   * SSO sa ServoSync 1.0 (shell → iframe modul „Tehnologija", 10.07.2026):
   * prima 1.0/1.5 GoTrue access token (HS256, deljeni `SY15_JWT_SECRET` — oba
   * sistema žive na istom serveru), verifikuje potpis/istek, pa po EMAIL-u
   * (jedinstven u `users`) izda NAŠ standardni token — identično `login()`.
   * JIT provisioning (11.07.2026): ko NEMA 2.0 nalog dobija ga automatski sa
   * svojom 1.0 rolom (vidi `jitProvisionFromSy15`); postojeći nalozi zadržavaju
   * kuriranu 2.0 rolu (ne prepisuje se), deaktivirani ostaju blokirani (401).
   */
  async ssoLogin(ssToken: string) {
    const secret = process.env.SY15_JWT_SECRET ?? "";
    if (!secret) throw new UnauthorizedException("SSO nije konfigurisan");

    let payload: Sy15TokenPayload;
    try {
      payload = await this.jwt.verifyAsync(ssToken, {
        secret,
        algorithms: ["HS256"],
      });
    } catch {
      throw new UnauthorizedException("Invalid SSO token");
    }
    const email = String(payload?.email ?? "")
      .toLowerCase()
      .trim();
    if (!email) throw new UnauthorizedException("Invalid SSO token");

    let user = await this.prisma.user.findUnique({ where: { email } });
    /* Deaktiviran nalog ostaje blokiran — JIT ga ne vaskrsava. */
    if (user && !user.active)
      throw new UnauthorizedException("Nalog je deaktiviran");
    if (!user) user = await this.jitProvisionFromSy15(ssToken, email, payload);

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
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        readOnly: isReadOnlyUserId(user.id),
      },
    };
  }

  /**
   * Efektivna 1.0 rola za nosioca SSO tokena — server-side (klijentu se rola
   * NE veruje): sy15 PostgREST RPC `get_my_user_roles` (SECURITY DEFINER,
   * uparuje po `email` claim-u, vraća samo aktivne redove), pa ista lestvica
   * prioriteta kao 1.0 front. Bez ijednog reda u `user_roles` 1.0 tretira
   * korisnika kao `viewer` — i mi.
   */
  private async fetchSy15EffectiveRole(ssToken: string): Promise<string> {
    let rows: Array<{ role?: string }>;
    try {
      const res = await fetch(`${sy15RestUrl()}/rpc/get_my_user_roles`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ssToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rows = (await res.json()) as Array<{ role?: string }>;
    } catch {
      /* Fail-closed: bez pouzdane role nema auto-naloga; front pada na 2.0 login. */
      throw new UnauthorizedException("SSO: čitanje 1.0 role nije uspelo");
    }
    const have = new Set(
      (Array.isArray(rows) ? rows : []).map((r) =>
        String(r?.role ?? "")
          .toLowerCase()
          .trim(),
      ),
    );
    return SY15_ROLE_PRIORITY.find((r) => have.has(r)) ?? ROLES.VIEWER;
  }

  /**
   * JIT provisioning (11.07.2026, odluka Nenad): verifikovan 1.0 email bez 2.0
   * naloga dobija nalog automatski, sa svojom 1.0 rolom (zajednički katalog).
   * Nalog je SSO-only: lozinka = random hash (niko je ne zna); password login
   * ostaje moguć tek ako je admin kasnije resetuje.
   */
  private async jitProvisionFromSy15(
    ssToken: string,
    email: string,
    payload: Sy15TokenPayload,
  ) {
    const role = await this.fetchSy15EffectiveRole(ssToken);
    const meta = payload?.user_metadata ?? {};
    const fullName =
      [meta.full_name, meta.name, meta.display_name]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .find((v) => v.length > 0)
        ?.slice(0, 150) ?? null;
    const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
    try {
      return await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          fullName,
          role,
          active: true,
          emailVerifiedAt: new Date(),
        },
      });
    } catch (e) {
      /* P2002 = paralelan SSO poziv je upravo kreirao isti email — koristi taj red.
       * Ako je taj red u međuvremenu deaktiviran (ili obrisan), vrati isti 401
       * kao ne-trka grana (ssoLogin), a ne sirov 500 iz ponovo bačenog P2002. */
      if ((e as { code?: string })?.code === "P2002") {
        const existing = await this.prisma.user.findUnique({
          where: { email },
        });
        if (existing?.active) return existing;
        throw new UnauthorizedException("Nalog je deaktiviran");
      }
      throw e;
    }
  }
}

import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15Service } from "../../common/sy15/sy15.service";
import { Sy15AuthAdminService } from "../../common/sy15/sy15-auth-admin.service";
import { ROLES } from "../../common/authz/roles";
import { isReadOnlyUserId } from "../../common/authz/read-only.interceptor";
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  refreshTokenPruneBefore,
} from "./refresh-token.util";

export interface PublicUser {
  id: number;
  email: string;
  fullName: string | null;
  role: string;
  /** True za test naloge iz AUTHZ_READONLY_USER_IDS — front prikazuje baner, mutacije padaju 403. */
  readOnly: boolean;
  /** True kad je admin postavio prinudnu promenu lozinke — FE preusmerava na /promena-lozinke. */
  mustChangePassword: boolean;
}

/** Min. dužina nove lozinke pri self-service promeni (B2). */
const MIN_PASSWORD_LENGTH = 8;

/** Minimalni HTTP metapodaci (user-agent / IP) za trag refresh tokena. */
export interface RequestMeta {
  userAgent?: string | null;
  ipAddress?: string | null;
}

/** Access JWT + rotirajući refresh token + javni profil — vraća se iz login/sso/refresh. */
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

/** Polja korisnika potrebna za potpis JWT-a i javni profil (i legacy User i validate() red). */
interface SessionUser {
  id: number;
  email: string;
  fullName: string | null;
  role: string;
  workerId: number | null;
  mustChangePassword: boolean;
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
/**
 * Grace prozor za reuse: refresh token rotiran pre manje od ovoliko ms tretira se kao
 * benigna cross-tab trka (običan 401), ne kao krađa (revoke-all svih sesija). Dovoljno
 * za refresh round-trip + časovni skew (LAN ~50ms, tunnel ~300ms), dovoljno kratko da
 * ograniči prozor zloupotrebe ukradenog tokena. Atomski „claim" već sprečava dva živa
 * tokena; ovo samo bira odgovor na zakasneli duplikat.
 */
const REUSE_GRACE_MS = 30_000;

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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    // sy15/GoTrue su @Global provajderi (Sy15Module) — best-effort dual-write pri self-service
    // promeni lozinke (B2): jedna lozinka u obe aplikacije dok stari sistem živi.
    private readonly sy15: Sy15Service,
    private readonly authAdmin: Sy15AuthAdminService,
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
      mustChangePassword: user.mustChangePassword,
      workerId: user.workerId,
    };
  }

  /** Issue an access token + rotating refresh token for validated credentials. */
  async login(
    email: string,
    password: string,
    req?: RequestMeta,
  ): Promise<AuthSession> {
    const user = await this.validate(email, password);
    return this.issueSession(user, req);
  }

  /** Signed access JWT (postojeći claims/potpis) za već-validiranog korisnika. */
  private signAccessToken(user: SessionUser): Promise<string> {
    return this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      // `workerId` is JWT-internal (row-scope); nikad se ne vraća u PublicUser.
      workerId: user.workerId,
    });
  }

  /** Javni profil koji ide klijentu (bez workerId-a). */
  private toPublicUser(user: SessionUser): PublicUser {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      readOnly: isReadOnlyUserId(user.id),
      mustChangePassword: user.mustChangePassword,
    };
  }

  /** Access JWT + nov refresh token + javni profil (zajednička grana login/sso/refresh). */
  private async issueSession(
    user: SessionUser,
    req?: RequestMeta,
  ): Promise<AuthSession> {
    const accessToken = await this.signAccessToken(user);
    const refreshToken = await this.issueRefreshToken(user.id, req);
    return { accessToken, refreshToken, user: this.toPublicUser(user) };
  }

  /**
   * Kreira nov refresh token red i vraća SIROV token (jedini put kada je vidljiv).
   * U bazu ide samo SHA-256 hash; expiresAt = now + REFRESH_TOKEN_TTL_DAYS (default 30).
   */
  async issueRefreshToken(userId: number, req?: RequestMeta): Promise<string> {
    const rawToken = generateRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashRefreshToken(rawToken),
        expiresAt: refreshTokenExpiry(),
        userAgent: req?.userAgent?.slice(0, 500) ?? null,
        ipAddress: req?.ipAddress?.slice(0, 45) ?? null,
      },
    });
    /* Higijena i na login/sso putanji: klijenti koji SAMO logiraju (npr. pdm-bridge
     * server-skripta) nikad ne pozovu refresh(), pa bi im istekli redovi rasli bez
     * granice. Fire-and-forget da čišćenje NIKAD ne obori prijavu. */
    void this.pruneExpiredForUser(userId).catch(() => undefined);
    return rawToken;
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
      mustChangePassword: user.mustChangePassword,
    };
  }

  /**
   * Self-service promena lozinke (B2) — radi i za `mustChangePassword` naloge (isti JWT guard kao
   * /me). Verifikuje trenutnu lozinku (401 ako ne valja), upisuje nov bcrypt hash i skida
   * `mustChangePassword`. `newPassword === currentPassword` je NAMERNO dozvoljeno: bezbedna živa
   * provera lozinke bez menjanja stanja (korisnik samo potvrdi da zna svoju lozinku).
   *
   * Best-effort sinhronizacija u stari sistem (invarijanta „jedna lozinka u obe aplikacije dok
   * sy15 živi"): GoTrue reset na ISTU lozinku (service key) + `user_roles.must_change_password=false`.
   * Ako sy15 padne, lokalna promena OSTAJE i vraćamo `sy15Synced:false` (kao `trySy15` u podešavanjima).
   */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: true; sy15Synced: boolean }> {
    if (
      typeof newPassword !== "string" ||
      newPassword.length < MIN_PASSWORD_LENGTH
    ) {
      throw new BadRequestException(
        `Nova lozinka mora imati najmanje ${MIN_PASSWORD_LENGTH} karaktera`,
      );
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active) throw new UnauthorizedException();

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    // Namerno: nova === trenutna je dozvoljeno (nema posebne provere jednakosti).
    if (!ok) throw new UnauthorizedException("Trenutna lozinka nije ispravna");

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });

    const sy15Synced = await this.syncPasswordToSy15(user.email, newPassword);
    return { changed: true, sy15Synced };
  }

  /**
   * Best-effort upis iste lozinke i must_change=false u stari sistem (GoTrue + sy15 `user_roles`).
   * GoTrue: service key (privilegovano). `user_roles`: `withUser` (BYPASSRLS konekciona rola)
   * SCOPE-ovan na verifikovani email korisnika — `authenticated` nema direktan UPDATE grant na
   * `user_roles` (1.0 koristi SECURITY DEFINER RPC `clear_my_must_change_password`), pa bi
   * `withUserRls` UPDATE pao na 42501. Svaki pad → warn + `false` (lokalna promena je već primenjena).
   */
  private async syncPasswordToSy15(
    email: string,
    newPassword: string,
  ): Promise<boolean> {
    try {
      const authUserId = await this.authAdmin.findUserIdByEmail(email);
      if (authUserId)
        await this.authAdmin.resetPassword(authUserId, newPassword);
      await this.sy15.withUser(
        email,
        (tx) =>
          tx.$executeRaw`UPDATE user_roles SET must_change_password = false, updated_at = now() WHERE lower(email) = lower(${email})`,
      );
      return true;
    } catch (e) {
      this.logger.warn(
        `change-password sy15 sync nije uspeo (lokalna promena primenjena): ${String(e)}`,
      );
      return false;
    }
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
  async ssoLogin(ssToken: string, req?: RequestMeta): Promise<AuthSession> {
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
    if (!user) {
      user = await this.jitProvisionFromSy15(ssToken, email, payload);
    } else {
      /* ROLA-SYNC (odluka vlasnika 21.07): postojeći nalog na SVAKOM SSO login-u
       * poravna `users.role` sa ŽIVOM 1.0 rolom (get_my_user_roles), da svako u
       * 3.0 ima tačno svoja 1.0 prava — a ne rolu zamrznutu pri prvom login-u.
       * ⚠️ Ručne 2.0 izmene role se time GUBE (svesno; 1.0 = izvor istine).
       * Fail-safe: pad čitanja 1.0 role NE obara login (zadrži zatečenu rolu).
       * Zarade su nezavisno zaključane (salaryEmailAllowed) — rola-sync ih ne otvara. */
      user = await this.syncRoleFromSy15(ssToken, user);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.issueSession(user, req);
  }

  /**
   * Poravna `users.role` postojećeg naloga sa živom 1.0 rolom. Ako se rola nije
   * promenila ILI čitanje 1.0 role padne → vraća nalog netaknut (login ne pada).
   */
  private async syncRoleFromSy15<
    T extends { id: number; email: string; role: string },
  >(ssToken: string, user: T): Promise<T> {
    let liveRole: string;
    try {
      liveRole = await this.fetchSy15EffectiveRole(ssToken);
    } catch {
      /* Pad čitanja 1.0 role NE obara login — zadrži zatečenu rolu. */
      return user;
    }
    if (liveRole === user.role) return user;
    this.logger.log(`SSO rola-sync: ${user.email} ${user.role} → ${liveRole}`);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { role: liveRole },
    });
    return updated as unknown as T;
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

  /**
   * Rotacija refresh tokena (BACKEND_RULES §7):
   *  - nepoznat / istekao / neaktivan korisnik → 401 (neutralno).
   *  - REUSE (već opozvan/zamenjen token): ako je zamenjen SKORO (< grace) → benigna
   *    cross-tab trka → običan 401 BEZ revoke-all; inače → signal krađe → opozovi SVE
   *    aktivne tokene korisnika, pa 401.
   *  - inače: ATOMSKI „claim" starog reda + nov par u transakciji + nov access JWT;
   *    vraća { accessToken, refreshToken, user } identično login()-u.
   * Poruke su namerno neutralne (bez detalja koji token je u kom stanju).
   */
  async refresh(rawToken: string, req?: RequestMeta): Promise<AuthSession> {
    if (!rawToken) throw new UnauthorizedException("Invalid refresh token");
    const tokenHash = hashRefreshToken(rawToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!existing) throw new UnauthorizedException("Invalid refresh token");

    /* Reuse: token je već opozvan ili zamenjen. Dva taba dele (particionisani)
     * localStorage i oba refresh-uju ISTI token na 24h granici — pobednik rotira,
     * gubitnik stigne malo kasnije i vidi opozvan token. Ako je rotiran SKORO
     * (< grace) → benigna trka: običan 401 BEZ revoke-all (da se sveže rotirani par
     * pobednika ne uništi). Stariji reuse = pravi signal krađe → opozovi sve. */
    if (existing.revokedAt !== null || existing.replacedByTokenId !== null) {
      const rotatedRecently =
        existing.revokedAt !== null &&
        Date.now() - existing.revokedAt.getTime() < REUSE_GRACE_MS;
      if (!rotatedRecently) {
        await this.revokeAllForUser(existing.userId);
      }
      throw new UnauthorizedException("Invalid refresh token");
    }

    if (existing.expiresAt.getTime() < Date.now())
      throw new UnauthorizedException("Invalid refresh token");

    const user = await this.prisma.user.findUnique({
      where: { id: existing.userId },
    });
    if (!user || !user.active) {
      /* Opozovi ovaj red da se ne može ponovo pokušati; nalog ostaje blokiran. */
      await this.prisma.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException("Invalid refresh token");
    }

    /* Jeftina higijena bez crona: obriši davno istekle redove ovog korisnika. */
    await this.pruneExpiredForUser(existing.userId);

    /* Access JWT i nov par se prave PRE transakcije: potpis je jedini fallibilan korak
     * van commit-a, pa ako padne stari token ostaje netaknut (nema opozvanog-ali-
     * neisporučenog tokena koji bi na retry-ju okinuo reuse detekciju). */
    const rawNew = generateRefreshToken();
    const now = new Date();
    const accessToken = await this.signAccessToken(user);

    /* Atomski „claim": stari red opozovi SAMO ako je još aktivan (guard u WHERE-u).
     * Dva paralelna refresh-a istim tokenom → tačno jedan dobije count=1 (Postgres
     * pod Read Committed re-evaluira WHERE posle reda-lock-a); gubitnik dobije 0 =
     * izgubljena trka (NE krađa, pa BEZ revoke-all). Novi red se kreira tek posle
     * uspešnog claim-a → nema token-siročeta na izgubljenoj trci. */
    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null, replacedByTokenId: null },
        data: { revokedAt: now },
      });
      if (claimed.count !== 1) return false;
      const created = await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashRefreshToken(rawNew),
          expiresAt: refreshTokenExpiry(now),
          userAgent: req?.userAgent?.slice(0, 500) ?? null,
          ipAddress: req?.ipAddress?.slice(0, 45) ?? null,
        },
      });
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { replacedByTokenId: created.id },
      });
      return true;
    });

    if (!rotated) throw new UnauthorizedException("Invalid refresh token");

    return { accessToken, refreshToken: rawNew, user: this.toPublicUser(user) };
  }

  /**
   * Best-effort odjava: ako je token dat i još aktivan → revokedAt=now.
   * Uvek `{ ok: true }` (idempotentno, bez auth guarda — nepoznat token NIJE greška).
   */
  async logout(rawToken?: string): Promise<{ ok: true }> {
    if (rawToken) {
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { ok: true };
  }

  /** Opozovi sve još-aktivne refresh tokene korisnika (odgovor na reuse/krađu). */
  private async revokeAllForUser(userId: number): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Obriši davno istekle (>60 dana) redove korisnika — držanje tabele malom. */
  private async pruneExpiredForUser(userId: number): Promise<void> {
    await this.prisma.refreshToken.deleteMany({
      where: { userId, expiresAt: { lt: refreshTokenPruneBefore() } },
    });
  }
}

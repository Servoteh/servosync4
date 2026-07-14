import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import * as bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15AuthAdminService } from "../../common/sy15/sy15-auth-admin.service";
import { isKnownRole } from "../../common/authz/roles";
import { D2_OVERRIDE_MAP } from "../../common/authz/permissions";
import type {
  DeleteUserDto,
  InviteUserDto,
  ResetPasswordDto,
  SetMustChangePasswordDto,
  UpdateUserDto,
} from "./dto/podesavanja-write.dto";

/** Rezultat sy15 propagacije (delimičan pad = master ostaje, admin ponovi). */
interface Sy15Sync {
  sy15Synced: boolean;
  sy15Error?: string;
}

/**
 * D1 — dvostrano upravljanje nalozima (2.0-master dual-write). Piše u 3 sistema:
 *   A) sy15 GoTrue (auth.users) — `Sy15AuthAdminService` (service key)
 *   B) sy15 `user_roles` — `Sy15Service.withUserRls(adminEmail)` (RLS admin + audit actor, §P10)
 *   C) 2.0 `users`/`user_roles`/`user_permission_overrides` — `PrismaService.$transaction` (atomarno)
 *
 * Redosled/kompenzacija/invarijant: docs/design/D1_DUAL_ACCOUNT_WRITE.md. Ključno: roll-forward
 * (NE rollback — hard-delete GoTrue je zabranjen), a za edit/deactivate 2.0 je master i piše se PRVI
 * (zatvara JIT-vaskrsenje deaktiviranog naloga). Self-lockout je odbijen (dokumentovana §C provera).
 */
@Injectable()
export class PodesavanjaUsersService {
  private readonly logger = new Logger(PodesavanjaUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sy15: Sy15Service,
    private readonly authAdmin: Sy15AuthAdminService,
  ) {}

  // ==================== INVITE (nov nalog) ====================

  /**
   * Nov nalog: GoTrue create (A, idempotentno) → 2.0 upsert (C) → sy15 user_roles insert (B) →
   * welcome mejl (D, best-effort). Prirodni ključevi (email/userId+role) čine ceo tok idempotentnim:
   * ponovljen invite KONVERGIRA, ne duplira. must_change_password=true (paritet 1.0 edge).
   */
  async invite(adminEmail: string, dto: InviteUserDto) {
    const email = this.normEmail(dto.email);
    const role = this.requireKnownRole(dto.role);
    const password = dto.password?.trim() || this.authAdmin.randomPassword();

    // (A) GoTrue — identitet-sidro; 503 ako nije konfigurisan (bez 1.0 login-a nema bezbednog naloga).
    const auth = await this.authAdmin.createUser({
      email,
      password,
      fullName: dto.fullName,
    });

    // (C) 2.0 master upsert (atomarno). invite = stvarna dodela role → applyRole postavljen.
    const twoZeroUserId = await this.write2_0(email, {
      applyRole: role,
      fullName: dto.fullName,
      active: true,
      mustChangePassword: true,
      managedSubDepartmentIds: dto.managedSubDepartmentIds ?? [],
      resetGlobalRole: true,
      overrides: this.overridesFromDto(dto, true),
      createDefaults: { role, active: true, mustChangePassword: true },
    });

    // (B) sy15 user_roles insert (idempotentno: NOT EXISTS po email+role+project).
    const sy15 = await this.trySy15(async () =>
      this.sy15.withUserRls(adminEmail, (tx) =>
        this.insertSy15Role(tx, adminEmail, email, role, dto),
      ),
    );

    // (D) welcome mejl (best-effort).
    await this.authAdmin.queueWelcomeEmail(email, dto.fullName ?? "", false);

    return {
      data: {
        email,
        role,
        authUserId: auth.id,
        authCreated: auth.created,
        twoZeroUserId,
        ...sy15,
      },
    };
  }

  // ==================== EDIT (postojeći) ====================

  /** Izmena: 2.0 master tx (C) pa sy15 propagacija (B). Self-lockout odbijen (422). */
  async update(adminEmail: string, sy15RoleId: string, dto: UpdateUserDto) {
    const row = await this.resolveSy15Row(adminEmail, sy15RoleId);
    const newRole =
      dto.role !== undefined ? this.requireKnownRole(dto.role) : row.role;

    this.guardSelfLockout(adminEmail, row.email, {
      deactivate: dto.isActive === false,
      dropAdmin: row.role === "admin" && newRole !== "admin",
    });

    const roleOrScopeChanged =
      dto.role !== undefined || dto.managedSubDepartmentIds !== undefined;

    // (C) master. applyRole SAMO kad admin stvarno menja rolu (scope-only edit ne dira users.role;
    // global UserRole se tada preslika iz postojeće kurirane user.role, ne iz sy15 role).
    await this.write2_0(row.email, {
      applyRole: dto.role !== undefined ? newRole : undefined,
      fullName: dto.fullName,
      active: dto.isActive,
      mustChangePassword: dto.mustChangePassword,
      managedSubDepartmentIds: dto.managedSubDepartmentIds ?? undefined,
      resetGlobalRole: roleOrScopeChanged,
      overrides: this.overridesFromDto(dto, false),
      createDefaults: {
        role: newRole,
        active: dto.isActive ?? true,
        mustChangePassword: dto.mustChangePassword ?? false,
      },
    });

    // (B) propagacija
    const sy15 = await this.trySy15(async () =>
      this.sy15.withUserRls(adminEmail, (tx) =>
        this.updateSy15Role(tx, sy15RoleId, newRole, dto),
      ),
    );

    return { data: { email: row.email, role: newRole, ...sy15 } };
  }

  // ==================== RESET LOZINKE ====================

  /** GoTrue reset (A) → must_change flag u oba sveta (B+C) → reset mejl (D). */
  async resetPassword(
    adminEmail: string,
    sy15RoleId: string,
    dto: ResetPasswordDto,
  ) {
    const row = await this.resolveSy15Row(adminEmail, sy15RoleId);
    const authUserId = await this.authAdmin.findUserIdByEmail(row.email);
    if (!authUserId) {
      throw new NotFoundException(
        `GoTrue nalog ne postoji za ${row.email} (reset nije moguć).`,
      );
    }
    const newPassword = dto.password?.trim() || this.authAdmin.randomPassword();
    await this.authAdmin.resetPassword(authUserId, newPassword); // (A) stvarna akcija

    // (C) flag na 2.0 users — SAMO must_change (bez applyRole: kurirana 2.0 rola se NE dira; 1.0
    // paritet — reset menja samo must_change_password). createDefaults.role tek za INSERT novog reda.
    await this.write2_0(row.email, {
      mustChangePassword: true,
      createDefaults: {
        role: row.role,
        active: true,
        mustChangePassword: true,
      },
    });
    // (B) flag na sy15 user_roles
    const sy15 = await this.trySy15(async () =>
      this.sy15.withUserRls(adminEmail, (tx) =>
        tx.$executeRaw(
          Prisma.sql`UPDATE user_roles SET must_change_password = true, updated_at = now() WHERE id = ${sy15RoleId}::uuid`,
        ),
      ),
    );
    await this.authAdmin.queueWelcomeEmail(row.email, "", true); // (D)

    return { data: { email: row.email, reset: true, ...sy15 } };
  }

  // ==================== DEACTIVATE / ACTIVATE (soft) ====================

  async deactivate(adminEmail: string, sy15RoleId: string) {
    const row = await this.resolveSy15Row(adminEmail, sy15RoleId);
    this.guardSelfLockout(adminEmail, row.email, { deactivate: true });
    return this.setActive(adminEmail, sy15RoleId, row.email, row.role, false);
  }

  async activate(adminEmail: string, sy15RoleId: string) {
    const row = await this.resolveSy15Row(adminEmail, sy15RoleId);
    return this.setActive(adminEmail, sy15RoleId, row.email, row.role, true);
  }

  /**
   * SOFT delete uz eksplicitnu email-potvrdu — NE hard delete (docs/design/D1 §3). Interno =
   * deactivate (reverzibilno; zatvara JIT rupu). Hard-remove `user_roles` reda = TODO (odloženo gate-om).
   */
  async softDelete(adminEmail: string, sy15RoleId: string, dto: DeleteUserDto) {
    const row = await this.resolveSy15Row(adminEmail, sy15RoleId);
    if (this.normEmail(dto.confirmEmail) !== row.email) {
      throw new UnprocessableEntityException(
        "Potvrda email-a se ne poklapa sa nalogom (brisanje odbijeno).",
      );
    }
    this.guardSelfLockout(adminEmail, row.email, { deactivate: true });
    const res = await this.setActive(
      adminEmail,
      sy15RoleId,
      row.email,
      row.role,
      false,
    );
    return { data: { ...res.data, deleted: "soft" } };
  }

  // ==================== must_change_password (D3) ====================

  async setMustChangePassword(
    adminEmail: string,
    sy15RoleId: string,
    dto: SetMustChangePasswordDto,
  ) {
    const row = await this.resolveSy15Row(adminEmail, sy15RoleId);
    // Flag-only: NE dira rolu (bez applyRole). createDefaults.role tek za INSERT novog 2.0 reda.
    await this.write2_0(row.email, {
      mustChangePassword: dto.value,
      createDefaults: {
        role: row.role,
        active: true,
        mustChangePassword: dto.value,
      },
    });
    const sy15 = await this.trySy15(async () =>
      this.sy15.withUserRls(adminEmail, (tx) =>
        tx.$executeRaw(
          Prisma.sql`UPDATE user_roles SET must_change_password = ${dto.value}, updated_at = now() WHERE id = ${sy15RoleId}::uuid`,
        ),
      ),
    );
    return {
      data: { email: row.email, mustChangePassword: dto.value, ...sy15 },
    };
  }

  // ==================== interno ====================

  /** deactivate/activate zajedničko telo: 2.0 master (upsert active) pa sy15 is_active. */
  private async setActive(
    adminEmail: string,
    sy15RoleId: string,
    email: string,
    role: string,
    active: boolean,
  ) {
    // (C) master — upsert (create ako 2.0 red fali) da JIT-ova `!user.active` grana blokira.
    // Flag-only (active): NE dira rolu (bez applyRole). createDefaults.role tek za INSERT novog reda.
    await this.write2_0(email, {
      active,
      createDefaults: { role, active, mustChangePassword: false },
    });
    // (B)
    const sy15 = await this.trySy15(async () =>
      this.sy15.withUserRls(adminEmail, (tx) =>
        tx.$executeRaw(
          Prisma.sql`UPDATE user_roles SET is_active = ${active}, updated_at = now() WHERE id = ${sy15RoleId}::uuid`,
        ),
      ),
    );
    return { data: { email, active, ...sy15 } };
  }

  /**
   * 2.0 master zapis (atomarno): upsert `users` (create sa SSO-only random hash ako fali) + opciono
   * reset global `UserRole` + override upsert/delete. Vraća 2.0 userId.
   *
   * ROLE-INVARIJANTA (adversarni review H1, D1 §2 RESET/DEACTIVATE): `users.role` je KURIRANA 2.0
   * rola (ssoLogin je NE prepisuje). Menja se SAMO na stvarnoj promeni role (`applyRole` postavljen
   * = PATCH sa role / invite). Flag-operacije (reset/deactivate/activate/must-change) NE prosleđuju
   * `applyRole` → kurirani red zadrži rolu (nema eskalacije ni tihog spuštanja preko sy15 role).
   * `createDefaults.role` je SAMO za INSERT granu novog 2.0 reda. Global `UserRole` uvek preslikava
   * `user.role` (post-upsert) — ne uvozi sy15 rolu.
   */
  private async write2_0(
    email: string,
    opts: {
      /** Postavi SAMO na stvarnoj promeni primarne role (PATCH role / invite); flag-ops ga NE šalju. */
      applyRole?: string;
      fullName?: string;
      active?: boolean;
      mustChangePassword?: boolean;
      managedSubDepartmentIds?: number[];
      resetGlobalRole?: boolean;
      overrides?: Array<{ key: string; allow: boolean | null }>;
      createDefaults: {
        role: string;
        active: boolean;
        mustChangePassword: boolean;
      };
    },
  ): Promise<number> {
    const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email },
        create: {
          email,
          passwordHash,
          fullName: opts.fullName ?? null,
          role: opts.createDefaults.role,
          active: opts.createDefaults.active,
          mustChangePassword: opts.createDefaults.mustChangePassword,
          emailVerifiedAt: new Date(),
        },
        update: {
          // SAMO na stvarnoj promeni role (flag-ops ne šalju applyRole → kurirana rola ostaje).
          ...(opts.applyRole !== undefined ? { role: opts.applyRole } : {}),
          ...(opts.fullName !== undefined ? { fullName: opts.fullName } : {}),
          ...(opts.active !== undefined ? { active: opts.active } : {}),
          ...(opts.mustChangePassword !== undefined
            ? { mustChangePassword: opts.mustChangePassword }
            : {}),
        },
      });

      if (opts.resetGlobalRole) {
        // Primarna (global) dodela = jedan red; rola = user.role (post-upsert = kurirana 2.0 rola,
        // NE sy15 rola). Per-projekat scope živi u sy15 (2.0 = future).
        await tx.userRole.deleteMany({
          where: { userId: user.id, scopeType: "global" },
        });
        await tx.userRole.create({
          data: {
            userId: user.id,
            role: user.role,
            scopeType: "global",
            scopeId: null,
            managedSubDepartmentIds: opts.managedSubDepartmentIds ?? [],
            isActive: true,
          },
        });
      }

      for (const o of opts.overrides ?? []) {
        if (o.allow === null) {
          await tx.userPermissionOverride.deleteMany({
            where: { userId: user.id, key: o.key },
          });
        } else {
          await tx.userPermissionOverride.upsert({
            where: { userId_key: { userId: user.id, key: o.key } },
            create: { userId: user.id, key: o.key, allow: o.allow },
            update: { allow: o.allow },
          });
        }
      }
      return user.id;
    });
  }

  /** sy15 user_roles INSERT (idempotentno: NOT EXISTS po email+role+project). Vraća {id}. */
  private async insertSy15Role(
    tx: Sy15Tx,
    adminEmail: string,
    email: string,
    role: string,
    dto: InviteUserDto,
  ): Promise<{ id: string | null }> {
    const managedSql = this.managedArraySql(dto.managedSubDepartmentIds);
    const projectId = dto.projectId ?? null;
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO user_roles
        (email, role, project_id, is_active, full_name, team, must_change_password,
         created_by, managed_sub_department_ids, plan_montaze_readonly,
         kadrovska_access, kadrovska_hide_contracts)
      SELECT ${email}, ${role}, ${projectId}::uuid, true, ${dto.fullName ?? ""},
             ${dto.team ?? ""}, true, ${adminEmail}, ${managedSql},
             ${dto.planMontazeReadonly === true}, ${dto.kadrovskaAccess === true},
             ${dto.kadrovskaHideContracts === true}
      WHERE NOT EXISTS (
        SELECT 1 FROM user_roles
        WHERE lower(email) = lower(${email}) AND role = ${role}
          AND coalesce(project_id::text, '') = coalesce(${projectId}::text, '')
      )
      RETURNING id`);
    return { id: rows[0]?.id ?? null };
  }

  /** sy15 user_roles UPDATE po id (samo prosleđena polja). */
  private async updateSy15Role(
    tx: Sy15Tx,
    sy15RoleId: string,
    newRole: string,
    dto: UpdateUserDto,
  ): Promise<number> {
    const sets: Prisma.Sql[] = [Prisma.sql`updated_at = now()`];
    if (dto.role !== undefined) sets.push(Prisma.sql`role = ${newRole}`);
    if (dto.fullName !== undefined)
      sets.push(Prisma.sql`full_name = ${dto.fullName}`);
    if (dto.team !== undefined) sets.push(Prisma.sql`team = ${dto.team}`);
    if (dto.projectId !== undefined)
      sets.push(Prisma.sql`project_id = ${dto.projectId}::uuid`);
    if (dto.managedSubDepartmentIds !== undefined)
      sets.push(
        Prisma.sql`managed_sub_department_ids = ${this.managedArraySql(dto.managedSubDepartmentIds)}`,
      );
    if (dto.isActive !== undefined)
      sets.push(Prisma.sql`is_active = ${dto.isActive}`);
    if (dto.mustChangePassword !== undefined)
      sets.push(Prisma.sql`must_change_password = ${dto.mustChangePassword}`);
    if (dto.planMontazeReadonly !== undefined)
      sets.push(Prisma.sql`plan_montaze_readonly = ${dto.planMontazeReadonly}`);
    if (dto.kadrovskaAccess !== undefined)
      sets.push(Prisma.sql`kadrovska_access = ${dto.kadrovskaAccess}`);
    if (dto.kadrovskaHideContracts !== undefined)
      sets.push(
        Prisma.sql`kadrovska_hide_contracts = ${dto.kadrovskaHideContracts}`,
      );
    return tx.$executeRaw(
      Prisma.sql`UPDATE user_roles SET ${Prisma.join(sets, ", ")} WHERE id = ${sy15RoleId}::uuid`,
    );
  }

  /** int[] → ARRAY[...]::int[] ili NULL::int[] (bezbedno, bez array-param zamki). */
  private managedArraySql(ids?: number[] | null): Prisma.Sql {
    const clean = Array.isArray(ids)
      ? ids.map(Number).filter((n) => Number.isFinite(n))
      : [];
    return clean.length
      ? Prisma.sql`ARRAY[${Prisma.join(clean)}]::int[]`
      : Prisma.sql`NULL::int[]`;
  }

  /** Učitaj sy15 user_roles red po id (scalar-only da izbegne null-array deserijalizaciju). */
  private async resolveSy15Row(
    adminEmail: string,
    sy15RoleId: string,
  ): Promise<{ email: string; role: string; isActive: boolean }> {
    return this.mapSy15Errors(async () =>
      this.sy15.withUserRls(adminEmail, async (tx) => {
        const rows = await tx.$queryRaw<
          { email: string; role: string; is_active: boolean | null }[]
        >(
          Prisma.sql`SELECT email, role, is_active FROM user_roles WHERE id = ${sy15RoleId}::uuid`,
        );
        const r = rows[0];
        if (!r)
          throw new NotFoundException(`Korisnik ${sy15RoleId} ne postoji`);
        return {
          email: this.normEmail(r.email),
          role: String(r.role || "viewer").toLowerCase(),
          isActive: r.is_active !== false,
        };
      }),
    );
  }

  /** D2 mapiranje: 1.0 bool → {key, allow|null}. `forceAll`=true (invite) šalje i false→delete. */
  private overridesFromDto(
    dto: {
      planMontazeReadonly?: boolean;
      kadrovskaAccess?: boolean;
      kadrovskaHideContracts?: boolean;
    },
    forceAll: boolean,
  ): Array<{ key: string; allow: boolean | null }> {
    const out: Array<{ key: string; allow: boolean | null }> = [];
    for (const [field, m] of Object.entries(D2_OVERRIDE_MAP)) {
      const val = (dto as Record<string, boolean | undefined>)[field];
      if (val === undefined) {
        if (!forceAll) continue; // edit: ne diraj
        out.push({ key: m.key, allow: null }); // invite: očisti (novi nalog nema override)
        continue;
      }
      out.push({ key: m.key, allow: val ? m.allowWhenSet : null });
    }
    return out;
  }

  /** Self-lockout: admin ne sme sam sebe da zaključa (dokumentovana §C bezbednosna provera). */
  private guardSelfLockout(
    adminEmail: string,
    targetEmail: string,
    what: { deactivate?: boolean; dropAdmin?: boolean },
  ): void {
    if (this.normEmail(adminEmail) !== this.normEmail(targetEmail)) return;
    if (what.deactivate)
      throw new UnprocessableEntityException(
        "Ne možeš deaktivirati/obrisati sopstveni nalog.",
      );
    if (what.dropAdmin)
      throw new UnprocessableEntityException(
        "Ne možeš sebi oduzeti admin ulogu (zaštita od samo-zaključavanja).",
      );
  }

  /** sy15 propagacija sa hvatanjem: delimičan pad = master ostaje, vrati sy15Synced:false. */
  private async trySy15(fn: () => Promise<unknown>): Promise<Sy15Sync> {
    try {
      await fn();
      return { sy15Synced: true };
    } catch (e) {
      const msg = this.sy15Message(e);
      this.logger.warn(
        `sy15 propagacija nije uspela (master primenjen): ${msg}`,
      );
      return { sy15Synced: false, sy15Error: msg };
    }
  }

  /** Za READ (resolveSy15Row) mapiraj SQLSTATE u HTTP — ali NotFound/Forbidden prolaze. */
  private async mapSy15Errors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (
        e instanceof NotFoundException ||
        e instanceof ForbiddenException ||
        e instanceof UnprocessableEntityException ||
        e instanceof ServiceUnavailableException
      ) {
        throw e;
      }
      const code = this.sqlstate(e);
      if (code === "42501") throw new ForbiddenException(this.sy15Message(e));
      throw e;
    }
  }

  private sqlstate(e: unknown): string | undefined {
    const meta = (e as { meta?: { code?: string } }).meta;
    return meta?.code ?? (e as { code?: string }).code;
  }

  private sy15Message(e: unknown): string {
    const code = this.sqlstate(e);
    if (code === "42501")
      return "sy15 nije dozvolio izmenu (admin nije sy15 admin?) — 1.0 strana nije sinhronizovana.";
    const meta = (e as { meta?: { message?: string } }).meta;
    return meta?.message ?? (e as Error).message ?? "sy15 greška";
  }

  private normEmail(v: string): string {
    return String(v || "")
      .toLowerCase()
      .trim();
  }

  private requireKnownRole(role: string): string {
    const r = String(role || "")
      .toLowerCase()
      .trim();
    if (!isKnownRole(r)) {
      throw new BadRequestException(`Nepoznata uloga: ${role}`);
    }
    return r;
  }
}

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { jsonSafe } from "../../common/sy15/json-safe";
import { pageMeta, parsePagination } from "../../common/pagination";
import { ROLE_CATALOG } from "../../common/authz/roles";
import { ROLE_PERMISSIONS } from "../../common/authz/role-permissions";
import { PERMISSIONS } from "../../common/authz/permissions";
import type {
  AuditLogQueryDto,
  ListUsersQueryDto,
} from "./dto/podesavanja-query.dto";

/**
 * Podešavanja (RBAC admin + matični + sistem) — 3.0 TALAS D, R1 READ sloj
 * (MODULE_SPEC_pb_profil_podesavanja_30.md §3.3). R1 = SAMO čitanje; dvostrano upravljanje
 * nalozima (invite/edit/reset — D1), overrides data-migracija (D matrica #44) i audit dvoizvor
 * (D10) su R2. Sav DB pristup ide kroz `Sy15Service.withUserRls` (GUC + SET LOCAL ROLE
 * authenticated) → RLS paritet (user_roles ALL=current_user_is_admin(); audit SELECT=admin).
 *
 * `user_roles` (sy15, email-based) se čita kroz $queryRaw (row_to_json) — Prisma model
 * `UserRoleSy15` ima nullable niz-kolone (managed_departments/managed_sub_department_ids) koje
 * Prisma ne deserijalizuje bezbedno (NULL red bi pao). Katalog uloga (roles.ts) + živa matrica
 * (ROLE_PERMISSIONS) se serviraju iz koda (jedan izvor istine, zamena 1.0 erpRbacMatrix — §2.3.6).
 */
@Injectable()
export class PodesavanjaService {
  constructor(private readonly sy15: Sy15Service) {}

  // ---------- Korisnici i pristup (user_roles — ALL=admin) ----------

  /** Lista korisnika (sy15 user_roles; arrays kroz $queryRaw). 2.0-strana union je R2/D1. */
  listUsers(email: string, q: ListUsersQueryDto) {
    const conds: Prisma.Sql[] = [];
    if (q.role) conds.push(Prisma.sql`role = ${q.role}`);
    if (q.isActive === "true") conds.push(Prisma.sql`is_active IS TRUE`);
    if (q.isActive === "false") conds.push(Prisma.sql`is_active IS NOT TRUE`);
    if (q.q) {
      const like = `%${q.q}%`;
      conds.push(
        Prisma.sql`(email ILIKE ${like} OR coalesce(full_name, '') ILIKE ${like})`,
      );
    }
    const where = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
      : Prisma.empty;
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT id, email, role, project_id, is_active, full_name, team,
             created_at, updated_at, created_by, must_change_password, user_id,
             managed_departments, managed_sub_department_ids,
             plan_montaze_readonly, kadrovska_access, kadrovska_hide_contracts
           FROM user_roles ${where}
           ORDER BY lower(email), role`,
      );
      return { data: jsonSafe(data) };
    });
  }

  /** Jedan red user_roles po id. */
  findUser(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT id, email, role, project_id, is_active, full_name, team,
             created_at, updated_at, created_by, must_change_password, user_id,
             managed_departments, managed_sub_department_ids,
             plan_montaze_readonly, kadrovska_access, kadrovska_hide_contracts
           FROM user_roles WHERE id = ${id}::uuid`,
      );
      if (!rows.length)
        throw new NotFoundException(`Korisnik ${id} ne postoji`);
      return { data: jsonSafe(rows[0]) };
    });
  }

  /** Katalog uloga (roles.ts) — statika, jedan izvor istine (bez erpRbacMatrix). */
  rolesCatalog() {
    return { data: ROLE_CATALOG };
  }

  /**
   * Živa matrica uloga×permisija (ROLE_PERMISSIONS + katalog permisija) — zamena
   * 1.0 statičke erpRbacMatrix (§2.3.6/D8). Statika, ne dira bazu.
   */
  permissionsMatrix() {
    const permissions = Object.values(PERMISSIONS);
    const roles = ROLE_CATALOG.map((r) => ({
      role: r.key,
      label: r.label,
      tier: r.tier,
      permissions: [
        ...(ROLE_PERMISSIONS[r.key as keyof typeof ROLE_PERMISSIONS] ?? []),
      ],
    }));
    return { data: { permissions, roles } };
  }

  /** Grid urednici (kadr_grid_editor_allowlist). */
  gridEditors(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.kadrGridEditorAllowlist.findMany({
        orderBy: [{ email: "asc" }],
      });
      return { data };
    });
  }

  // ---------- Organizacija (matični — struktura) ----------

  /** Struktura: odeljenja + pododeljenja + pozicije (SELECT `true` svima). */
  orgStructure(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const [departments, subDepartments, jobPositions] = await Promise.all([
        tx.department.findMany({
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        }),
        tx.subDepartment.findMany({
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        }),
        tx.jobPosition.findMany({
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        }),
      ]);
      return { data: { departments, subDepartments, jobPositions } };
    });
  }

  /** Praznici (kadr_holidays; read svi, write admin). */
  holidays(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.kadrHoliday.findMany({
        orderBy: [{ holidayDate: "asc" }],
      });
      return { data };
    });
  }

  // ---------- Organizacija (org_profile domen) ----------

  /** Vrednosti firme (company_profile id=1). */
  companyProfile(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.companyProfile.findUnique({ where: { id: 1 } });
      return { data };
    });
  }

  /** Očekivanja zaposlenih (svi; v_employee_expectations je G-view, ovde tabela). */
  expectations(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.employeeExpectation.findMany({
        orderBy: [{ createdAt: "desc" }],
      });
      return { data };
    });
  }

  /** Okvir kompetencija (grupe/kompetence/nivoi/profili/pitanja/veze). */
  competenceFramework(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const [
        groups,
        competences,
        levels,
        profiles,
        questions,
        profilePositions,
      ] = await Promise.all([
        tx.competenceGroup.findMany({ orderBy: [{ sortOrder: "asc" }] }),
        tx.competence.findMany({ orderBy: [{ sortOrder: "asc" }] }),
        tx.competenceLevel.findMany({
          orderBy: [{ competenceId: "asc" }, { level: "asc" }],
        }),
        tx.competenceProfile.findMany({ orderBy: [{ sortOrder: "asc" }] }),
        tx.competenceQuestion.findMany({ orderBy: [{ sortOrder: "asc" }] }),
        tx.profilePosition.findMany(),
      ]);
      return {
        data: {
          groups,
          competences,
          levels,
          profiles,
          questions,
          profilePositions,
        },
      };
    });
  }

  // ---------- Podaci / Sistem ----------

  /** Podešavanje predmeta (list_predmet_aktivacija_admin RPC; gate=admin∪menadzment u DB). */
  predmetAktivacija(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ data: unknown }[]>(
        Prisma.sql`SELECT list_predmet_aktivacija_admin() AS data`,
      );
      return { data: jsonSafe(rows[0]?.data ?? null) };
    });
  }

  /** Audit log (v_settings_audit_log: sy15 user_roles+predmet_aktivacija trigeri; SELECT=admin). */
  auditLog(email: string, q: AuditLogQueryDto) {
    const { page, pageSize, skip, take } = parsePagination(q.page, q.pageSize);
    const where = q.tableName
      ? Prisma.sql`WHERE table_name = ${q.tableName}`
      : Prisma.empty;
    return this.withUserMapped(email, async (tx) => {
      const [data, countRows] = await Promise.all([
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM v_settings_audit_log ${where}
             ORDER BY changed_at DESC LIMIT ${take} OFFSET ${skip}`,
        ),
        tx.$queryRaw<{ n: bigint }[]>(
          Prisma.sql`SELECT count(*) AS n FROM v_settings_audit_log ${where}`,
        ),
      ]);
      const total = Number(countRows[0]?.n ?? 0);
      return { data: jsonSafe(data), meta: pageMeta(page, pageSize, total) };
    });
  }

  /** Sistem: izbor AI modela (sastanci_ai_settings singleton; montaza AI je TODO/R2). */
  aiModels(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const sastanci = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT id, model, updated_at, updated_by FROM sastanci_ai_settings WHERE id = 1`,
      );
      // TODO(R2): montaza AI settings tabela (naziv nepoznat u snapshotu) — dodati kad se potvrdi.
      return { data: { sastanci: jsonSafe(sastanci)[0] ?? null } };
    });
  }

  // ---------- interno ----------

  private async withUserMapped<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** SQLSTATE → HTTP (paritet Reversi/Sastanci §5): 42501→403, P0001/P0002/23514→422, 23505→409. */
  private rethrowSy15(e: unknown): never {
    if (
      e instanceof NotFoundException ||
      e instanceof ForbiddenException ||
      e instanceof UnprocessableEntityException ||
      e instanceof ConflictException
    ) {
      throw e;
    }
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const code = meta?.code ?? (e as { code?: string }).code;
    const message = meta?.message ?? (e as Error).message;
    if (code === "42501") throw new ForbiddenException(message);
    if (code === "P0001" || code === "P0002" || code === "23514")
      throw new UnprocessableEntityException(message);
    if (code === "23505") throw new ConflictException(message);
    if (code === "P2025") throw new ForbiddenException(message);
    throw e;
  }
}

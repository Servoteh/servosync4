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
import { MONTAZA_AI_ALLOWED_MODELS } from "../plan-montaze/montaza-ai";
import type {
  AuditLogQueryDto,
  ListUsersQueryDto,
} from "./dto/podesavanja-query.dto";
import type {
  BulkExpectationDto,
  CreateExpectationDto,
  UpdateCompanyProfileDto,
  UpdateExpectationDto,
} from "./dto/podesavanja-org.dto";
import type {
  SetPredmetAktivacijaDto,
} from "./dto/podesavanja-predmet.dto";
import { PRIORITET_MAX_CEILING } from "./dto/podesavanja-predmet.dto";
import type {
  BulkJobPositionProfileDto,
  CreateDepartmentDto,
  CreateJobPositionDto,
  CreateSubDepartmentDto,
  UpdateDepartmentDto,
  UpdateJobPositionDto,
  UpdateJobPositionProfileDto,
  UpdateSubDepartmentDto,
} from "./dto/podesavanja-org-crud.dto";
import type {
  CreateCompetenceDto,
  CreateCompetenceGroupDto,
  CreateCompetenceQuestionDto,
  UpdateCompetenceDto,
  UpdateCompetenceGroupDto,
  UpdateCompetenceQuestionDto,
} from "./dto/podesavanja-competence.dto";

/**
 * Dozvoljeni AI modeli po potrošaču (rani 400 pre RPC-a; RPC re-validira). Sastanci allowlist
 * je 1:1 sa `set_sastanci_ai_model` CHECK-om (sql/migrations/sastanci_ai_model_setting.sql) i
 * 1.0 `sastanciAi.js`; Montaža reuse-uje `MONTAZA_AI_ALLOWED_MODELS` (montaza-ai.ts).
 */
const AI_MODEL_ALLOWLIST: Record<"sastanci" | "montaza", readonly string[]> = {
  sastanci: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  montaza: MONTAZA_AI_ALLOWED_MODELS,
};

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

  /**
   * Dodaj grid urednika — provera duplikata PRE inserta (1.0 lekcija: PostgREST POST
   * upsertuje pa tiho prepiše note; ovde Prisma `create`, 23505 → 409 „već postoji").
   * email se normalizuje (trim+lower) — paritet 1.0 gridEditors.addGridEditor.
   * Row-write (admin) sprovodi RLS kroz GUC. Guard = settings.users (klasni baseline).
   */
  addGridEditor(actorEmail: string, email: string, note?: string) {
    const e = email.trim().toLowerCase();
    return this.withUserMapped(actorEmail, async (tx) => {
      // Eksplicitna provera duplikata pre create (jasnija poruka od gole 23505).
      const existing = await tx.kadrGridEditorAllowlist.findUnique({
        where: { email: e },
      });
      if (existing)
        throw new ConflictException(`Urednik ${e} već postoji na listi.`);
      const row = await tx.kadrGridEditorAllowlist.create({
        data: { email: e, note: (note ?? "").trim() },
      });
      return { data: row };
    });
  }

  /** Ukloni grid urednika po email-u (paritet 1.0 removeGridEditor; RLS DELETE=admin). */
  removeGridEditor(actorEmail: string, email: string) {
    const e = email.trim().toLowerCase();
    return this.withUserMapped(actorEmail, async (tx) => {
      const res = await tx.kadrGridEditorAllowlist.deleteMany({
        where: { email: e },
      });
      if (res.count === 0)
        throw new NotFoundException(`Urednik ${e} ne postoji na listi.`);
      return { data: { email: e, deleted: true } };
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
        Prisma.sql`SELECT public.list_predmet_aktivacija_admin() AS data`,
      );
      return { data: jsonSafe(rows[0]?.data ?? null) };
    });
  }

  /** Audit log (v_settings_audit_log: sy15 user_roles+predmet_aktivacija trigeri; SELECT=admin). */
  auditLog(email: string, q: AuditLogQueryDto) {
    const { page, pageSize, skip, take } = parsePagination(q.page, q.pageSize);
    const conds: Prisma.Sql[] = [];
    if (q.tableName) conds.push(Prisma.sql`table_name = ${q.tableName}`);
    if (q.action) conds.push(Prisma.sql`action = ${q.action}`);
    const where = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
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

  /**
   * Sistem: izbor AI modela za dva potrošača — Sastanci („Sažmi zapisnik") i Montaža
   * (strukturiranje izveštaja montera). Oba singleton (id=1); SELECT je authenticated u obe
   * tabele (paritet 1.0 systemTab prikaza trenutnog modela). Setter je odvojena PUT ruta (RPC).
   */
  aiModels(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const [sastanci, montaza] = await Promise.all([
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT id, model, updated_at, updated_by FROM sastanci_ai_settings WHERE id = 1`,
        ),
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT id, model, updated_at, updated_by FROM montaza_ai_settings WHERE id = 1`,
        ),
      ]);
      return {
        data: {
          sastanci: jsonSafe(sastanci)[0] ?? null,
          montaza: jsonSafe(montaza)[0] ?? null,
        },
      };
    });
  }

  /**
   * Postavi AI model za `sastanci` ili `montaza` kroz odgovarajući DEFINER RPC
   * (set_sastanci_ai_model / set_montaza_ai_model). RPC re-validira allowlist i admin
   * (42501→403 kroz rethrowSy15; 23514 nepoznat model→422). Allowlist se BE-strani proverava
   * rano (400 pre RPC-a) — paritet 1.0 (systemTab + oba servisa dele iste 3 modela).
   */
  setAiModel(email: string, target: "sastanci" | "montaza", model: string) {
    // Normalizuj kao RPC (lower(trim(...))) — allowlist provera ne sme da padne na
    // razmak/velika slova dok bi RPC prihvatio ("defense-in-depth" simetrija).
    const norm = model.trim().toLowerCase();
    const allow = AI_MODEL_ALLOWLIST[target];
    if (!allow.includes(norm))
      throw new UnprocessableEntityException(`Nepoznat model: ${model}`);
    const rpc =
      target === "montaza"
        ? Prisma.sql`SELECT set_montaza_ai_model(${norm}::text) AS model`
        : Prisma.sql`SELECT set_sastanci_ai_model(${norm}::text) AS model`;
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ model: string }[]>(rpc);
      return { data: { target, model: rows[0]?.model ?? model } };
    });
  }

  // ============================================================================
  // P9 — Vrednosti firme + Očekivanja admin WRITE (guard settings.org_profile;
  // RLS presuđuje row-write kroz GUC). Paritet 1.0 companyProfileTab / employeeExpectationsTab.
  // ============================================================================

  /**
   * Vrednosti firme (PATCH company_profile id=1 + updated_by). Paritet 1.0 updateCompanyProfile
   * (mission/vision/values + updated_by). RLS/gate (admin/menadzment/pm/leadpm) kroz GUC; 0 redova
   * (nema reda ∨ RLS blok) → 403 (row=1 uvek postoji, pa 0 = zabrana). Undefined polje = null (1.0).
   */
  updateCompanyProfile(email: string, dto: UpdateCompanyProfileDto) {
    return this.withUserMapped(email, async (tx) => {
      const n = await tx.$executeRaw(
        Prisma.sql`UPDATE company_profile
           SET mission_md = ${dto.missionMd ?? null},
               vision_md = ${dto.visionMd ?? null},
               values_md = ${dto.valuesMd ?? null},
               updated_by = lower(${email}),
               updated_at = now()
           WHERE id = 1`,
      );
      if (n === 0)
        throw new ForbiddenException(
          "Nemate pravo izmene vrednosti firme.",
        );
      const row = await tx.companyProfile.findUnique({ where: { id: 1 } });
      return { data: row };
    });
  }

  /** Jedno očekivanje (INSERT employee_expectations; created_by=ja). Paritet 1.0 saveExpectation. */
  createExpectation(email: string, dto: CreateExpectationDto) {
    return this.withUserMapped(email, async (tx) => {
      const row = await tx.employeeExpectation.create({
        data: {
          employeeId: dto.employeeId,
          title: dto.title.trim(),
          descriptionMd: dto.descriptionMd ?? null,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          priority: dto.priority ?? "srednja",
          status: dto.status ?? "aktivno",
          category: dto.category ?? "ostalo",
          planId: dto.planId ?? null,
          progress: clampProgress(dto.progress),
          createdBy: email,
        },
      });
      return { data: row };
    });
  }

  /**
   * Isti zadatak na više zaposlenih (createMany; paritet 1.0 bulkSaveExpectation array POST).
   * Vraća { ok, requested }. RLS/gate kroz GUC — parcijalni uspeh nije moguć (transakcija).
   */
  bulkCreateExpectations(email: string, dto: BulkExpectationDto) {
    return this.withUserMapped(email, async (tx) => {
      const ids = [...new Set(dto.employeeIds.filter(Boolean))];
      const res = await tx.employeeExpectation.createMany({
        data: ids.map((employeeId) => ({
          employeeId,
          title: dto.title.trim(),
          descriptionMd: dto.descriptionMd ?? null,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          priority: dto.priority ?? "srednja",
          status: dto.status ?? "aktivno",
          category: dto.category ?? "ostalo",
          planId: dto.planId ?? null,
          createdBy: email,
        })),
      });
      return { data: { ok: res.count, requested: ids.length } };
    });
  }

  /**
   * Izmena očekivanja (PATCH; paritet 1.0 updateExpectation — samo prosleđena polja + updated_by;
   * status='ispunjeno' bez completed_at → auto completed_at=now). RLS/gate kroz GUC; 0 redova → 404.
   */
  updateExpectation(email: string, id: string, dto: UpdateExpectationDto) {
    return this.withUserMapped(email, async (tx) => {
      const sets: Prisma.Sql[] = [Prisma.sql`updated_by = lower(${email})`];
      if (dto.title !== undefined) sets.push(Prisma.sql`title = ${dto.title}`);
      if (dto.descriptionMd !== undefined)
        sets.push(Prisma.sql`description_md = ${dto.descriptionMd ?? null}`);
      if (dto.dueDate !== undefined)
        sets.push(Prisma.sql`due_date = ${dto.dueDate ?? null}::date`);
      if (dto.priority !== undefined)
        sets.push(Prisma.sql`priority = ${dto.priority}`);
      if (dto.status !== undefined) sets.push(Prisma.sql`status = ${dto.status}`);
      if (dto.category !== undefined)
        sets.push(Prisma.sql`category = ${dto.category}`);
      if (dto.planId !== undefined)
        sets.push(Prisma.sql`plan_id = ${dto.planId ?? null}::uuid`);
      if (dto.progress !== undefined)
        sets.push(Prisma.sql`progress = ${clampProgress(dto.progress)}`);
      if (dto.completionNote !== undefined)
        sets.push(Prisma.sql`completion_note = ${dto.completionNote ?? null}`);
      // completed_at: eksplicitno dato → to; inače status='ispunjeno' → now (paritet 1.0).
      if (dto.completedAt !== undefined)
        sets.push(Prisma.sql`completed_at = ${dto.completedAt ?? null}::timestamptz`);
      else if (dto.status === "ispunjeno")
        sets.push(Prisma.sql`completed_at = now()`);
      const n = await tx.$executeRaw(
        Prisma.sql`UPDATE employee_expectations SET ${Prisma.join(sets, ", ")}
           WHERE id = ${id}::uuid`,
      );
      if (n === 0) throw new NotFoundException(`Očekivanje ${id} ne postoji`);
      const row = await tx.employeeExpectation.findUnique({ where: { id } });
      return { data: row };
    });
  }

  /** Brisanje očekivanja (admin only — 1.0 pravilo; guard na ruti dodatno sužava). RLS kroz GUC. */
  deleteExpectation(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const res = await tx.employeeExpectation.deleteMany({ where: { id } });
      if (res.count === 0)
        throw new NotFoundException(`Očekivanje ${id} ne postoji`);
      return { data: { id, deleted: true } };
    });
  }

  // ============================================================================
  // P11 — Predmet-aktivacija WRITE (guard settings.predmet_aktivacija; RPC re-validira gate u DB).
  // Paritet 1.0 predmetAktivacija.js / predmetPlanPrioritet.js. Tela RPC-ova NETAKNUTA.
  // ============================================================================

  /**
   * Postavi aktivaciju predmeta (set_predmet_aktivacija; potpis: p_item_id/p_aktivan/p_napomena/
   * p_projektovanje_montaza). napomena undefined = ne šalji (RPC default NULL = keep); '' = clear;
   * projektovanjeMontaza undefined = ne šalji (RPC default NULL = keep). Named-arg poziv da
   * neposlati param padne na DEFAULT (paritet 1.0 body-condicionalnog slanja).
   */
  async setPredmetAktivacija(
    email: string,
    itemId: number,
    dto: SetPredmetAktivacijaDto,
  ) {
    const id = Number(itemId);
    if (!Number.isFinite(id) || id <= 0)
      throw new UnprocessableEntityException("Neispravan ID predmeta.");
    return this.withUserMapped(email, async (tx) => {
      const args: Prisma.Sql[] = [
        Prisma.sql`p_item_id => ${id}::int`,
        Prisma.sql`p_aktivan => ${dto.aktivan}::boolean`,
      ];
      if (dto.napomena !== undefined)
        args.push(Prisma.sql`p_napomena => ${dto.napomena}::text`);
      if (dto.projektovanjeMontaza !== undefined)
        args.push(
          Prisma.sql`p_projektovanje_montaza => ${dto.projektovanjeMontaza}::boolean`,
        );
      await tx.$executeRaw(
        Prisma.sql`SELECT public.set_predmet_aktivacija(${Prisma.join(args, ", ")})`,
      );
      return { data: { itemId: id, aktivan: dto.aktivan } };
    });
  }

  /** ⭐ prioritet — trenutna lista + max (get_predmet_plan_prioritet_ids + _max). */
  predmetPrioritet(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const [ids, max] = await Promise.all([
        tx.$queryRaw<{ v: unknown }[]>(
          Prisma.sql`SELECT public.get_predmet_plan_prioritet_ids() AS v`,
        ),
        tx.$queryRaw<{ v: unknown }[]>(
          Prisma.sql`SELECT public.get_predmet_plan_prioritet_max() AS v`,
        ),
      ]);
      return {
        data: {
          itemIds: normalizeIds(jsonSafe(ids[0]?.v)),
          max: normalizeMax(jsonSafe(max[0]?.v)),
        },
      };
    });
  }

  /** Prethodna (poslednja različita) lista prioriteta (get_predmet_plan_prioritet_prev). */
  predmetPrioritetPrev(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ v: unknown }[]>(
        Prisma.sql`SELECT public.get_predmet_plan_prioritet_prev() AS v`,
      );
      return { data: { itemIds: normalizeIds(jsonSafe(rows[0]?.v)) } };
    });
  }

  /** Postavi redosled ⭐ prioriteta (set_predmet_plan_prioritet p_item_ids). */
  setPredmetPrioritet(email: string, itemIds: number[]) {
    const clean = normalizeIds(itemIds).slice(0, PRIORITET_MAX_CEILING);
    return this.withUserMapped(email, async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT public.set_predmet_plan_prioritet(${clean}::int[])`,
      );
      return { data: { itemIds: clean } };
    });
  }

  /** Postavi maksimum broja prioriteta (set_predmet_plan_prioritet_max p_max; 1..50). */
  setPredmetPrioritetMax(email: string, max: number) {
    const n = Math.max(
      1,
      Math.min(PRIORITET_MAX_CEILING, Math.trunc(Number(max) || 0)),
    );
    return this.withUserMapped(email, async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT public.set_predmet_plan_prioritet_max(${n}::int)`,
      );
      return { data: { max: n } };
    });
  }

  // ============================================================================
  // P8 — ORGANIZACIJA CRUD (struktura: departments/sub_departments/job_positions +
  // opisi pozicija). Paritet 1.0 orgStructure.js / orgProfile.js. Struktura CRUD guard =
  // settings.users (admin; RLS ALL=current_user_is_admin); opisi = settings.org_profile
  // (RLS jp_update_org_profile=current_user_can_manage_org_profile). RLS autoritativan.
  // Vraća camelCase (Prisma metode) — usklađeno sa postojećim GET org/structure.
  // ============================================================================

  // ---------- Departments ----------

  createDepartment(email: string, dto: CreateDepartmentDto) {
    return this.withUserMapped(email, async (tx) => {
      const row = await tx.department.create({
        data: { name: dto.name.trim(), sortOrder: dto.sortOrder ?? 0 },
      });
      return { data: row };
    });
  }

  updateDepartment(email: string, id: number, dto: UpdateDepartmentDto) {
    return this.withUserMapped(email, async (tx) => {
      const patch: { name?: string; sortOrder?: number } = {};
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
      const res = await tx.department.updateMany({ where: { id }, data: patch });
      if (res.count === 0)
        throw new NotFoundException(`Odeljenje ${id} ne postoji.`);
      const row = await tx.department.findUnique({ where: { id } });
      return { data: row };
    });
  }

  deleteDepartment(email: string, id: number) {
    return this.withUserMapped(email, async (tx) => {
      const res = await tx.department.deleteMany({ where: { id } });
      if (res.count === 0)
        throw new NotFoundException(`Odeljenje ${id} ne postoji.`);
      return { data: { id, deleted: true } };
    });
  }

  // ---------- Sub-departments ----------

  createSubDepartment(email: string, dto: CreateSubDepartmentDto) {
    return this.withUserMapped(email, async (tx) => {
      const row = await tx.subDepartment.create({
        data: {
          departmentId: dto.departmentId,
          name: dto.name.trim(),
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      return { data: row };
    });
  }

  updateSubDepartment(email: string, id: number, dto: UpdateSubDepartmentDto) {
    return this.withUserMapped(email, async (tx) => {
      const patch: {
        departmentId?: number;
        name?: string;
        sortOrder?: number;
      } = {};
      if (dto.departmentId !== undefined) patch.departmentId = dto.departmentId;
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
      const res = await tx.subDepartment.updateMany({
        where: { id },
        data: patch,
      });
      if (res.count === 0)
        throw new NotFoundException(`Pododeljenje ${id} ne postoji.`);
      const row = await tx.subDepartment.findUnique({ where: { id } });
      return { data: row };
    });
  }

  deleteSubDepartment(email: string, id: number) {
    return this.withUserMapped(email, async (tx) => {
      const res = await tx.subDepartment.deleteMany({ where: { id } });
      if (res.count === 0)
        throw new NotFoundException(`Pododeljenje ${id} ne postoji.`);
      return { data: { id, deleted: true } };
    });
  }

  // ---------- Job positions (struktura) ----------

  createJobPosition(email: string, dto: CreateJobPositionDto) {
    return this.withUserMapped(email, async (tx) => {
      const row = await tx.jobPosition.create({
        data: {
          departmentId: dto.departmentId,
          subDepartmentId: dto.subDepartmentId ?? null,
          name: dto.name.trim(),
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      return { data: row };
    });
  }

  updateJobPosition(email: string, id: number, dto: UpdateJobPositionDto) {
    return this.withUserMapped(email, async (tx) => {
      const patch: {
        departmentId?: number;
        subDepartmentId?: number | null;
        name?: string;
        sortOrder?: number;
      } = {};
      if (dto.departmentId !== undefined) patch.departmentId = dto.departmentId;
      if (dto.subDepartmentId !== undefined)
        patch.subDepartmentId = dto.subDepartmentId;
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
      const res = await tx.jobPosition.updateMany({ where: { id }, data: patch });
      if (res.count === 0)
        throw new NotFoundException(`Pozicija ${id} ne postoji.`);
      const row = await tx.jobPosition.findUnique({ where: { id } });
      return { data: row };
    });
  }

  deleteJobPosition(email: string, id: number) {
    return this.withUserMapped(email, async (tx) => {
      const res = await tx.jobPosition.deleteMany({ where: { id } });
      if (res.count === 0)
        throw new NotFoundException(`Pozicija ${id} ne postoji.`);
      return { data: { id, deleted: true } };
    });
  }

  // ---------- Opis pozicije (org_profile domen; guard settings.org_profile) ----------

  /**
   * Opis pozicije (4 md sekcije + profile_updated_at/by). Paritet 1.0 updateJobPositionProfile:
   * body uvek šalje sva 4 sa `?? null` (nedato = obriši sekciju). RLS jp_update_org_profile
   * (current_user_can_manage_org_profile) presuđuje kroz GUC; 0 redova → 403 (RLS blok ∨ nema reda).
   */
  updateJobPositionProfile(
    email: string,
    id: number,
    dto: UpdateJobPositionProfileDto,
  ) {
    return this.withUserMapped(email, async (tx) => {
      // Provera postojanja pre update (RLS SELECT=true svima) da razdvojimo 404 od 403.
      const exists = await tx.jobPosition.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException(`Pozicija ${id} ne postoji.`);
      const res = await tx.jobPosition.updateMany({
        where: { id },
        data: {
          summaryMd: dto.summaryMd ?? null,
          expectationsMd: dto.expectationsMd ?? null,
          responsibilitiesMd: dto.responsibilitiesMd ?? null,
          dutiesMd: dto.dutiesMd ?? null,
          profileUpdatedAt: new Date(),
          profileUpdatedBy: email.toLowerCase(),
        },
      });
      if (res.count === 0)
        throw new ForbiddenException("Nemate pravo izmene opisa pozicije.");
      const row = await tx.jobPosition.findUnique({ where: { id } });
      return { data: row };
    });
  }

  /**
   * Bulk import opisa pozicija — sekvencijalni update (paritet 1.0 bulkUpdateJobPositionProfiles).
   * BE prima VEĆ isparsirane sekcije (parser je FE). Parcijalni uspeh po redu (RLS ∨ nepostojeći
   * id → fail), vraća {ok, fail, results:[{id, ok, error?}]}. Ceo zahvat pod jednim RLS tx.
   */
  bulkJobPositionProfiles(email: string, dto: BulkJobPositionProfileDto) {
    const me = email.toLowerCase();
    return this.withUserMapped(email, async (tx) => {
      const now = new Date();
      let ok = 0;
      let fail = 0;
      const results: Array<{ id: number; ok: boolean; error?: string }> = [];
      for (const it of dto.items) {
        try {
          const res = await tx.jobPosition.updateMany({
            where: { id: it.id },
            data: {
              summaryMd: it.summaryMd ?? null,
              expectationsMd: it.expectationsMd ?? null,
              responsibilitiesMd: it.responsibilitiesMd ?? null,
              dutiesMd: it.dutiesMd ?? null,
              profileUpdatedAt: now,
              profileUpdatedBy: me,
            },
          });
          if (res.count > 0) {
            ok++;
            results.push({ id: it.id, ok: true });
          } else {
            fail++;
            results.push({ id: it.id, ok: false, error: "not found" });
          }
        } catch (e) {
          fail++;
          results.push({
            id: it.id,
            ok: false,
            error: (e as Error).message ?? "greška",
          });
        }
      }
      return { data: { ok, fail, results } };
    });
  }

  // ============================================================================
  // P10 — KOMPETENCIJE EDITOR CRUD (competence_groups / competences / competence_levels /
  // competence_questions). Paritet 1.0 competenceFrameworkEditor.js. Sve admin (guard
  // settings.users; DB RLS ALL=current_user_is_admin, autoritativan → 42501→403). `code`
  // se auto-generiše (slug + sufiks, kao 1.0 _genCode). Vraća camelCase (Prisma) — usklađeno
  // sa GET /admin/competence-framework. Insert: is_active=true.
  // ============================================================================

  // ---------- Grupe (ose) ----------

  createCompetenceGroup(email: string, dto: CreateCompetenceGroupDto) {
    return this.withUserMapped(email, async (tx) => {
      const row = await tx.competenceGroup.create({
        data: {
          code: genCode("grp", dto.nameSr),
          nameSr: dto.nameSr.trim(),
          descriptionSr: dto.descriptionSr?.trim() || null,
          scope: dto.scope,
          sortOrder: dto.sortOrder ?? 100,
          isActive: true,
          updatedBy: email.toLowerCase(),
        },
      });
      return { data: row };
    });
  }

  updateCompetenceGroup(
    email: string,
    id: number,
    dto: UpdateCompetenceGroupDto,
  ) {
    return this.withUserMapped(email, async (tx) => {
      const patch: {
        nameSr?: string;
        descriptionSr?: string | null;
        scope?: string;
        sortOrder?: number;
        updatedBy: string;
      } = { updatedBy: email.toLowerCase() };
      if (dto.nameSr !== undefined) patch.nameSr = dto.nameSr.trim();
      if (dto.descriptionSr !== undefined)
        patch.descriptionSr = dto.descriptionSr?.trim() || null;
      if (dto.scope !== undefined) patch.scope = dto.scope;
      if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
      const res = await tx.competenceGroup.updateMany({
        where: { id },
        data: patch,
      });
      if (res.count === 0)
        throw new NotFoundException(`Grupa kompetencija ${id} ne postoji.`);
      const row = await tx.competenceGroup.findUnique({ where: { id } });
      return { data: row };
    });
  }

  /** Brisanje grupe (FK ka kompetencijama/pitanjima može blokirati → 23503 propagira se). */
  deleteCompetenceGroup(email: string, id: number) {
    return this.withUserMapped(email, async (tx) => {
      const res = await tx.competenceGroup.deleteMany({ where: { id } });
      if (res.count === 0)
        throw new NotFoundException(`Grupa kompetencija ${id} ne postoji.`);
      return { data: { id, deleted: true } };
    });
  }

  // ---------- Kompetencije (+ nivoi upsert/delete) ----------

  /**
   * Kreiraj kompetenciju + opciono nivoe (paritet 1.0 _editCompetenceForm create granа).
   * Nivoi: prazan descriptor se preskače pri insertu; ispunjen → upsert on_conflict.
   */
  createCompetence(email: string, dto: CreateCompetenceDto) {
    return this.withUserMapped(email, async (tx) => {
      const row = await tx.competence.create({
        data: {
          groupId: dto.groupId,
          code: genCode("cmp", dto.nameSr),
          nameSr: dto.nameSr.trim(),
          sortOrder: dto.sortOrder ?? 100,
          isActive: true,
          updatedBy: email.toLowerCase(),
        },
      });
      if (dto.levels?.length) await this.upsertLevels(tx, row.id, dto.levels);
      const levels = await tx.competenceLevel.findMany({
        where: { competenceId: row.id },
        orderBy: [{ level: "asc" }],
      });
      return { data: { ...row, levels } };
    });
  }

  /**
   * Izmena kompetencije (naziv/redosled/grupa) + nivoi upsert (prazan descriptor = DELETE nivoa —
   * paritet 1.0). 0 redova (nema reda) → 404.
   */
  updateCompetence(email: string, id: number, dto: UpdateCompetenceDto) {
    return this.withUserMapped(email, async (tx) => {
      const patch: {
        groupId?: number;
        nameSr?: string;
        sortOrder?: number;
        updatedBy: string;
      } = { updatedBy: email.toLowerCase() };
      if (dto.groupId !== undefined) patch.groupId = dto.groupId;
      if (dto.nameSr !== undefined) patch.nameSr = dto.nameSr.trim();
      if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
      const res = await tx.competence.updateMany({ where: { id }, data: patch });
      if (res.count === 0)
        throw new NotFoundException(`Kompetencija ${id} ne postoji.`);
      if (dto.levels !== undefined) await this.upsertLevels(tx, id, dto.levels);
      const row = await tx.competence.findUnique({ where: { id } });
      const levels = await tx.competenceLevel.findMany({
        where: { competenceId: id },
        orderBy: [{ level: "asc" }],
      });
      return { data: { ...row, levels } };
    });
  }

  /** Brisanje kompetencije — prvo nivoi (FK; eksplicitno kao 1.0), pa kompetencija. */
  deleteCompetence(email: string, id: number) {
    return this.withUserMapped(email, async (tx) => {
      await tx.competenceLevel.deleteMany({ where: { competenceId: id } });
      const res = await tx.competence.deleteMany({ where: { id } });
      if (res.count === 0)
        throw new NotFoundException(`Kompetencija ${id} ne postoji.`);
      return { data: { id, deleted: true } };
    });
  }

  /** Upsert/DELETE nivoa jedne kompetencije (prazan descriptorSr = brisanje tog nivoa). */
  private async upsertLevels(
    tx: Sy15Tx,
    competenceId: number,
    levels: Array<{ level: number; descriptorSr?: string }>,
  ): Promise<void> {
    for (const l of levels) {
      const desc = (l.descriptorSr ?? "").trim();
      if (desc) {
        await tx.competenceLevel.upsert({
          where: { competenceId_level: { competenceId, level: l.level } },
          create: { competenceId, level: l.level, descriptorSr: desc },
          update: { descriptorSr: desc },
        });
      } else {
        await tx.competenceLevel.deleteMany({
          where: { competenceId, level: l.level },
        });
      }
    }
  }

  // ---------- Pitanja (group_id NULL = opšte) ----------

  createCompetenceQuestion(email: string, dto: CreateCompetenceQuestionDto) {
    return this.withUserMapped(email, async (tx) => {
      const row = await tx.competenceQuestion.create({
        data: {
          groupId: dto.groupId ?? null,
          code: genCode("q", dto.textSr),
          textSr: dto.textSr.trim(),
          sortOrder: dto.sortOrder ?? 100,
          isActive: true,
        },
      });
      return { data: row };
    });
  }

  updateCompetenceQuestion(
    email: string,
    id: number,
    dto: UpdateCompetenceQuestionDto,
  ) {
    return this.withUserMapped(email, async (tx) => {
      const patch: {
        groupId?: number | null;
        textSr?: string;
        sortOrder?: number;
      } = {};
      if (dto.groupId !== undefined) patch.groupId = dto.groupId ?? null;
      if (dto.textSr !== undefined) patch.textSr = dto.textSr.trim();
      if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
      const res = await tx.competenceQuestion.updateMany({
        where: { id },
        data: patch,
      });
      if (res.count === 0)
        throw new NotFoundException(`Pitanje ${id} ne postoji.`);
      const row = await tx.competenceQuestion.findUnique({ where: { id } });
      return { data: row };
    });
  }

  deleteCompetenceQuestion(email: string, id: number) {
    return this.withUserMapped(email, async (tx) => {
      const res = await tx.competenceQuestion.deleteMany({ where: { id } });
      if (res.count === 0)
        throw new NotFoundException(`Pitanje ${id} ne postoji.`);
      return { data: { id, deleted: true } };
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
    // FK RESTRICT (brisanje odeljenja/grupe sa decom) → 409, ne 500 (paritet 1.0 soft-fail).
    if (code === "23503")
      throw new ConflictException(
        "Ne može se obrisati — postoje vezani zapisi (prvo ukloni decu).",
      );
    if (code === "P2025") throw new ForbiddenException(message);
    throw e;
  }
}

/**
 * Stabilan-ish `code` iz naziva (ASCII slug + vremenski sufiks) — paritet 1.0 _genCode.
 * Baza ima UNIQUE na `code` (groups/competences/questions); sufiks smanjuje koliziju.
 */
function genCode(prefix: string, name: string): string {
  const slug =
    String(name || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[čć]/g, "c")
      .replace(/š/g, "s")
      .replace(/ž/g, "z")
      .replace(/đ/g, "dj")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "item";
  const suffix = Date.now().toString(36).slice(-4);
  return `${prefix}_${slug}_${suffix}`;
}

/** Progress → clamp 0..100 (paritet 1.0 saveExpectation; undefined → 0). */
function clampProgress(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(Number(v))) return 0;
  return Math.max(0, Math.min(100, Math.round(Number(v))));
}

/** RPC jsonb/niz → clean pozitivni int[] (paritet 1.0 normalizeIds; cap na 50). */
function normalizeIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0)
    .slice(0, PRIORITET_MAX_CEILING);
}

/** RPC skalar → max 1..50 (paritet 1.0 pullPredmetPlanPrioritetMax; nevažeći → null). */
function normalizeMax(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, PRIORITET_MAX_CEILING);
}

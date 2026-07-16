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

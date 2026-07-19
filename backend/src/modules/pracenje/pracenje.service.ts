import {
  BadRequestException,
  Injectable,
  NotFoundException,
  NotImplementedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type {
  BlokirajAktivnostDto,
  ExportLogDto,
  OdblokirajAktivnostDto,
  PracenjeManualOverrideDto,
  PracenjeNapomenaDto,
  PracenjeParentOverrideDto,
  PromoteAkcionaTackaDto,
  SetPlanPrioritetDto,
  UpsertAktivnostDto,
  ZatvoriAktivnostDto,
} from "./dto/pracenje-mutation.dto";

/** Actor identity carried from the JWT (controller `req.user`). */
type Actor = { userId: number; email: string };

/**
 * Max steps when walking the parent chain to detect a structure-override cycle
 * (mirrors `PracenjeReadService.MAX_DEPTH`). A visited set is the real safety net;
 * this only bounds work when pre-existing data is already cyclic.
 */
const CYCLE_MAX_DEPTH = 50;

/** entityType the aktivnost-istorija audit filter reads (PracenjeReadService.aktivnostIstorija). */
const AKTIVNOST_ENTITY_TYPE = "operativna_aktivnost";

/**
 * Praćenje proizvodnje — MUTATION layer on the ORIGINAL 2.0 tables (F1, plan
 * docs/PLAN_PRACENJE_PROIZVODNJE_2026-07.md §3.2). Replaces the sy15 DEFINER/wrapper
 * RPCs (`upsert_pracenje_manual_override`, `upsert_operativna_aktivnost`, …) with
 * plain Prisma writes into the new app-owned tables:
 *   napomena        → `pracenje_notes`            (upsert by project+RN)
 *   override        → `pracenje_overrides`        (upsert by RN; auto-rule docx §4.7)
 *   parent-override → `pracenje_structure_overrides` (upsert / clear)
 *   prioritet ↑↓    → `predmet_aktivacije.sort_priority`
 *   aktivnosti      → `operativne_aktivnosti` (+ `operativne_aktivnosti_blokade`)
 *   export-log      → 2.0 `audit_log` (structured export event)
 *
 * This service is 100% sy15-free. The one lookup that must still hit sy15
 * (`akcione-tacke`, feeding the promote picker) lives in the quarantined
 * `PracenjeAkcijeSy15Service`. Permissions are enforced by the controller guard
 * (pracenje.edit / .manage / .prioritet) — no in-service scope checks.
 *
 * RN id = `work_orders.id` (Int) == the legacy `bigtehn_rn_id` the FE still sends
 * as `bigtehnRnId` (digits string) — the module's key migration fact. The legacy
 * `rnId` (1.0 uuid) is gone; any value the FE still sends is ignored.
 */
@Injectable()
export class PracenjeService {
  constructor(private readonly prisma: PrismaService) {}

  // ==========================================================================
  // Tabela praćenja — napomena / override-i (manage)
  // ==========================================================================

  /** User note per predmet (projectId) + RN (workOrderId) → `pracenje_notes` upsert. */
  async upsertNapomena(actor: Actor, projectId: number, dto: PracenjeNapomenaDto) {
    const workOrderId = Number(dto.bigtehnRnId);
    const note = String(dto.note ?? "");
    const row = await this.prisma.pracenjeNote.upsert({
      where: { projectId_workOrderId: { projectId, workOrderId } },
      create: {
        projectId,
        workOrderId,
        note,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      },
      update: { note, updatedByUserId: actor.userId },
      select: { id: true },
    });
    return { data: { id: row.id } };
  }

  /**
   * Manual override of status / machining / surface per RN → `pracenje_overrides`
   * upsert. AUTO-RULE (docx §4.7): setting `manualStatus = 'kompletirano'` forces
   * machining + surface to DA — the single source of truth lives here, NOT in the FE.
   * `null`/omitted status reverts that field to auto. `manualQty`/`reason` are the
   * "physically done but not clocked" correction (docx §4.6).
   */
  async upsertManualOverride(actor: Actor, dto: PracenjeManualOverrideDto) {
    const workOrderId = Number(dto.bigtehnRnId);
    const status = dto.status ?? null;
    const completed = status === "kompletirano";
    // Auto-rule: kompletirano ⇒ machining + surface DA (override anything the client sent).
    let machining = typeof dto.masinska === "boolean" ? dto.masinska : null;
    let surface = typeof dto.povrsinska === "boolean" ? dto.povrsinska : null;
    if (completed) {
      machining = true;
      surface = true;
    }
    // undefined = KEEP the stored value (the mobile OverrideSheet omits these fields
    // entirely — a status toggle there must not wipe a desktop-entered manual quantity);
    // explicit null = clear back to auto. Desktop sends the full state either way.
    const manualQty =
      dto.manualQty === undefined
        ? undefined
        : typeof dto.manualQty === "number"
          ? dto.manualQty
          : null;
    const reason =
      dto.reason === undefined
        ? undefined
        : dto.reason?.trim()
          ? dto.reason.trim()
          : null;

    const row = await this.prisma.pracenjeOverride.upsert({
      where: { workOrderId },
      create: {
        workOrderId,
        manualStatus: status,
        manualMachining: machining,
        manualSurface: surface,
        manualQty: manualQty ?? null,
        reason: reason ?? null,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      },
      update: {
        manualStatus: status,
        manualMachining: machining,
        manualSurface: surface,
        // Prisma skips undefined fields — that is exactly the keep semantics.
        manualQty,
        reason,
        updatedByUserId: actor.userId,
      },
      select: { id: true },
    });
    return { data: { id: row.id } };
  }

  /**
   * Manual re-parent of a position/sub-assembly → `pracenje_structure_overrides`.
   * `clear` = revert to the auto (BOM/components) structure → delete the override row.
   * Otherwise upsert with `parentWorkOrderId` (null = detach to root).
   */
  async upsertParentOverride(actor: Actor, dto: PracenjeParentOverrideDto) {
    const workOrderId = Number(dto.bigtehnRnId);

    if (dto.clear) {
      await this.prisma.pracenjeStructureOverride.deleteMany({
        where: { workOrderId },
      });
      return { data: { id: null, cleared: true } };
    }

    const parentWorkOrderId =
      dto.parentRnId != null && dto.parentRnId !== ""
        ? Number(dto.parentRnId)
        : null;
    if (parentWorkOrderId != null) {
      if (parentWorkOrderId <= 0) {
        throw new UnprocessableEntityException(
          "Roditelj mora biti postojeći RN (id > 0).",
        );
      }
      if (parentWorkOrderId === workOrderId) {
        throw new UnprocessableEntityException(
          "Pozicija ne može biti sama sebi roditelj.",
        );
      }
      // A->B->A guard: reject if `workOrderId` is already an ancestor of the new parent.
      if (await this.wouldCreateParentCycle(workOrderId, parentWorkOrderId)) {
        throw new UnprocessableEntityException(
          `Roditelj ${parentWorkOrderId} bi napravio ciklus u stablu praćenja (pozicija ${workOrderId} mu je predak).`,
        );
      }
    }

    const row = await this.prisma.pracenjeStructureOverride.upsert({
      where: { workOrderId },
      create: {
        workOrderId,
        parentWorkOrderId,
        createdByUserId: actor.userId,
        updatedByUserId: actor.userId,
      },
      update: { parentWorkOrderId, updatedByUserId: actor.userId },
      select: { id: true },
    });
    return { data: { id: row.id } };
  }

  /**
   * ↑↓ priority of an active predmet → `predmet_aktivacije.sort_priority`. Swaps the
   * predmet with its neighbour in the active list and rewrites the affected rows to a
   * dense 1..N order (so pre-existing NULL priorities normalise deterministically).
   */
  async shiftPrioritet(actor: Actor, projectId: number, direction: string) {
    if (direction !== "up" && direction !== "down") {
      throw new BadRequestException("Smer mora biti 'up' ili 'down'.");
    }
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.predmetAktivacija.findMany({
        where: { isActive: true },
        orderBy: [
          { sortPriority: { sort: "asc", nulls: "last" } },
          { projectId: "asc" },
        ],
        select: { id: true, projectId: true, sortPriority: true },
      });
      const idx = rows.findIndex((r) => r.projectId === projectId);
      if (idx === -1) {
        throw new NotFoundException(
          `Predmet ${projectId} nije u listi aktivnih predmeta.`,
        );
      }
      const swapWith = direction === "up" ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= rows.length) {
        return { data: { itemId: projectId, direction, moved: false } };
      }
      const ordered = [...rows];
      const tmp = ordered[idx];
      ordered[idx] = ordered[swapWith];
      ordered[swapWith] = tmp;

      // Rewrite only rows whose dense position actually changed.
      for (let i = 0; i < ordered.length; i++) {
        const desired = i + 1;
        if (ordered[i].sortPriority !== desired) {
          await tx.predmetAktivacija.update({
            where: { id: ordered[i].id },
            data: { sortPriority: desired, updatedByUserId: actor.userId },
          });
        }
      }
      return { data: { itemId: projectId, direction, moved: true } };
    });
  }

  /**
   * ⭐ Set the plan-priority list (spec §7-P10 / MODULE_SPEC §2.15). The whole list is
   * REPLACED in one transaction: clear `plan_priority` on every row, then write 1..N in
   * the given order over `predmet_aktivacije.plan_priority`. Guards (DTO already enforces
   * ≤50 + `@ArrayUnique` + Int≥1; kept defensively here): every `projectId` must exist in
   * `predmet_aktivacije` (→ 422). Writes ONE structured `audit_log` row (export-log shape).
   * The GET (`PracenjeReadService.planPrioritet`) is unchanged.
   */
  async setPlanPrioritet(actor: Actor, dto: SetPlanPrioritetDto) {
    const projectIds = dto.projectIds ?? [];
    // Defense-in-depth (DTO @ArrayUnique already rejects dupes → 400).
    if (new Set(projectIds).size !== projectIds.length) {
      throw new BadRequestException("Lista plan-prioriteta sadrži duplikate.");
    }
    return this.prisma.$transaction(async (tx) => {
      if (projectIds.length > 0) {
        // isActive filter: GET plan-prioritet čita samo aktivne — upis na deaktiviran
        // predmet bi bio tihi no-op (review nalaz), zato 422 i ovde.
        const existing = await tx.predmetAktivacija.findMany({
          where: { projectId: { in: projectIds }, isActive: true },
          select: { projectId: true },
        });
        const found = new Set(existing.map((r) => r.projectId));
        const missing = projectIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
          throw new UnprocessableEntityException(
            `Predmeti ne postoje u listi aktivnih (predmet_aktivacije): ${missing.join(", ")}.`,
          );
        }
      }
      // 1) Clear the whole star list (only rows that carry a priority).
      await tx.predmetAktivacija.updateMany({
        where: { planPriority: { not: null } },
        data: { planPriority: null, updatedByUserId: actor.userId },
      });
      // 2) Write 1..N in the given order (updateMany by the unique projectId — no throw).
      for (let i = 0; i < projectIds.length; i++) {
        await tx.predmetAktivacija.updateMany({
          where: { projectId: projectIds[i] },
          data: { planPriority: i + 1, updatedByUserId: actor.userId },
        });
      }
      await tx.auditLog.create({
        data: {
          actorUserId: actor.userId ?? null,
          actorUsername: actor.email ?? null,
          action: "SET plan-prioritet",
          entityType: "pracenje_plan_prioritet",
          entityId: null,
          afterData: {
            project_ids: projectIds,
            count: projectIds.length,
            set_at: new Date().toISOString(),
          },
        },
      });
      return { data: { ids: projectIds, count: projectIds.length } };
    });
  }

  // ==========================================================================
  // Operativni plan — aktivnosti (Tab2, edit)
  // ==========================================================================

  /**
   * Upsert operativna aktivnost → `operativne_aktivnosti` (create when `id` is null,
   * else update). `odeljenjeId` is a real FK; a non-existent one yields a clean 400
   * instead of a raw FK 500. Returns the (Int) activity id.
   */
  async upsertAktivnost(actor: Actor, dto: UpsertAktivnostDto) {
    const data = {
      workOrderId: dto.radniNalogId ?? null,
      projectId: dto.projekatId ?? null,
      odeljenjeId: dto.odeljenjeId,
      nazivAktivnosti: dto.nazivAktivnosti,
      planiraniPocetak: this.toDbDate(dto.planiraniPocetak),
      planiraniZavrsetak: this.toDbDate(dto.planiraniZavrsetak),
      odgovoranUserId: dto.odgovoranUserId ?? null,
      odgovoranWorkerId: dto.odgovoranRadnikId ?? null,
      odgovoranLabel: dto.odgovoranLabel ?? null,
      status: dto.status ?? "nije_krenulo",
      prioritet: dto.prioritet ?? "srednji",
      rb: Number.isFinite(Number(dto.rb)) ? Number(dto.rb) : 0,
      opis: dto.opis ?? null,
      brojTp: dto.brojTp ?? null,
      kolicinaText: dto.kolicinaText ?? null,
      zavisiOdAktivnostId: dto.zavisiOdAktivnostId ?? null,
      zavisiOdText: dto.zavisiOdText ?? null,
      statusMode: dto.statusMode ?? "manual",
      rizikNapomena: dto.rizikNapomena ?? null,
      izvor: dto.izvor ?? "rucno",
      izvorAkcioniPlanId: dto.izvorAkcioniPlanId ?? null,
      izvorPozicijaId: dto.izvorPozicijaId ?? null,
      izvorTpOperacijaId: dto.izvorTpOperacijaId ?? null,
    };

    const odeljenje = await this.prisma.odeljenje.findUnique({
      where: { id: data.odeljenjeId },
      select: { id: true },
    });
    if (!odeljenje) {
      throw new BadRequestException(
        `Odeljenje ${data.odeljenjeId} ne postoji.`,
      );
    }

    if (dto.id != null) {
      const before = await this.prisma.operativnaAktivnost.findUnique({
        where: { id: dto.id },
      });
      if (!before) throw new NotFoundException(`Aktivnost ${dto.id} ne postoji.`);
      const row = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.operativnaAktivnost.update({
          where: { id: dto.id },
          data: { ...data, updatedByUserId: actor.userId },
        });
        await tx.auditLog.create({
          data: this.aktivnostAuditData(
            actor,
            updated.id,
            "UPDATE aktivnost",
            this.aktivnostSnapshot(before),
            this.aktivnostSnapshot(updated),
          ),
        });
        return updated;
      });
      return { data: { id: row.id } };
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.operativnaAktivnost.create({
        data: {
          ...data,
          createdByUserId: actor.userId,
          updatedByUserId: actor.userId,
        },
      });
      await tx.auditLog.create({
        data: this.aktivnostAuditData(
          actor,
          created.id,
          "CREATE aktivnost",
          null,
          this.aktivnostSnapshot(created),
        ),
      });
      return created;
    });
    return { data: { id: row.id } };
  }

  /**
   * Close activity → status 'zavrseno'. Also writes the STRUCTURED audit row the
   * istorija reads (the global interceptor's URL-derived row does not match the
   * `entityType='operativna_aktivnost'` filter).
   */
  async zatvoriAktivnost(actor: Actor, id: number, dto: ZatvoriAktivnostDto) {
    const beforeStatus = await this.requireAktivnostStatus(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.operativnaAktivnost.update({
        where: { id },
        data: { status: "zavrseno", updatedByUserId: actor.userId },
      });
      await tx.auditLog.create({
        data: this.aktivnostAuditData(
          actor,
          id,
          "CLOSE aktivnost",
          { status: beforeStatus },
          { status: "zavrseno", napomena: dto.napomena?.trim() || null },
        ),
      });
    });
    return { data: { id } };
  }

  /**
   * Block activity (razlog REQUIRED → 400) → status 'blokirano' + append a blocking
   * row to `operativne_aktivnosti_blokade` (append-only history) + structured audit,
   * all in one transaction.
   */
  async blokirajAktivnost(actor: Actor, id: number, dto: BlokirajAktivnostDto) {
    const razlog = dto.razlog?.trim();
    if (!razlog) throw new BadRequestException("Razlog blokade je obavezan.");
    const beforeStatus = await this.requireAktivnostStatus(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.operativnaAktivnost.update({
        where: { id },
        data: { status: "blokirano", updatedByUserId: actor.userId },
      });
      await tx.operativnaAktivnostBlokada.create({
        data: { aktivnostId: id, razlog, blockedByUserId: actor.userId },
      });
      await tx.auditLog.create({
        data: this.aktivnostAuditData(
          actor,
          id,
          "BLOCK aktivnost",
          { status: beforeStatus },
          { status: "blokirano", razlog },
        ),
      });
    });
    return { data: { id } };
  }

  /**
   * Unblock activity → close the latest open blocking row (unblockedAt/By + note),
   * return the activity to 'nije_krenulo', and write the structured audit row. Note:
   * the pre-block status is not restored (no column for it in the append-only history)
   * — a deliberate F1 simplification.
   */
  async odblokirajAktivnost(
    actor: Actor,
    id: number,
    dto: OdblokirajAktivnostDto,
  ) {
    const beforeStatus = await this.requireAktivnostStatus(id);
    const napomena = dto.napomena?.trim() ? dto.napomena.trim() : null;
    await this.prisma.$transaction(async (tx) => {
      const open = await tx.operativnaAktivnostBlokada.findFirst({
        where: { aktivnostId: id, unblockedAt: null },
        orderBy: { blockedAt: "desc" },
        select: { id: true },
      });
      if (open) {
        await tx.operativnaAktivnostBlokada.update({
          where: { id: open.id },
          data: {
            unblockedAt: new Date(),
            unblockedByUserId: actor.userId,
            napomena,
          },
        });
      }
      await tx.operativnaAktivnost.update({
        where: { id },
        data: { status: "nije_krenulo", updatedByUserId: actor.userId },
      });
      await tx.auditLog.create({
        data: this.aktivnostAuditData(
          actor,
          id,
          "UNBLOCK aktivnost",
          { status: beforeStatus },
          { status: "nije_krenulo", napomena },
        ),
      });
    });
    return { data: { id } };
  }

  /**
   * Promote an action point (Sastanci) into an activity. NOT IMPLEMENTED (501): the
   * akcioni-plan/sastanci module still lives in sy15 and its ids are uuids, while 2.0
   * `operativne_aktivnosti` refs are Int — there is no resolvable bridge until sastanci
   * is ported to 2.0 (plan F1 note; task "vezi na 2.0 sastanci ako postoji; inače 501").
   */
  async promoteAkcionaTacka(_actor: Actor, _dto: PromoteAkcionaTackaDto) {
    throw new NotImplementedException(
      "Promocija akcione tačke u aktivnost nije podržana dok se Sastanci/akcioni-plan " +
        "ne preseli na 2.0 (sy15 uuid ↔ 2.0 Int veze nisu razrešive). TODO(pracenje).",
    );
  }

  // ==========================================================================
  // Export-log (server-side; structured export event → 2.0 audit_log)
  // ==========================================================================

  /**
   * Log a data export into 2.0 `audit_log`. The global AuditInterceptor already logs
   * the raw POST, but this writes a structured event (rn/predmet/tab) for reporting.
   */
  async logExport(actor: Actor, dto: ExportLogDto) {
    const afterData: Prisma.InputJsonValue = {
      rn_id: dto.rnId ?? null,
      rn_broj: dto.rnBroj ?? null,
      predmet_item_id: dto.predmetItemId ?? null,
      tab: dto.tab,
      exported_at: new Date().toISOString(),
      ...(dto.extra && typeof dto.extra === "object" ? dto.extra : {}),
    };
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actor.userId ?? null,
        actorUsername: actor.email ?? null,
        action: "EXPORT pracenje",
        entityType: "pracenje_export",
        entityId:
          dto.rnId ??
          (dto.predmetItemId != null ? String(dto.predmetItemId) : null),
        afterData,
      },
    });
    return { data: { logged: true } };
  }

  // ==========================================================================
  // interno
  // ==========================================================================

  /** Guard: activity must exist (clean 404) → returns current status for the audit before-state. */
  private async requireAktivnostStatus(id: number): Promise<string> {
    const row = await this.prisma.operativnaAktivnost.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!row) throw new NotFoundException(`Aktivnost ${id} ne postoji.`);
    return row.status;
  }

  /**
   * Structure-override cycle guard. Setting `child`'s parent to `newParent` closes a
   * loop iff `child` is already an ANCESTOR of `newParent`. Walk UP from `newParent`
   * following each node's EFFECTIVE parent: a structure override (single parent; null =
   * root → stop) wins over the auto BOM parents (`work_order_components`, which can
   * branch, so BFS). `visited` prevents spinning on already-cyclic data; `depth` caps work.
   */
  private async wouldCreateParentCycle(
    child: number,
    newParent: number,
  ): Promise<boolean> {
    const visited = new Set<number>();
    let frontier: number[] = [newParent];
    for (let depth = 0; depth < CYCLE_MAX_DEPTH && frontier.length > 0; depth++) {
      const next: number[] = [];
      for (const node of frontier) {
        if (node === child) return true;
        if (visited.has(node)) continue;
        visited.add(node);
        const override = await this.prisma.pracenjeStructureOverride.findUnique({
          where: { workOrderId: node },
          select: { parentWorkOrderId: true },
        });
        if (override) {
          // Override is authoritative for this node — no BOM fallback.
          if (override.parentWorkOrderId != null) {
            next.push(override.parentWorkOrderId);
          }
          continue;
        }
        const parents = await this.prisma.workOrderComponent.findMany({
          where: { componentWorkOrderId: node },
          select: { workOrderId: true },
        });
        for (const p of parents) next.push(p.workOrderId);
      }
      frontier = next;
    }
    return false;
  }

  /**
   * Structured audit row for an activity mutation → 2.0 `audit_log`. The GLOBAL
   * AuditInterceptor logs a generic row whose entityType/entityId are mis-derived from
   * the URL (`pracenje` / `aktivnosti`), so `PracenjeReadService.aktivnostIstorija`
   * (filter entityType='operativna_aktivnost', entityId=String(id)) would never match.
   * This writes the row that filter actually reads. `before`/`after` omitted when null.
   */
  private aktivnostAuditData(
    actor: Actor,
    id: number,
    action: string,
    before: Prisma.InputJsonValue | null,
    after: Prisma.InputJsonValue | null,
  ): Prisma.AuditLogUncheckedCreateInput {
    return {
      actorUserId: actor.userId ?? null,
      actorUsername: actor.email ?? null,
      action,
      entityType: AKTIVNOST_ENTITY_TYPE,
      entityId: String(id),
      ...(before !== null ? { beforeData: before } : {}),
      ...(after !== null ? { afterData: after } : {}),
    };
  }

  /** JSON-safe snapshot of an activity for the audit before/after (Dates → 'YYYY-MM-DD'). */
  private aktivnostSnapshot(row: {
    id: number;
    workOrderId: number | null;
    projectId: number | null;
    odeljenjeId: number;
    nazivAktivnosti: string;
    status: string;
    prioritet: string;
    rb: number;
    odgovoranUserId: number | null;
    odgovoranWorkerId: number | null;
    odgovoranLabel: string | null;
    planiraniPocetak: Date | null;
    planiraniZavrsetak: Date | null;
    statusMode: string;
    izvor: string;
  }): Prisma.InputJsonValue {
    return {
      id: row.id,
      work_order_id: row.workOrderId,
      project_id: row.projectId,
      odeljenje_id: row.odeljenjeId,
      naziv_aktivnosti: row.nazivAktivnosti,
      status: row.status,
      prioritet: row.prioritet,
      rb: row.rb,
      odgovoran_user_id: row.odgovoranUserId,
      odgovoran_worker_id: row.odgovoranWorkerId,
      odgovoran_label: row.odgovoranLabel,
      planirani_pocetak: this.dateOnly(row.planiraniPocetak),
      planirani_zavrsetak: this.dateOnly(row.planiraniZavrsetak),
      status_mode: row.statusMode,
      izvor: row.izvor,
    };
  }

  /** Date → 'YYYY-MM-DD' (null-safe) for JSON snapshots. */
  private dateOnly(d: Date | null): string | null {
    return d ? d.toISOString().slice(0, 10) : null;
  }

  /** 'YYYY-MM-DD' → Date for @db.Date (null = clear). */
  private toDbDate(v?: string | null): Date | null {
    if (v == null || v === "") return null;
    return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  }
}

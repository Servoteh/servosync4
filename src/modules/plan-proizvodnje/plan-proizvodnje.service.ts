import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { mapSy15Error } from "../../common/sy15-error";
import { jsonSafe } from "../../common/json-safe";
import { sanitizeDrawingNo } from "../../common/drawings";
import {
  NAMED_DEPARTMENTS,
  getDepartment,
  type DepartmentDef,
} from "./departments";
import type {
  CooperationQueryDto,
  DrawingsQueryDto,
  OperationsQueryDto,
} from "./dto/plan-proizvodnje-query.dto";
import type {
  BulkReassignDto,
  CooperationGroupPatchDto,
  CooperationGroupUpsertDto,
  OverlayReorderDto,
  OverlayUpsertDto,
  ReassignDto,
  SetUrgentDto,
} from "./dto/plan-proizvodnje-mutation.dto";

const DRAWINGS_BUCKET = "production-drawings";
const BIGTEHN_DRAWINGS_BUCKET = "bigtehn-drawings";
const SIGNED_URL_TTL = 300;

/** Dozvoljeni MIME tipovi za skice (port 1.0 drawingManager ALLOWED_MIMES). */
const ALLOWED_DRAWING_MIMES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
];

/** Kanon otvorene operacije (§2-6). Kooperacija tab invertuje `is_cooperation_effective`. */
const OPEN_OPS = Prisma.sql`is_done_in_bigtehn IS FALSE AND rn_zavrsen IS FALSE
  AND is_cooperation_effective IS FALSE AND overlay_archived_at IS NULL
  AND (local_status IS NULL OR local_status <> 'completed')`;

/** Sort kanon PP (§2-7): ručni/pin pre DB spremnosti/hitnosti. */
const OPS_SORT = Prisma.sql`ORDER BY shift_sort_order ASC NULLS LAST, auto_sort_bucket ASC,
  rok_izrade ASC NULLS LAST, prioritet_bigtehn ASC, rn_ident_broj ASC, operacija ASC`;

const ALL_OPS_LIMIT = 10000;
const DEPT_LIMIT = 5000;
const SEARCH_LIMIT = 500;
const SEARCH_MIN_LEN = 2;

/**
 * PER-POZIV tx timeout za pune skenove `v_production_operations_effective`
 * (operations/all + odeljenje bez filtera). Merena latencija ~5.3s > Prisma
 * default 5000ms → interaktivna tx puca („Transaction already closed", 500).
 * 30s daje širok bafer, ostali read-ovi zadržavaju default.
 */
const FULL_SCAN_TIMEOUT_MS = 30_000;

const PP_BRIDGE_JOBS = [
  "production_work_orders",
  "production_work_order_lines",
  "production_tech_routing",
];

/**
 * Plan proizvodnje — 3.0 TALAS C, R1 read sloj (MODULE_SPEC_planovi_pracenje_30.md §3).
 * Sva čitanja idu iz view lanca `v_production_operations_effective` (bigtehn_* keš +
 * overlay + urgency + auto-koop + spremnost + G4; predmet aktivan ∧ završna kontrola NIJE
 * kucana — filtrira sam view lanac) i public keš/bridge tabela ($queryRaw), sve kroz
 * `withUserRls`. `bigtehn_*` keš je MOST (doktrina; repoint na tech_processes = QBigTehn
 * cutover, NE ovaj talas). Mutacije (overlays/urgency/reassign/drawings) su R2.
 */
@Injectable()
export class PlanProizvodnjeService {
  constructor(
    private readonly sy15: Sy15Service,
    private readonly storage: Sy15StorageService,
  ) {}

  // ---------- Mašine ----------

  /** Mašine (bigtehn_machines_cache) — izbor mašine / odeljenja. */
  async machines(email: string) {
    return this.read(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM bigtehn_machines_cache ORDER BY rj_code ASC`,
      );
      return { data: jsonSafe(data) };
    });
  }

  // ---------- Operacije ----------

  /**
   * Red operacija: `?machine=` → RPC plan_pp_open_ops_for_machine (paginacija po RN),
   * `?dept=` → view filter po effective_machine_code (odeljenje). Bez oba → 400.
   */
  async operations(email: string, q: OperationsQueryDto) {
    if (q.machine) {
      const machine = q.machine.trim();
      const limit = clampInt(q.limit, 100, 1, 250);
      const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return this.read(email, async (tx) => {
        const rows = await tx.$queryRaw<
          { plan_pp_open_ops_for_machine: unknown }[]
        >(
          Prisma.sql`SELECT plan_pp_open_ops_for_machine(${machine}::text, ${limit}::int, ${offset}::int) AS plan_pp_open_ops_for_machine`,
        );
        return { data: rows[0]?.plan_pp_open_ops_for_machine ?? null };
      });
    }
    if (q.dept) {
      const cond = this.deptWhere(q.dept);
      return this.read(
        email,
        async (tx) => {
          const where =
            cond === Prisma.empty
              ? Prisma.sql`WHERE ${OPEN_OPS}`
              : Prisma.sql`WHERE ${OPEN_OPS} AND ${cond}`;
          const data = await tx.$queryRaw(
            Prisma.sql`SELECT * FROM v_production_operations_effective ${where} ${OPS_SORT} LIMIT ${DEPT_LIMIT}`,
          );
          return { data: jsonSafe(data) };
        },
        // Odeljenje „Sve"/„Ostalo" ne suzava po mašini → pun sken view-a.
        { timeoutMs: FULL_SCAN_TIMEOUT_MS },
      );
    }
    throw new BadRequestException("Zadaj ?machine= ili ?dept=.");
  }

  /** Sve otvorene operacije (agregatni prikazi) — min kolone, count + truncated na 10k. */
  async operationsAll(email: string) {
    return this.read(
      email,
      async (tx) => {
        const [rows, cnt] = await Promise.all([
          tx.$queryRaw(
            // Kolone za FE paritet (GAP-PM-05/06/07): kupac (name/short), G2
            // dorada/škart (is_rework/is_scrap + komadi), broj skica, bigtehn
            // crtež flag, prethodna operacija (spremnost „čeka op. NN").
            Prisma.sql`SELECT line_id, work_order_id, effective_machine_code, broj_crteza, naziv_dela,
              rn_ident_broj, tpz_min, tk_min, komada_total, komada_done, real_seconds, rok_izrade,
              is_non_machining, assigned_machine_code, local_status, opis_rada, operacija, cam_ready,
              is_ready_for_machine, is_urgent, auto_sort_bucket,
              customer_name, customer_short, drawings_count, has_bigtehn_drawing,
              is_rework, is_scrap, rework_pieces, scrap_pieces,
              previous_operation_operacija, previous_operation_status, previous_operation_machine_code
            FROM v_production_operations_effective
            WHERE ${OPEN_OPS} AND effective_machine_code IS NOT NULL
            ${OPS_SORT} LIMIT ${ALL_OPS_LIMIT}`,
          ),
          tx.$queryRaw<{ n: bigint }[]>(
            Prisma.sql`SELECT count(*) AS n FROM v_production_operations_effective
              WHERE ${OPEN_OPS} AND effective_machine_code IS NOT NULL`,
          ),
        ]);
        const total = Number(cnt[0]?.n ?? 0);
        return {
          data: jsonSafe(rows),
          meta: { total, truncated: total > ALL_OPS_LIMIT, limit: ALL_OPS_LIMIT },
        };
      },
      // Pun sken view-a bez filtera po mašini (merena latencija ~5.3s).
      { timeoutMs: FULL_SCAN_TIMEOUT_MS },
    );
  }

  /** Pretraga operacija po crtežu/RN (paritet loadOperationsByRnOrDrawingQuery). */
  async operationsSearch(email: string, q?: string) {
    const term = (q ?? "").trim();
    if (term.length < SEARCH_MIN_LEN) return { data: [] };
    const like = `%${term}%`;
    return this.read(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_production_operations_effective
          WHERE ${OPEN_OPS}
            AND (broj_crteza ILIKE ${like} OR rn_ident_broj ILIKE ${like} OR naziv_dela ILIKE ${like})
          ORDER BY effective_machine_code ASC NULLS LAST, broj_crteza ASC, rn_ident_broj ASC, operacija ASC
          LIMIT ${SEARCH_LIMIT}`,
      );
      return { data: jsonSafe(data) };
    });
  }

  // ---------- Kooperacija ----------

  /** Operacije efektivno u kooperaciji (is_cooperation_effective=true) + opciona pretraga. */
  async cooperation(email: string, q: CooperationQueryDto) {
    const term = (q.q ?? "").trim();
    const like = term ? `%${term}%` : null;
    return this.read(email, async (tx) => {
      const search = like
        ? Prisma.sql`AND (broj_crteza ILIKE ${like} OR rn_ident_broj ILIKE ${like} OR naziv_dela ILIKE ${like})`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_production_operations_effective
          WHERE is_done_in_bigtehn IS FALSE AND rn_zavrsen IS FALSE
            AND is_cooperation_effective IS TRUE AND overlay_archived_at IS NULL
            AND (local_status IS NULL OR local_status <> 'completed') ${search}
          ORDER BY rok_izrade ASC NULLS LAST, rn_ident_broj ASC, operacija ASC
          LIMIT ${DEPT_LIMIT}`,
      );
      return { data: jsonSafe(data) };
    });
  }

  /** Auto-koop grupe (production_auto_cooperation_groups) — admin CRUD je R2. */
  async cooperationGroups(email: string) {
    return this.read(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT rj_group_code, group_label, added_at, added_by, removed_at, removed_by, notes
          FROM production_auto_cooperation_groups ORDER BY rj_group_code ASC`,
      );
      return { data: jsonSafe(data) };
    });
  }

  // ---------- Reassign audit (force) ----------

  /** Audit reassign-ova (production_reassign_audit) — SELECT admin/menadzment (RLS + guard force). */
  async reassignAudit(email: string) {
    return this.read(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM production_reassign_audit ORDER BY created_at DESC LIMIT 500`,
      );
      return { data: jsonSafe(data) };
    });
  }

  // ---------- Skice / TP / bridge ----------

  /** Skice operacije (production_drawings, bez soft-obrisanih). Signed URL = R2 (storage). */
  async drawings(email: string, q: DrawingsQueryDto) {
    const wo = BigInt(q.workOrder);
    const line = BigInt(q.line);
    return this.read(email, async (tx) => {
      const rows = await tx.ppDrawing.findMany({
        where: { workOrderId: wo, lineId: line, deletedAt: null },
        orderBy: [{ uploadedAt: "asc" }],
      });
      return { data: jsonSafe(rows) };
    });
  }

  /** Ceo tehnološki postupak RN-a (TP procedura modal): operacije (bazni view) + logovi (keš). */
  async techProcedure(email: string, workOrderId: number) {
    const wo = BigInt(workOrderId);
    return this.read(email, async (tx) => {
      const [operations, logs] = await Promise.all([
        tx.$queryRaw(
          Prisma.sql`SELECT * FROM v_production_operations WHERE work_order_id = ${wo}::bigint
            ORDER BY operacija ASC LIMIT 500`,
        ),
        tx.$queryRaw(
          Prisma.sql`SELECT id, operacija, machine_code, worker_id, komada, prn_timer_seconds,
              started_at, finished_at, is_completed, napomena, potpis
            FROM bigtehn_tech_routing_cache WHERE work_order_id = ${wo}::bigint
            ORDER BY operacija ASC, started_at ASC LIMIT 2000`,
        ),
      ]);
      const ops = jsonSafe(operations) as unknown[];
      return {
        data: { operations: ops, logs: jsonSafe(logs), header: ops[0] ?? null },
      };
    });
  }

  /** Bridge sync health banner — poslednji status 3 job-а (bridge_sync_log). */
  async bridgeStatus(email: string) {
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<
        { sync_job: string; finished_at: Date | null; status: string | null }[]
      >(
        Prisma.sql`SELECT sync_job, finished_at, status FROM bridge_sync_log
          WHERE sync_job = ANY(${PP_BRIDGE_JOBS}) ORDER BY finished_at DESC NULLS LAST LIMIT 200`,
      );
      const seen = new Map<string, unknown>();
      for (const r of rows) {
        if (!seen.has(r.sync_job))
          seen.set(r.sync_job, {
            sync_job: r.sync_job,
            last_finished: r.finished_at,
            status: r.status,
          });
      }
      return { data: [...seen.values()] };
    });
  }

  // ==========================================================================
  // R2 — MUTACIJE (overlays/urgency/drawings = merge-upsert; reassign = DEFINER RPC)
  // ==========================================================================
  // Sve pod SET LOCAL ROLE authenticated (withUserRls) → RLS `can_edit_plan_proizvodnje()`
  // presuđuje (42501→403). Overlay/urgency stamp `updated_by`/`set_by`=email; DELETE
  // urgency NIKAD (samo cleared_at flag). Reassign idempotencija = `p_client_event_uuid`
  // (audit ON CONFLICT (client_event_uuid, line_id) DO NOTHING).

  /**
   * Overlay UPSERT (patch, merge — samo poslata polja se menjaju; ON CONFLICT
   * (work_order_id, line_id)). Audit kolone (cam_ready_at/by, ready_override_at/by,
   * cooperation_set_at/by) stampuje server. `updated_by`/`created_by` = email.
   */
  async upsertOverlay(email: string, dto: OverlayUpsertDto) {
    const wo = BigInt(dto.workOrderId);
    const line = BigInt(dto.lineId);
    const now = new Date();
    const patch: Record<string, unknown> = {};
    if (dto.localStatus !== undefined) patch.localStatus = dto.localStatus;
    if (dto.shiftNote !== undefined) patch.shiftNote = dto.shiftNote;
    // Pin-marker: klijent šalje shiftSortOrder=-1 kao „pin-to-top" signal.
    // Kanon (1.0 pinToTop, services/planProizvodnje.js:1044): stvarna vrednost =
    // MIN(shift_sort_order postojećih ručnih za ISTU efektivnu mašinu) − 1, tako da
    // svaki novi pin ide IZNAD svih pinovanih. Bez ručnih redova fallback = 1.
    // Rešava se u tx (deltu min računamo nad view-om); ostale vrednosti (redosled
    // iz drag-a, null=unpin) prolaze doslovno.
    const isPinMarker = dto.shiftSortOrder === -1;
    if (dto.shiftSortOrder !== undefined && !isPinMarker)
      patch.shiftSortOrder = dto.shiftSortOrder;
    if (dto.assignedMachineCode !== undefined)
      patch.assignedMachineCode = dto.assignedMachineCode;
    if (dto.camReady !== undefined) {
      patch.camReady = dto.camReady;
      patch.camReadyAt = dto.camReady ? now : null;
      patch.camReadyBy = dto.camReady ? email : null;
    }
    if (dto.readyOverride !== undefined) {
      patch.readyOverride = dto.readyOverride;
      patch.readyOverrideAt = dto.readyOverride ? now : null;
      patch.readyOverrideBy = dto.readyOverride ? email : null;
    }
    if (dto.cooperationStatus !== undefined) {
      patch.cooperationStatus = dto.cooperationStatus;
      if (dto.cooperationStatus === "none") {
        patch.cooperationPartner = null;
        patch.cooperationExpectedReturn = null;
        patch.cooperationSetBy = null;
        patch.cooperationSetAt = null;
      } else {
        if (dto.cooperationPartner !== undefined)
          patch.cooperationPartner = dto.cooperationPartner;
        patch.cooperationExpectedReturn = this.toDbDate(
          dto.cooperationExpectedReturn,
        );
        patch.cooperationSetBy = email;
        patch.cooperationSetAt = now;
      }
    }
    return this.mut(email, async (tx) => {
      if (isPinMarker) {
        patch.shiftSortOrder = await this.resolvePinOrder(tx, wo, line);
      }
      const row = await tx.ppOverlay.upsert({
        where: { workOrderId_lineId: { workOrderId: wo, lineId: line } },
        create: {
          workOrderId: wo,
          lineId: line,
          ...patch,
          createdBy: email,
          updatedBy: email,
        },
        update: { ...patch, updatedBy: email, updatedAt: now },
      });
      return { data: jsonSafe(row) };
    });
  }

  /**
   * Pin-to-top kanon (1.0 pinToTop): MIN(shift_sort_order) postojećih RUČNIH
   * (shift_sort_order NOT NULL) operacija ISTE efektivne mašine kao ciljna linija,
   * minus 1. Bez ručnih redova → 1. Ciljna operacija se isključuje (da već-pinovan
   * red ne uđe u sopstveni min). Efektivna mašina iz view-a (poštuje reassign).
   */
  private async resolvePinOrder(
    tx: Sy15Tx,
    wo: bigint,
    line: bigint,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ min_order: number | null }[]>(
      Prisma.sql`SELECT MIN(v.shift_sort_order)::int AS min_order
        FROM v_production_operations_effective v
        WHERE v.effective_machine_code = (
            SELECT effective_machine_code FROM v_production_operations_effective
            WHERE work_order_id = ${wo}::bigint AND line_id = ${line}::bigint LIMIT 1
          )
          AND v.shift_sort_order IS NOT NULL
          AND NOT (v.work_order_id = ${wo}::bigint AND v.line_id = ${line}::bigint)`,
    );
    const min = rows[0]?.min_order;
    return min != null ? min - 1 : 1;
  }

  /** Bulk reorder — `shift_sort_order` = 1..n u datom redosledu (jedan tx). */
  async reorderOverlays(email: string, dto: OverlayReorderDto) {
    const now = new Date();
    return this.mut(email, async (tx) => {
      for (let i = 0; i < dto.items.length; i++) {
        const it = dto.items[i];
        const wo = BigInt(it.workOrderId);
        const line = BigInt(it.lineId);
        await tx.ppOverlay.upsert({
          where: { workOrderId_lineId: { workOrderId: wo, lineId: line } },
          create: {
            workOrderId: wo,
            lineId: line,
            shiftSortOrder: i + 1,
            createdBy: email,
            updatedBy: email,
          },
          update: { shiftSortOrder: i + 1, updatedBy: email, updatedAt: now },
        });
      }
      return { data: { reordered: dto.items.length } };
    });
  }

  /** HITNO set (merge upsert; reset cleared_*). PK work_order_id, DELETE nikad. */
  async setUrgent(email: string, workOrderId: string, dto: SetUrgentDto) {
    const wo = BigInt(workOrderId);
    const reason = (dto.reason ?? "").trim() || null;
    return this.mut(email, async (tx) => {
      const row = await tx.ppUrgency.upsert({
        where: { workOrderId: wo },
        create: { workOrderId: wo, isUrgent: true, reason, setBy: email },
        update: {
          isUrgent: true,
          reason,
          setBy: email,
          setAt: new Date(),
          clearedAt: null,
          clearedBy: null,
        },
      });
      return { data: jsonSafe(row) };
    });
  }

  /** HITNO clear = flag off + cleared_* (NE briše red; paritet 1.0 clearUrgent). */
  async clearUrgent(email: string, workOrderId: string) {
    const wo = BigInt(workOrderId);
    return this.mut(email, async (tx) => {
      const row = await tx.ppUrgency.upsert({
        where: { workOrderId: wo },
        create: {
          workOrderId: wo,
          isUrgent: false,
          clearedAt: new Date(),
          clearedBy: email,
        },
        update: { isUrgent: false, clearedAt: new Date(), clearedBy: email },
      });
      return { data: jsonSafe(row) };
    });
  }

  /** Reassign jedne linije (RPC; group-mismatch bez force → 422; force bez prava → 403). */
  async reassign(email: string, dto: ReassignDto) {
    const wo = BigInt(dto.workOrderId);
    const line = BigInt(dto.lineId);
    const target = dto.targetMachine ?? null;
    const force = !!dto.force;
    const reason = dto.reason ?? null;
    const cev = dto.clientEventId ?? randomUUID();
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw<{ r: unknown }[]>(
        Prisma.sql`SELECT reassign_production_line(${wo}::bigint, ${line}::bigint,
          ${target}::text, ${force}::boolean, ${reason}::text, ${cev}::uuid) AS r`,
      );
      return { data: rows[0]?.r ?? null };
    });
  }

  /** Bulk reassign (RPC; JEDAN client_event_uuid; p_pairs = [{wo,line}]). */
  async bulkReassign(email: string, dto: BulkReassignDto) {
    const pairs = dto.pairs.map((p) => ({
      wo: Number(p.workOrderId),
      line: Number(p.lineId),
    }));
    const target = dto.targetMachine ?? null;
    const force = !!dto.force;
    const reason = dto.reason ?? null;
    const cev = dto.clientEventId ?? randomUUID();
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw<{ r: unknown }[]>(
        Prisma.sql`SELECT bulk_reassign_production_lines(${JSON.stringify(pairs)}::jsonb,
          ${target}::text, ${force}::boolean, ${reason}::text, ${cev}::uuid) AS r`,
      );
      return { data: rows[0]?.r ?? null };
    });
  }

  // ---------- Kooperacija — auto grupe (admin; DELETE nikad, soft removed_at) ----------

  /** Upsert auto-koop grupe (ON CONFLICT rj_group_code; RLS current_user_is_admin → 403). */
  async upsertCooperationGroup(email: string, dto: CooperationGroupUpsertDto) {
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw(
        Prisma.sql`INSERT INTO production_auto_cooperation_groups
            (rj_group_code, group_label, notes, added_by, added_at)
          VALUES (${dto.rjGroupCode}, ${dto.groupLabel}, ${dto.notes ?? null}, ${email}, now())
          ON CONFLICT (rj_group_code) DO UPDATE SET
            group_label = EXCLUDED.group_label,
            notes = EXCLUDED.notes,
            removed_at = NULL, removed_by = NULL
          RETURNING rj_group_code, group_label, notes, added_at, added_by, removed_at, removed_by`,
      );
      return { data: jsonSafe((rows as unknown[])[0] ?? null) };
    });
  }

  /** Izmena/soft-remove/restore auto-koop grupe (RLS current_user_is_admin → 403). */
  async patchCooperationGroup(
    email: string,
    code: string,
    dto: CooperationGroupPatchDto,
  ) {
    const sets: Prisma.Sql[] = [];
    if (dto.groupLabel !== undefined)
      sets.push(Prisma.sql`group_label = ${dto.groupLabel}`);
    if (dto.notes !== undefined) sets.push(Prisma.sql`notes = ${dto.notes}`);
    if (dto.removed !== undefined) {
      sets.push(
        dto.removed
          ? Prisma.sql`removed_at = now(), removed_by = ${email}`
          : Prisma.sql`removed_at = NULL, removed_by = NULL`,
      );
    }
    if (!sets.length)
      throw new BadRequestException("Nema polja za izmenu grupe.");
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`UPDATE production_auto_cooperation_groups
          SET ${Prisma.join(sets, ", ")}
          WHERE rj_group_code = ${code}
          RETURNING rj_group_code, group_label, notes, added_at, added_by, removed_at, removed_by`,
      );
      if (!rows.length)
        throw new NotFoundException(`Koop grupa ${code} ne postoji`);
      return { data: jsonSafe(rows[0]) };
    });
  }

  // ---------- Skice (production-drawings) + bigtehn crteži ----------

  /**
   * Upload skice u `production-drawings` + meta u production_drawings. Putanja
   * 1.0-kompatibilna: `{wo}/{line}/{12hex}_{safeName}`. Autorizacija = can_edit
   * (RLS pri INSERT-u). Upload pre meta-insert-a (paritet 1.0 uploadDrawing).
   */
  async uploadDrawing(
    email: string,
    workOrder: string,
    line: string,
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer?.length) {
      throw new UnprocessableEntityException("Očekivan fajl (multipart `file`)");
    }
    // MIME whitelist (port 1.0 drawingManager ALLOWED_MIMES): eksplicitna lista
    // ILI bilo koji image/* (GAP-PM-19 BE deo). Bez ovoga bilo koji tip prolazi
    // (fallback application/octet-stream) pa fajl završi u bucket-u van dozvole.
    const mime = String(file.mimetype ?? "").toLowerCase();
    if (!ALLOWED_DRAWING_MIMES.includes(mime) && !mime.startsWith("image/")) {
      throw new UnprocessableEntityException(
        `Nepodržan tip fajla: ${file.mimetype || "(nepoznat)"}. Dozvoljeni: JPG, PNG, WEBP, HEIC, PDF.`,
      );
    }
    const wo = BigInt(workOrder);
    const li = BigInt(line);
    const safeName =
      String(file.originalname)
        .normalize("NFKD")
        .replace(/[^\w.\-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "file";
    const uuid = randomUUID().replace(/-/g, "").slice(0, 12);
    const storagePath = `${workOrder}/${line}/${uuid}_${safeName}`;
    await this.storage.upload(
      DRAWINGS_BUCKET,
      storagePath,
      new Uint8Array(file.buffer),
      file.mimetype || "application/octet-stream",
    );
    return this.mut(email, async (tx) => {
      const row = await tx.ppDrawing.create({
        data: {
          workOrderId: wo,
          lineId: li,
          storagePath,
          fileName: file.originalname,
          mimeType: file.mimetype || null,
          sizeBytes: file.size ? BigInt(file.size) : null,
          uploadedBy: email,
        },
      });
      return { data: jsonSafe(row) };
    });
  }

  /** Soft-delete skice (deleted_at/by) + best-effort brisanje fajla. */
  async deleteDrawing(email: string, id: string) {
    const idBig = BigInt(id);
    const path = await this.mut(email, async (tx) => {
      const d = await tx.ppDrawing.findUnique({
        where: { id: idBig },
        select: { storagePath: true, deletedAt: true },
      });
      if (!d) throw new NotFoundException(`Skica ${id} ne postoji`);
      const r = await tx.ppDrawing.updateMany({
        where: { id: idBig, deletedAt: null },
        data: { deletedAt: new Date(), deletedBy: email },
      });
      if (r.count === 0 && d.deletedAt) return null; // već obrisano — idempotentno
      return d.storagePath;
    });
    if (path) await this.storage.remove(DRAWINGS_BUCKET, path);
    return { data: { id } };
  }

  /** Presigned URL skice (gate can_read_production_drawings — presuda C3 strogi paritet). */
  async drawingSignUrl(email: string, id: string) {
    const idBig = BigInt(id);
    const path = await this.mut(email, async (tx) => {
      await this.assertCanReadDrawings(tx);
      const d = await tx.ppDrawing.findFirst({
        where: { id: idBig, deletedAt: null },
        select: { storagePath: true },
      });
      if (!d) throw new NotFoundException(`Skica ${id} ne postoji`);
      return d.storagePath;
    });
    return { data: await this.storage.signUrl(DRAWINGS_BUCKET, path, SIGNED_URL_TTL) };
  }

  /**
   * Presigned URL crteža iz bigtehn keša (TP procedura PDF). Sanitizacija broja +
   * revizija fallback (`{broj}_A/B`) — paritet 1.0 resolveBigtehnDrawing. Gate
   * can_read_production_drawings (presuda C3).
   */
  async bigtehnDrawingSignUrl(email: string, code: string) {
    const clean = sanitizeDrawingNo(code);
    if (!clean) throw new BadRequestException("Neispravan broj crteža.");
    const path = await this.mut(email, async (tx) => {
      await this.assertCanReadDrawings(tx);
      const exact = await tx.$queryRaw<{ storage_path: string }[]>(
        Prisma.sql`SELECT storage_path FROM bigtehn_drawings_cache
          WHERE drawing_no = ${clean} AND removed_at IS NULL LIMIT 1`,
      );
      if (exact[0]?.storage_path) return exact[0].storage_path;
      // Revizija fallback: {broj}_A/B — najviši sufiks.
      const cands = await tx.$queryRaw<{ drawing_no: string; storage_path: string }[]>(
        Prisma.sql`SELECT drawing_no, storage_path FROM bigtehn_drawings_cache
          WHERE drawing_no LIKE ${clean + "%"} AND removed_at IS NULL
          ORDER BY drawing_no DESC LIMIT 50`,
      );
      const hit = cands.find(
        (c) => c.drawing_no === clean || c.drawing_no.startsWith(clean + "_"),
      );
      if (!hit?.storage_path)
        throw new NotFoundException(`Crtež ${clean} nije u kešu.`);
      return hit.storage_path;
    });
    return {
      data: await this.storage.signUrl(
        BIGTEHN_DRAWINGS_BUCKET,
        path,
        SIGNED_URL_TTL,
      ),
    };
  }

  /** Gate za crteže (storage.objects politika u DB) — proveravamo mi (service ključ zaobilazi RLS). */
  private async assertCanReadDrawings(tx: Sy15Tx): Promise<void> {
    const rows = await tx.$queryRaw<{ ok: boolean }[]>(
      Prisma.sql`SELECT can_read_production_drawings() AS ok`,
    );
    if (!rows[0]?.ok) {
      throw new ForbiddenException("Nemate pravo na PDF crteža.");
    }
  }

  /** 'YYYY-MM-DD' → Date za @db.Date (undefined = ne diraj, null = obriši). */
  private toDbDate(v?: string | null): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  }

  private async mut<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      mapSy15Error(e);
    }
  }

  // ---------- interno ----------

  /** effective_machine_code WHERE fragment za odeljenje (port departments.js). */
  private deptWhere(slug: string): Prisma.Sql {
    const d = getDepartment(slug);
    if (!d || d.slug === "sve") return Prisma.empty; // Sve = bez dodatnog machine filtera
    if (d.isFallback) {
      // Ostalo = ne upada ni u jedan imenovani tab (operacije bez mašine SU u Ostalo).
      const named = NAMED_DEPARTMENTS.map((nd) => this.machineMatch(nd)).filter(
        (c): c is Prisma.Sql => c !== null,
      );
      if (!named.length) return Prisma.empty;
      return Prisma.sql`NOT COALESCE((${Prisma.join(named, " OR ")}), false)`;
    }
    return this.machineMatch(d) ?? Prisma.sql`false`;
  }

  private machineMatch(d: DepartmentDef): Prisma.Sql | null {
    const parts: Prisma.Sql[] = [];
    if (d.machineCodes?.length)
      parts.push(
        Prisma.sql`effective_machine_code IN (${Prisma.join(d.machineCodes)})`,
      );
    for (const p of d.machinePrefixes ?? [])
      parts.push(
        Prisma.sql`(effective_machine_code = ${p} OR effective_machine_code LIKE ${p + ".%"})`,
      );
    if (!parts.length) return null;
    let cond = Prisma.sql`(${Prisma.join(parts, " OR ")})`;
    if (d.excludeMachineCodes?.length)
      cond = Prisma.sql`(${cond} AND effective_machine_code NOT IN (${Prisma.join(d.excludeMachineCodes)}))`;
    return cond;
  }

  private async read<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn, opts);
    } catch (e) {
      mapSy15Error(e);
    }
  }
}

/** Clamp query-int (default/min/max). */
function clampInt(
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.floor(n), min), max);
}

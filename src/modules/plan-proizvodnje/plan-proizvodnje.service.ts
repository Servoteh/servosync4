import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { mapSy15Error } from "../../common/sy15-error";
import { jsonSafe } from "../../common/json-safe";
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
  constructor(private readonly sy15: Sy15Service) {}

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
      return this.read(email, async (tx) => {
        const where =
          cond === Prisma.empty
            ? Prisma.sql`WHERE ${OPEN_OPS}`
            : Prisma.sql`WHERE ${OPEN_OPS} AND ${cond}`;
        const data = await tx.$queryRaw(
          Prisma.sql`SELECT * FROM v_production_operations_effective ${where} ${OPS_SORT} LIMIT ${DEPT_LIMIT}`,
        );
        return { data: jsonSafe(data) };
      });
    }
    throw new BadRequestException("Zadaj ?machine= ili ?dept=.");
  }

  /** Sve otvorene operacije (agregatni prikazi) — min kolone, count + truncated na 10k. */
  async operationsAll(email: string) {
    return this.read(email, async (tx) => {
      const [rows, cnt] = await Promise.all([
        tx.$queryRaw(
          Prisma.sql`SELECT line_id, work_order_id, effective_machine_code, broj_crteza, naziv_dela,
              rn_ident_broj, tpz_min, tk_min, komada_total, komada_done, real_seconds, rok_izrade,
              is_non_machining, assigned_machine_code, local_status, opis_rada, operacija, cam_ready,
              is_ready_for_machine, is_urgent, auto_sort_bucket
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
    });
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
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
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

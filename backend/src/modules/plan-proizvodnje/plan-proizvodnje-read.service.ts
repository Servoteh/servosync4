import {
  BadRequestException,
  Injectable,
  NotFoundException,
  StreamableFile,
} from "@nestjs/common";
import type { Response } from "express";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PdmService } from "../pdm/pdm.service";
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

/**
 * Plan proizvodnje — READ sloj nad ORIGINALNIM 2.0 tabelama (F5b, plan
 * docs/PLAN_F5_GASENJE_MOSTA.md §4.2(a)). Zamena za sy15 view lanac
 * `v_production_operations_effective` + `plan_pp_open_ops_for_machine` RPC: ista
 * semantika, ali direktno nad `work_order_operations` / `work_orders` /
 * `tech_processes` / `operations` / `customers` / `drawing_pdfs` + nove app-owned
 * `plan_proizvodnje_*` tabele.
 *
 * Mapiranje = INVERZIJA hranilice `locations/loc-tp-feed.service.ts` (koja je punila
 * sy15 bigtehn keš iz 2.0 — ISTI id prostori):
 *   bigtehn_work_order_lines_cache ← work_order_operations   (line_id = op.id)
 *   bigtehn_work_orders_cache      ← work_orders             (id, RN)
 *   bigtehn_tech_routing_cache     ← tech_processes          (kucanja)
 *   bigtehn_machines_cache         ← operations              (rj_code=work_center_code,
 *                                     name=work_center_name, no_procedure=without_process)
 *   bigtehn_customers_cache        ← customers
 *   bigtehn_drawings_cache         ← PDM drawing_pdfs (crtež po broju; NEMA storage path)
 *   bigtehn_rework_scrap_cache     ← tech_processes.quality_type_id (1=dorada, 2=škart)
 *
 * Presuđene odluke (plan §8): M3 = id-jevi (`line_id`/`work_order_id`) izlaze kao
 * STRINGOVI (::text) — FE ugovor `line_id: string`; M6 = završna kontrola po native
 * `operations.significant_for_finishing` (NE sy15 `_pracenje_line_is_final_control`
 * heuristici — diff alat `scripts/diff-final-control-pp.ts`); M7 = MES-aktivan RN =
 * predmet aktivan (`predmet_aktivacije.is_active`), zamena za sy15 whitelist
 * `production_active_work_orders` (261 ručno-ugašenih iz seed-a je OČEKIVANA razlika —
 * pregled pre preklopa). Envelope `{ data, meta }`.
 */

/** Kanon otvorene operacije (§2-6; sy15 `plan_pp_open_ops_for_machine` WHERE + OPEN_OPS). */
const OPEN_OPS = Prisma.sql`is_done_in_bigtehn IS FALSE AND rn_zavrsen IS FALSE
  AND is_cooperation_effective IS FALSE AND overlay_archived_at IS NULL
  AND (local_status IS NULL OR local_status <> 'completed')`;

/** Efektivni filter (sy15 `v_production_operations_effective` WHERE): RN nije kroz završnu kontrolu. */
const EFF_FILTER = Prisma.sql`COALESCE(plan_rn_final_control_done, false) IS NOT TRUE`;

/**
 * BE sort kanon (dept/all/search) — sy15 OPS_SORT SA tie-breakerom (`rn_ident_broj,
 * operacija`). Deterministican poredak redova. Razlika od RPC-a (v. `RPC_SORT`).
 */
const OPS_SORT = Prisma.sql`ORDER BY shift_sort_order ASC NULLS LAST, auto_sort_bucket ASC,
  rok_izrade ASC NULLS LAST, prioritet_bigtehn ASC, rn_ident_broj ASC, operacija ASC`;

/**
 * RPC sort kanon (`?machine=` paginacija po RN) — VERNO preneto iz
 * `plan_pp_open_ops_for_machine` (snapshot:3038-3042): BEZ tie-breakera
 * (`rn_ident_broj`/`operacija`). Paginacija je po RN-u pa je poredak RN-ova stabilan
 * kroz `MIN(_sort_idx)`; unutar RN-a redosled operacija prati _sort_idx. Namerno se
 * NE dodaje tie-breaker — paritet sa sy15 RPC-om (§4.1 nalaz).
 */
const RPC_SORT = Prisma.sql`ORDER BY shift_sort_order ASC NULLS LAST, auto_sort_bucket ASC,
  rok_izrade ASC NULLS LAST, prioritet_bigtehn ASC`;

const ALL_OPS_LIMIT = 10000;
const DEPT_LIMIT = 5000;
const SEARCH_LIMIT = 500;
const SEARCH_MIN_LEN = 2;
const AUDIT_LIMIT = 500;
const SIGNED_URL_TTL = 0; // auth-gated content ruta (bez TTL/potpisa) — M1 bytea.

/** Kolone za `/operations/all` (min payload za agregat + FE paritet GAP-PM-05/06/07). */
const ALL_COLS = Prisma.sql`line_id, work_order_id, effective_machine_code, broj_crteza, naziv_dela,
  rn_ident_broj, tpz_min, tk_min, komada_total, komada_done, real_seconds, rok_izrade,
  is_non_machining, assigned_machine_code, local_status, opis_rada, operacija, cam_ready,
  is_ready_for_machine, is_urgent, auto_sort_bucket, customer_name, customer_short,
  drawings_count, has_bigtehn_drawing, is_rework, is_scrap, rework_pieces, scrap_pieces,
  previous_operation_operacija, previous_operation_status, previous_operation_machine_code`;

@Injectable()
export class PlanProizvodnjeReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdm: PdmService,
  ) {}

  // ==========================================================================
  // Mašine
  // ==========================================================================

  /** Mašine (šifarnik `operations` → bigtehn_machines_cache oblik). */
  async machines(_email: string) {
    const data = await this.prisma.$queryRaw(Prisma.sql`
      SELECT work_center_code AS rj_code,
             work_center_name AS name,
             work_center_name AS naziv,
             COALESCE(without_process, false) AS no_procedure
        FROM operations
       ORDER BY work_center_code ASC`);
    return { data: jsonSafe(data) };
  }

  // ==========================================================================
  // Operacije
  // ==========================================================================

  /**
   * Red operacija: `?machine=` → paginacija po RN (paritet RPC
   * `plan_pp_open_ops_for_machine`), `?dept=` → filter po `effective_machine_code`.
   * Bez oba → 400.
   */
  async operations(email: string, q: OperationsQueryDto) {
    if (q.machine) {
      const machine = q.machine.trim();
      const limit = clampInt(q.limit, 100, 1, 250);
      const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return this.machineOps(machine, limit, offset);
    }
    if (q.dept) {
      const cond = this.deptWhere(q.dept);
      const where =
        cond === Prisma.empty
          ? Prisma.sql`WHERE ${EFF_FILTER} AND ${OPEN_OPS}`
          : Prisma.sql`WHERE ${EFF_FILTER} AND ${OPEN_OPS} AND ${cond}`;
      const data = await this.prisma.$queryRaw(Prisma.sql`
        SELECT * FROM (${this.effectiveOpsInner(Prisma.empty)}) eff
        ${where} ${OPS_SORT} LIMIT ${DEPT_LIMIT}`);
      return { data: jsonSafe(data) };
    }
    throw new BadRequestException("Zadaj ?machine= ili ?dept=.");
  }

  /**
   * Paginacija po RN (kanon `plan_pp_open_ops_for_machine`): efektivne otvorene
   * operacije mašine → RPC sort → grupisanje po RN (MIN sort idx) → prozor
   * [offset, offset+limit) RN-ova. `has_more` = ima li RN iza prozora.
   */
  private async machineOps(machine: string, limit: number, offset: number) {
    if (machine === "") {
      return { data: { rows: [], has_more: false, next_work_order_offset: 0 } };
    }
    // Mašinski filter u BAZI (perf): laterali se računaju SAMO za redove te mašine.
    const baseFilter = Prisma.sql`AND COALESCE(o.assigned_machine_code, NULLIF(BTRIM(l.work_center_code),'')) = ${machine}`;
    const rows = (await this.prisma.$queryRaw(Prisma.sql`
      SELECT * FROM (${this.effectiveOpsInner(baseFilter)}) eff
      WHERE ${EFF_FILTER} AND ${OPEN_OPS} ${RPC_SORT}`)) as {
      work_order_id: string;
    }[];

    // Paginacija po RN u JS (mirror RPC wo_first/wo_numbered/picked_wo).
    const firstIdx = new Map<string, number>();
    rows.forEach((r, i) => {
      if (!firstIdx.has(r.work_order_id)) firstIdx.set(r.work_order_id, i);
    });
    const wos = [...firstIdx.entries()]
      .sort((a, b) => a[1] - b[1])
      .map((e) => e[0]);
    const picked = new Set(wos.slice(offset, offset + limit));
    return {
      data: {
        rows: jsonSafe(rows.filter((r) => picked.has(r.work_order_id))),
        has_more: wos.length > offset + limit,
        next_work_order_offset: offset + picked.size,
      },
    };
  }

  /** Sve otvorene operacije (agregatni prikazi) — min kolone, count + truncated na 10k. */
  async operationsAll(_email: string) {
    const [rows, cnt] = await Promise.all([
      this.prisma.$queryRaw(Prisma.sql`
        SELECT ${ALL_COLS} FROM (${this.effectiveOpsInner(Prisma.empty)}) eff
        WHERE ${EFF_FILTER} AND ${OPEN_OPS} AND effective_machine_code IS NOT NULL
        ${OPS_SORT} LIMIT ${ALL_OPS_LIMIT}`),
      this.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT count(*) AS n FROM (${this.effectiveOpsInner(Prisma.empty)}) eff
        WHERE ${EFF_FILTER} AND ${OPEN_OPS} AND effective_machine_code IS NOT NULL`),
    ]);
    const total = Number(cnt[0]?.n ?? 0);
    return {
      data: jsonSafe(rows),
      meta: { total, truncated: total > ALL_OPS_LIMIT, limit: ALL_OPS_LIMIT },
    };
  }

  /** Pretraga operacija po crtežu/RN/nazivu (paritet loadOperationsByRnOrDrawingQuery). */
  async operationsSearch(_email: string, q?: string) {
    const term = (q ?? "").trim();
    if (term.length < SEARCH_MIN_LEN) return { data: [] };
    const like = `%${term}%`;
    const data = await this.prisma.$queryRaw(Prisma.sql`
      SELECT * FROM (${this.effectiveOpsInner(Prisma.empty)}) eff
      WHERE ${EFF_FILTER} AND ${OPEN_OPS}
        AND (broj_crteza ILIKE ${like} OR rn_ident_broj ILIKE ${like} OR naziv_dela ILIKE ${like})
      ORDER BY effective_machine_code ASC NULLS LAST, broj_crteza ASC, rn_ident_broj ASC, operacija ASC
      LIMIT ${SEARCH_LIMIT}`);
    return { data: jsonSafe(data) };
  }

  // ==========================================================================
  // Kooperacija
  // ==========================================================================

  /** Operacije efektivno u kooperaciji (is_cooperation_effective=true) + opciona pretraga. */
  async cooperation(_email: string, q: CooperationQueryDto) {
    const term = (q.q ?? "").trim();
    const like = term ? `%${term}%` : null;
    const search = like
      ? Prisma.sql`AND (broj_crteza ILIKE ${like} OR rn_ident_broj ILIKE ${like} OR naziv_dela ILIKE ${like})`
      : Prisma.empty;
    const data = await this.prisma.$queryRaw(Prisma.sql`
      SELECT * FROM (${this.effectiveOpsInner(Prisma.empty)}) eff
      WHERE ${EFF_FILTER} AND is_done_in_bigtehn IS FALSE AND rn_zavrsen IS FALSE
        AND is_cooperation_effective IS TRUE AND overlay_archived_at IS NULL
        AND (local_status IS NULL OR local_status <> 'completed') ${search}
      ORDER BY rok_izrade ASC NULLS LAST, rn_ident_broj ASC, operacija ASC
      LIMIT ${DEPT_LIMIT}`);
    return { data: jsonSafe(data) };
  }

  /** Auto-koop grupe (plan_proizvodnje_auto_cooperation_groups) — admin CRUD je write. */
  async cooperationGroups(_email: string) {
    const rows = await this.prisma.planProizvodnjeAutoKoopGroup.findMany({
      orderBy: [{ rjGroupCode: "asc" }],
    });
    const data = rows.map((r) => ({
      rj_group_code: r.rjGroupCode,
      group_label: r.groupLabel,
      notes: r.notes,
      added_at: r.addedAt,
      added_by: r.addedBy,
      removed_at: r.removedAt,
      removed_by: r.removedBy,
    }));
    return { data: jsonSafe(data) };
  }

  // ==========================================================================
  // Reassign audit
  // ==========================================================================

  /** Audit forsiranih premeštaja (plan_proizvodnje_reassign_audit) — gate `plan_proizvodnje.force`. */
  async reassignAudit(_email: string) {
    const rows = await this.prisma.planProizvodnjeReassignAudit.findMany({
      orderBy: [{ createdAt: "desc" }],
      take: AUDIT_LIMIT,
    });
    // Aliasi na sy15 audit imena kolona (source_machine/target_machine) — FE audit tab
    // renderuje generički Record, ali imena čuvamo radi pariteta.
    const data = rows.map((r) => ({
      id: r.id,
      work_order_id: String(r.workOrderId),
      line_id: String(r.lineId),
      actor_email: r.actorEmail,
      source_machine: r.fromMachineCode,
      target_machine: r.toMachineCode,
      source_group: r.sourceGroup,
      target_group: r.targetGroup,
      forced: r.forced,
      force_reason: r.forceReason,
      client_event_uuid: r.clientEventUuid,
      created_at: r.createdAt,
    }));
    return { data: jsonSafe(data) };
  }

  // ==========================================================================
  // Tehnološki postupak (TP modal)
  // ==========================================================================

  /**
   * Ceo TP RN-a (TP procedura modal): operacije (native ekvivalent
   * `v_production_operations` — BEZ open/eff filtera) + logovi kucanja
   * (`tech_processes` ekvivalent bigtehn_tech_routing_cache). real_seconds kanon #2.
   */
  async techProcedure(_email: string, workOrderId: number) {
    const [operations, logs] = await Promise.all([
      this.prisma.$queryRaw(Prisma.sql`
        SELECT * FROM (${this.effectiveOpsInner(Prisma.sql`AND l.work_order_id = ${workOrderId}`, true)}) eff
        ORDER BY operacija ASC LIMIT 500`),
      this.prisma.$queryRaw(Prisma.sql`
        SELECT tp.id::text AS id, tp.operation_number AS operacija,
               NULLIF(BTRIM(tp.work_center_code), '') AS machine_code, tp.worker_id,
               tp.piece_count AS komada, tp.print_timer AS prn_timer_seconds,
               tp.entered_at AS started_at, tp.finished_at AS finished_at,
               COALESCE(tp.is_process_finished, false) AS is_completed,
               NULLIF(BTRIM(tp.note), '') AS napomena, NULLIF(BTRIM(tp.signature), '') AS potpis,
               tp.quality_type_id
          FROM tech_processes tp
         WHERE tp.work_order_id = ${workOrderId}
         ORDER BY tp.operation_number ASC, tp.entered_at ASC LIMIT 2000`),
    ]);
    const ops = jsonSafe(operations) as unknown[];
    return {
      data: { operations: ops, logs: jsonSafe(logs), header: ops[0] ?? null },
    };
  }

  // ==========================================================================
  // Skice (plan_proizvodnje_drawings) + bigtehn crteži (PDM)
  // ==========================================================================

  /** Lista skica operacije (bez soft-obrisanih). `storagePath` = null (M1 bytea). */
  async drawings(_email: string, q: DrawingsQueryDto) {
    const wo = Number(q.workOrder);
    const line = Number(q.line);
    const rows = await this.prisma.planProizvodnjeDrawing.findMany({
      where: { workOrderId: wo, lineId: line, deletedAt: null },
      orderBy: [{ uploadedAt: "asc" }],
      select: {
        id: true,
        workOrderId: true,
        lineId: true,
        fileName: true,
        contentType: true,
        sizeBytes: true,
        uploadedAt: true,
        uploadedBy: true,
        deletedAt: true,
        deletedBy: true,
      },
    });
    const data = rows.map((r) => ({
      id: String(r.id),
      workOrderId: String(r.workOrderId),
      lineId: r.lineId != null ? String(r.lineId) : null,
      // M1: PDF je bytea u bazi (nema object storage); FE otvara kroz content rutu.
      storagePath: null,
      fileName: r.fileName,
      mimeType: r.contentType,
      sizeBytes: r.sizeBytes != null ? Number(r.sizeBytes) : null,
      uploadedAt: r.uploadedAt,
      uploadedBy: r.uploadedBy,
      deletedAt: r.deletedAt,
      deletedBy: r.deletedBy,
    }));
    return { data: jsonSafe(data) };
  }

  /**
   * Signed URL skice → auth-gated content ruta (M1: nema presigned storage-a).
   * `expiresIn: 0` = ruta je gejtovana JWT-om + `plan_proizvodnje.read` (kontroler),
   * bez TTL-a. Paritet FE `{ url, expiresIn }` (predsedan pracenje.crtezSignUrl).
   */
  async drawingSignUrl(_email: string, id: string) {
    const idNum = Number(id);
    const d = await this.prisma.planProizvodnjeDrawing.findFirst({
      where: { id: idNum, deletedAt: null },
      select: { id: true },
    });
    if (!d) throw new NotFoundException(`Skica ${id} ne postoji`);
    return {
      data: {
        url: `/api/v1/plan-proizvodnje/drawings/${d.id}/pdf/content`,
        expiresIn: SIGNED_URL_TTL,
      },
    };
  }

  /** Strim skice iz bytea (M1) — `plan_proizvodnje_drawings.pdf_binary`. */
  async streamDrawing(
    id: number,
    res: Response,
    user: { userId: number; email: string } | undefined,
  ): Promise<StreamableFile> {
    const d = await this.prisma.planProizvodnjeDrawing.findFirst({
      where: { id, deletedAt: null },
      select: { fileName: true, contentType: true, pdfBinary: true },
    });
    if (!d?.pdfBinary) throw new NotFoundException(`Skica ${id} nema sadržaj.`);
    void this.prisma.auditLog
      .create({
        data: {
          action: "PP-DRAWING-ACCESS",
          entityType: "plan_proizvodnje_drawing",
          entityId: String(id),
          actorUserId: user?.userId ?? null,
          actorUsername: user?.email ?? null,
          metadata: { route: "plan-proizvodnje", download: false },
        },
      })
      .catch(() => {});
    res.set(this.pdfHeaders(d.fileName ?? "skica.pdf", d.contentType));
    return new StreamableFile(Buffer.from(d.pdfBinary));
  }

  /**
   * Signed URL bigtehn crteža (TP procedura PDF) → content ruta ka PDM crtežu.
   * Sanitizacija broja + revizija fallback (`{broj}_A/B`); PDM `drawings` po broju.
   * Gate za PP crteže OSTAJE (odluka O7 važi SAMO za praćenje) — kontroler nosi
   * `plan_proizvodnje.read`.
   */
  async bigtehnDrawingSignUrl(_email: string, code: string) {
    const clean = sanitizeDrawingNo(code);
    if (!clean) throw new BadRequestException("Neispravan broj crteža.");
    const base = clean.split("_")[0].trim() || clean;
    const d = await this.prisma.drawing.findFirst({
      where: { OR: [{ drawingNumber: clean }, { drawingNumber: base }] },
      orderBy: [{ drawingNumber: "desc" }, { revision: "desc" }],
      select: { id: true },
    });
    if (!d) throw new NotFoundException(`Crtež ${clean} nije pronađen.`);
    return {
      data: {
        url: `/api/v1/plan-proizvodnje/drawings/bigtehn/${d.id}/pdf/content`,
        expiresIn: SIGNED_URL_TTL,
      },
    };
  }

  /** Strim PDM crteža (reuse PdmService.getPdfContent — jedan put čitanja bytea). */
  async streamBigtehnDrawing(
    drawingId: number,
    res: Response,
    user: { userId: number; email: string } | undefined,
  ): Promise<StreamableFile> {
    void this.prisma.auditLog
      .create({
        data: {
          action: "PP-DRAWING-ACCESS",
          entityType: "drawing",
          entityId: String(drawingId),
          actorUserId: user?.userId ?? null,
          actorUsername: user?.email ?? null,
          metadata: { route: "plan-proizvodnje", download: false },
        },
      })
      .catch(() => {});
    const { buffer, fileName } = await this.pdm.getPdfContent(drawingId);
    res.set(this.pdfHeaders(fileName, "application/pdf"));
    return new StreamableFile(buffer);
  }

  // ==========================================================================
  // interno
  // ==========================================================================

  /** `Content-Type`/`Content-Disposition` (inline) sa ASCII + RFC 5987 fallback. */
  private pdfHeaders(fileName: string, contentType: string | null) {
    const asciiName =
      fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") ||
      "crtez.pdf";
    const utf8Name = encodeURIComponent(fileName).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return {
      "Content-Type": contentType || "application/pdf",
      "Content-Disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
    };
  }

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
    let codeCond: Prisma.Sql | null = null;
    if (parts.length) {
      codeCond = Prisma.sql`(${Prisma.join(parts, " OR ")})`;
      if (d.excludeMachineCodes?.length)
        codeCond = Prisma.sql`(${codeCond} AND effective_machine_code NOT IN (${Prisma.join(d.excludeMachineCodes)}))`;
    }
    const nameParts = (d.operationNamePatterns ?? [])
      .map((p) => String(p).trim())
      .filter(Boolean)
      .map((p) => Prisma.sql`opis_rada ILIKE ${"%" + p + "%"}`);
    const nameCond = nameParts.length
      ? Prisma.sql`(${Prisma.join(nameParts, " OR ")})`
      : null;
    if (codeCond && nameCond) return Prisma.sql`(${codeCond} OR ${nameCond})`;
    return codeCond ?? nameCond;
  }

  /**
   * Native ekvivalent `v_production_operations` (PRE efektivnog filtera) kao izvedena
   * tabela. Reimplementira ceo sy15 view lanac (pre_g4 → G4 → fc) nad 2.0 tabelama.
   * `baseFilter` (Prisma.Sql) se ubacuje u NAJDUBLJU WHERE granu (predmet-aktivan
   * gate + mašinski/RN filter) — tako se skupi laterali računaju SAMO za preživele
   * redove (perf: `?machine=` filter u bazi, ne posle laterala).
   *
   * Kolone i imena su 1:1 sa `v_production_operations_effective` (FE ugovor). M3:
   * `line_id`/`work_order_id` izlaze kao ::text. `is_mes_active = true` (predmet-aktivan
   * gate je u WHERE-u, M7). `bigtehn_drawing_path/size = NULL` (PDM nema storage path —
   * v. izveštaj). Real_seconds = Σ EPOCH(finished−entered) FILTER(finished>entered)
   * (kanon #2, inverzija feed mapiranja). Final control = significant_for_finishing (M6).
   *
   * PG 42803 zaštita: nijedan `FILTER`/agregat NE referiše outer (`base.*`) kolonu —
   * outer ref-ovi su SAMO u WHERE join-uslovima laterala (agregati nad inner kolonama).
   */
  private effectiveOpsInner(
    baseFilter: Prisma.Sql,
    // The TP-procedure modal must show the full routing regardless of predmet
    // activation (sy15 read from the NON-effective view, which had no predmet
    // gate). Every planner-facing list keeps the M7 active-predmet gate.
    includeInactivePredmet = false,
  ): Prisma.Sql {
    const predmetGate = includeInactivePredmet
      ? Prisma.sql`TRUE`
      : Prisma.sql`EXISTS (SELECT 1 FROM predmet_aktivacije pa WHERE pa.project_id = wo.project_id AND pa.is_active IS TRUE)`;
    return Prisma.sql`
    SELECT
      base.line_id_raw::text AS line_id,
      base.wo_raw::text AS work_order_id,
      base.operacija,
      base.opis_rada, base.alat_pribor,
      base.original_machine_code, base.effective_machine_code,
      base.tpz_min, base.tk_min, base.prioritet_bigtehn,
      base.rn_ident_broj, base.broj_crteza, base.naziv_dela, base.materijal, base.dimenzija_materijala,
      base.komada_total, base.rok_izrade, base.rn_zavrsen, base.rn_zakljucano, base.rn_napomena,
      base.item_id, base.customer_id, base.customer_name, base.customer_short,
      base.original_machine_name, base.is_non_machining,
      base.overlay_id, base.shift_sort_order, base.local_status, base.shift_note, base.assigned_machine_code,
      base.overlay_archived_at, base.overlay_archived_reason, base.overlay_updated_at, base.overlay_updated_by,
      base.overlay_created_at, base.overlay_created_by,
      COALESCE(tr.komada_done, 0)::bigint AS komada_done,
      COALESCE(tr.real_seconds, 0)::bigint AS real_seconds,
      COALESCE(tr.is_done, false) AS is_done_in_bigtehn,
      tr.last_finished_at, tr.prijava_count,
      COALESCE(d.drawings_count, 0)::int AS drawings_count,
      (bd.bd_no IS NOT NULL) AS has_bigtehn_drawing,
      NULL::text AS bigtehn_drawing_path,
      NULL::bigint AS bigtehn_drawing_size,
      true AS is_mes_active,
      base.cam_ready, base.cam_ready_at, base.cam_ready_by,
      base.rj_group_code, base.rj_group_label,
      base.cooperation_status, base.cooperation_partner, base.cooperation_set_by, base.cooperation_set_at, base.cooperation_expected_return,
      (g.id IS NOT NULL) AS is_cooperation_auto,
      (base.cooperation_status <> 'none') AS is_cooperation_manual,
      ((g.id IS NOT NULL) OR (base.cooperation_status <> 'none')) AS is_cooperation_effective,
      CASE WHEN (g.id IS NOT NULL) AND base.cooperation_status <> 'none' THEN 'auto+manual'
           WHEN g.id IS NOT NULL THEN 'auto'
           WHEN base.cooperation_status <> 'none' THEN 'manual'
           ELSE 'none' END AS cooperation_source,
      (base.ready_override OR COALESCE(rc.is_ready_rb, false)) AS is_ready_for_machine,
      (base.ready_override OR COALESCE(rc.is_ready_rb, false)) AS is_ready_for_processing,
      base.ready_override AS is_ready_manual,
      base.ready_override_at, base.ready_override_by,
      CASE WHEN prev_any.operacija IS NULL THEN 'none'
           WHEN prev_blk.operacija IS NULL THEN 'completed'
           WHEN COALESCE(prev_blk.komada_done, 0) > 0 THEN 'in_progress'
           ELSE 'not_started' END AS previous_operation_status,
      COALESCE(prev_blk.operacija, prev_any.operacija) AS previous_operation_operacija,
      COALESCE(prev_blk.machine_code, prev_any.machine_code) AS previous_operation_machine_code,
      (u.id IS NOT NULL) AS is_urgent,
      u.reason AS urgency_reason,
      CASE
        WHEN base.local_status_eff = 'blocked' THEN 7
        WHEN u.id IS NOT NULL AND (base.ready_override OR COALESCE(rc.is_ready_rb, false)) AND base.local_status_eff = 'in_progress' THEN 1
        WHEN u.id IS NOT NULL AND (base.ready_override OR COALESCE(rc.is_ready_rb, false)) AND base.local_status_eff = 'waiting' THEN 2
        WHEN u.id IS NOT NULL AND NOT (base.ready_override OR COALESCE(rc.is_ready_rb, false)) THEN 3
        WHEN u.id IS NULL AND base.local_status_eff = 'in_progress' THEN 4
        WHEN u.id IS NULL AND (base.ready_override OR COALESCE(rc.is_ready_rb, false)) AND base.local_status_eff = 'waiting' THEN 5
        WHEN u.id IS NULL AND NOT (base.ready_override OR COALESCE(rc.is_ready_rb, false)) AND base.local_status_eff = 'waiting' THEN 6
        ELSE 8 END AS auto_sort_bucket,
      COALESCE(g4.is_rework, false) AS is_rework,
      COALESCE(g4.is_scrap, false) AS is_scrap,
      COALESCE(g4.rework_pieces, 0)::int AS rework_pieces,
      COALESCE(g4.scrap_pieces, 0)::int AS scrap_pieces,
      COALESCE(g4.rework_scrap_count, 0)::int AS rework_scrap_count,
      (base.komada_total IS NOT NULL AND base.komada_total > 0
        AND COALESCE(fc.final_control_raw_sum, 0)::numeric >= base.komada_total::numeric
        AND COALESCE(fc.final_control_raw_sum, 0)::numeric <= base.komada_total::numeric * 1.5) AS plan_rn_final_control_done
    FROM (
      SELECT
        l.id AS line_id_raw,
        l.work_order_id AS wo_raw,
        l.operation_number AS operacija,
        NULLIF(BTRIM(l.work_description), '') AS opis_rada,
        NULLIF(BTRIM(l.tools_fixtures), '') AS alat_pribor,
        NULLIF(BTRIM(l.work_center_code), '') AS original_machine_code,
        COALESCE(o.assigned_machine_code, NULLIF(BTRIM(l.work_center_code), '')) AS effective_machine_code,
        COALESCE(l.setup_time, 0) AS tpz_min,
        COALESCE(l.cycle_time, 0) AS tk_min,
        l.priority AS prioritet_bigtehn,
        COALESCE(NULLIF(BTRIM(wo.ident_number), ''), '(no-' || wo.id || ')') AS rn_ident_broj,
        NULLIF(BTRIM(wo.drawing_number), '') AS broj_crteza,
        NULLIF(BTRIM(wo.part_name), '') AS naziv_dela,
        NULLIF(BTRIM(wo.material), '') AS materijal,
        NULLIF(BTRIM(wo.material_dimension), '') AS dimenzija_materijala,
        wo.piece_count AS komada_total,
        wo.production_deadline AS rok_izrade,
        COALESCE(wo.status, false) AS rn_zavrsen,
        COALESCE(wo.is_locked, false) AS rn_zakljucano,
        NULLIF(BTRIM(wo.note), '') AS rn_napomena,
        wo.project_id AS item_id,
        c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short,
        m.work_center_name AS original_machine_name,
        COALESCE(m.without_process, false) AS is_non_machining,
        o.id AS overlay_id, o.shift_sort_order, o.local_status, o.shift_note, o.assigned_machine_code,
        o.archived_at AS overlay_archived_at, o.archived_reason AS overlay_archived_reason,
        o.updated_at AS overlay_updated_at, o.updated_by AS overlay_updated_by,
        o.created_at AS overlay_created_at, o.created_by AS overlay_created_by,
        COALESCE(o.cam_ready, false) AS cam_ready, o.cam_ready_at, o.cam_ready_by,
        m.work_center_code AS rj_group_code, m.work_center_name AS rj_group_label,
        COALESCE(o.cooperation_status, 'none') AS cooperation_status,
        o.cooperation_partner, o.cooperation_set_by, o.cooperation_set_at, o.cooperation_expected_return,
        COALESCE(o.ready_override, false) AS ready_override, o.ready_override_at, o.ready_override_by,
        COALESCE(o.local_status, 'waiting') AS local_status_eff
      FROM work_order_operations l
      JOIN work_orders wo ON wo.id = l.work_order_id
      LEFT JOIN operations m ON m.work_center_code = l.work_center_code
      LEFT JOIN customers c ON c.id = NULLIF(wo.external_customer_id, 0)
      LEFT JOIN plan_proizvodnje_overlays o ON o.work_order_id = l.work_order_id AND o.line_id = l.id
      WHERE ${predmetGate}
        ${baseFilter}
    ) base
    LEFT JOIN plan_proizvodnje_auto_cooperation_groups g ON g.rj_group_code = base.original_machine_code AND g.removed_at IS NULL
    LEFT JOIN plan_proizvodnje_urgency_overrides u ON u.work_order_id = base.wo_raw AND u.is_urgent IS TRUE AND u.cleared_at IS NULL
    LEFT JOIN LATERAL (
      SELECT NOT EXISTS (
        SELECT 1 FROM work_order_operations l2
        LEFT JOIN operations m2 ON m2.work_center_code = l2.work_center_code
        WHERE l2.work_order_id = base.wo_raw AND l2.operation_number < base.operacija
          AND COALESCE(m2.without_process, false) = false
          AND NOT EXISTS (SELECT 1 FROM tech_processes t
                          WHERE t.work_order_id = l2.work_order_id AND t.operation_number = l2.operation_number
                            AND COALESCE(t.is_process_finished, false) IS TRUE)
      ) AS is_ready_rb
    ) rc ON true
    LEFT JOIN LATERAL (
      SELECT SUM(t.piece_count) AS komada_done,
             COALESCE(SUM(EXTRACT(EPOCH FROM (t.finished_at - t.entered_at))) FILTER (WHERE t.finished_at > t.entered_at), 0)::bigint AS real_seconds,
             bool_or(COALESCE(t.is_process_finished, false)) AS is_done,
             max(t.finished_at) AS last_finished_at,
             count(*) AS prijava_count
      FROM tech_processes t
      WHERE t.work_order_id = base.wo_raw AND t.operation_number = base.operacija
    ) tr ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS drawings_count FROM plan_proizvodnje_drawings pd
      WHERE pd.work_order_id = base.wo_raw AND pd.line_id = base.line_id_raw AND pd.deleted_at IS NULL
    ) d ON true
    LEFT JOIN LATERAL (
      SELECT l2.operation_number AS operacija, NULLIF(BTRIM(l2.work_center_code), '') AS machine_code
      FROM work_order_operations l2
      WHERE l2.work_order_id = base.wo_raw AND l2.operation_number < base.operacija
      ORDER BY l2.operation_number DESC LIMIT 1
    ) prev_any ON true
    LEFT JOIN LATERAL (
      SELECT l2.operation_number AS operacija, NULLIF(BTRIM(l2.work_center_code), '') AS machine_code,
             COALESCE(t2.komada_done, 0) AS komada_done
      FROM work_order_operations l2
      LEFT JOIN operations m2 ON m2.work_center_code = l2.work_center_code
      LEFT JOIN LATERAL (
        SELECT SUM(t.piece_count) AS komada_done, bool_or(COALESCE(t.is_process_finished, false)) AS is_done
        FROM tech_processes t WHERE t.work_order_id = l2.work_order_id AND t.operation_number = l2.operation_number
      ) t2 ON true
      WHERE l2.work_order_id = base.wo_raw AND l2.operation_number < base.operacija
        AND COALESCE(m2.without_process, false) = false AND COALESCE(t2.is_done, false) = false
      ORDER BY l2.operation_number DESC LIMIT 1
    ) prev_blk ON true
    LEFT JOIN LATERAL (
      SELECT bool_or(t.quality_type_id = 1) AS is_rework,
             bool_or(t.quality_type_id = 2) AS is_scrap,
             COALESCE(SUM(t.piece_count) FILTER (WHERE t.quality_type_id = 1), 0) AS rework_pieces,
             COALESCE(SUM(t.piece_count) FILTER (WHERE t.quality_type_id = 2), 0) AS scrap_pieces,
             count(*) FILTER (WHERE t.quality_type_id IN (1, 2)) AS rework_scrap_count
      FROM tech_processes t
      WHERE t.work_order_id = base.wo_raw AND t.operation_number = base.operacija AND t.quality_type_id IN (1, 2)
    ) g4 ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(t.piece_count), 0) AS final_control_raw_sum
      FROM work_order_operations l3
      JOIN operations m3 ON m3.work_center_code = l3.work_center_code
      JOIN tech_processes t ON t.work_order_id = l3.work_order_id AND t.operation_number = l3.operation_number
           AND NOT (NULLIF(BTRIM(t.work_center_code), '') IS DISTINCT FROM NULLIF(BTRIM(l3.work_center_code), ''))
           AND COALESCE(t.is_process_finished, false) IS TRUE
      WHERE l3.work_order_id = base.wo_raw AND COALESCE(m3.significant_for_finishing, false) IS TRUE
    ) fc ON true
    LEFT JOIN LATERAL (
      SELECT dp.drawing_number AS bd_no
      FROM drawing_pdfs dp
      WHERE dp.drawing_number = NULLIF(BTRIM(split_part(base.broj_crteza, '_', 1)), '')
      ORDER BY dp.revision DESC LIMIT 1
    ) bd ON true`;
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

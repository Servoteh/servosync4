import { Injectable, NotFoundException } from "@nestjs/common";
import {
  LocMovementTypeEnum,
  LocPlacementStatusEnum,
  LocTypeEnum,
  Prisma,
} from "@prisma-sy15/client";
import { Sy15Service } from "../../common/sy15/sy15.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import {
  normalizeBarcodeText,
  normalizeLocMovementKeys,
  parseBigTehnBarcode,
  placementRowMatchesPredmetTp,
  resolveCompositeShelfScan,
  type ShelfLoc,
} from "./barcode";

/**
 * Lokacije delova — 3.0 Talas A, R1 READ sloj (MODULE_SPEC_lokacije_30.md §3).
 * Podaci žive u sy15 (1.0) bazi (doktrina A1); ovaj servis samo ČITA:
 *  - tabele kroz Prisma (`prisma/sy15.prisma`, bez FK relacija — 1.0 šema ih
 *    nema; spajanja su ručna batch-resolve, kao rev_* modeli),
 *  - DB funkcije/izveštaje kroz GUC most (`Sy15Service.withUser`) jer definer fn
 *    i „aktivan/admin" predikati čitaju identitet iz `auth.jwt()` (doktrina A2).
 * Mutacije (create_movement/cage-move/CRUD/labels/sync arm) su R2 — ovde ih NEMA.
 */

// ---------- Query DTO-i (stringovi iz query-ja; parse + clamp u servisu) ----------

export interface ListLocationsQuery {
  active?: string; // "true" (default) | "all" | "false"
  q?: string; // šifra / naziv / path_cached (ilike)
  kind?: string; // hall | shelf | cage | machine
  type?: string; // tačan loc_type_enum
  parentId?: string;
  page?: string;
  pageSize?: string;
}

export interface ListPlacementsQuery {
  search?: string; // item_ref_id / item_ref_table / order_no / drawing_no (ilike)
  locationId?: string;
  orderNo?: string; // striktno (uklj. "" = bez naloga)
  itemRefId?: string; // istorija stavke
  itemRefTable?: string; // default bigtehn_rn (paritet fetchPlacements)
  status?: string; // loc_placement_status_enum
  page?: string;
  pageSize?: string;
}

export interface ListMovementsQuery {
  search?: string; // item_ref_id / order_no (ilike)
  userId?: string; // moved_by
  locationId?: string; // from OR to
  movementType?: string; // loc_movement_type_enum
  orderNo?: string; // striktno
  itemRefId?: string; // istorija stavke
  itemRefTable?: string;
  dateFrom?: string; // YYYY-MM-DD (moved_at >= dan 00:00)
  dateTo?: string; // YYYY-MM-DD (moved_at < sledeći dan 00:00)
  page?: string;
  pageSize?: string;
}

export interface ReportByLocationQuery {
  drawingNo?: string;
  orderNo?: string;
  tpNo?: string;
  projectSearch?: string;
  locationId?: string;
  locationQ?: string;
  hallId?: string;
  locationKind?: string; // shelf | cage
  nazivDela?: string;
  sort?: string;
  desc?: string;
  page?: string;
  pageSize?: string;
}

export interface PredmetTpsQuery {
  onlyOpen?: string;
  includeAssembled?: string;
  tpNo?: string;
  drawingNo?: string;
  locationFilter?: string; // all | with | without
  workOrderId?: string; // opciono → doda op-status panel (loc_get_bigtehn_op_status)
  page?: string;
  pageSize?: string;
}

// ---------- Konstante pariteta 1.0 ----------

/** kind → tipovi lokacije (lokacijeTypes.js HALL/SHELF/CAGE/MACHINE setovi). */
const KIND_TO_TYPES: Record<string, LocTypeEnum[]> = {
  hall: [
    LocTypeEnum.WAREHOUSE,
    LocTypeEnum.PRODUCTION,
    LocTypeEnum.ASSEMBLY,
    LocTypeEnum.FIELD,
    LocTypeEnum.TEMP,
  ],
  shelf: [LocTypeEnum.SHELF, LocTypeEnum.RACK, LocTypeEnum.BIN],
  cage: [LocTypeEnum.CAGE],
  machine: [LocTypeEnum.MACHINE],
};

const LOC_TYPES = new Set<string>(Object.values(LocTypeEnum));
const PLACEMENT_STATUSES = new Set<string>(
  Object.values(LocPlacementStatusEnum),
);
const MOVEMENT_TYPES = new Set<string>(Object.values(LocMovementTypeEnum));

/** Sort kolone koje `loc_report_parts_by_locations` prihvata (REPORT_SORT_WHITELIST). */
const REPORT_SORT_WHITELIST = new Set([
  "updated_at",
  "drawing_no",
  "order_no",
  "location_code",
  "hall_code",
  "qty_on_location",
  "customer_name",
  "project_code",
  "item_ref_id",
  "rok_izrade",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class LocationsService {
  constructor(private readonly sy15: Sy15Service) {}

  // ==========================================================================
  // Lokacije (šifarnik + hijerarhija) — fetchLocations paritet
  // ==========================================================================

  async listLocations(query: ListLocationsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
      1000,
    );
    const where: Prisma.LocLocationWhereInput = {};

    const active = (query.active ?? "true").toLowerCase();
    if (active !== "all" && active !== "false") where.isActive = true;
    else if (active === "false") where.isActive = false;

    const kind = (query.kind ?? "").trim().toLowerCase();
    if (kind && KIND_TO_TYPES[kind])
      where.locationType = { in: KIND_TO_TYPES[kind] };

    const type = (query.type ?? "").trim().toUpperCase();
    if (type && LOC_TYPES.has(type)) where.locationType = type as LocTypeEnum;

    if (query.parentId && UUID_RE.test(query.parentId.trim()))
      where.parentId = query.parentId.trim();

    const q = (query.q ?? "").trim();
    if (q) {
      where.OR = [
        { locationCode: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { pathCached: { contains: q, mode: "insensitive" } },
      ];
    }

    const [data, total] = await Promise.all([
      this.sy15.db.locLocation.findMany({
        where,
        orderBy: { pathCached: "asc" },
        skip,
        take,
      }),
      this.sy15.db.locLocation.count({ where }),
    ]);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findLocation(id: string) {
    const loc = await this.sy15.db.locLocation.findUnique({ where: { id } });
    if (!loc) throw new NotFoundException(`Lokacija ${id} ne postoji`);
    return { data: loc };
  }

  // ==========================================================================
  // Placements (stanje smeštaja) — fetchPlacements / fetchItemPlacements paritet
  // ==========================================================================

  async listPlacements(query: ListPlacementsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
      500,
    );
    // Paritet 1.0 fetchPlacements: glavna lista je scope-ovana na bigtehn_rn.
    const itemRefTable = (query.itemRefTable ?? "bigtehn_rn").trim();
    const where: Prisma.LocItemPlacementWhereInput = { itemRefTable };

    if (query.itemRefId && query.itemRefId.trim())
      where.itemRefId = query.itemRefId.trim();

    if (query.locationId && UUID_RE.test(query.locationId.trim()))
      where.locationId = query.locationId.trim();

    if (typeof query.orderNo === "string") where.orderNo = query.orderNo.trim(); // "" = bez naloga (validna vrednost)

    const status = (query.status ?? "").trim().toUpperCase();
    if (status && PLACEMENT_STATUSES.has(status))
      where.placementStatus = status as LocPlacementStatusEnum;

    const s = (query.search ?? "").trim();
    if (s) {
      where.OR = [
        { itemRefId: { contains: s, mode: "insensitive" } },
        { itemRefTable: { contains: s, mode: "insensitive" } },
        { orderNo: { contains: s, mode: "insensitive" } },
        { drawingNo: { contains: s, mode: "insensitive" } },
      ];
    }

    const [data, total] = await Promise.all([
      this.sy15.db.locItemPlacement.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip,
        take,
      }),
      this.sy15.db.locItemPlacement.count({ where }),
    ]);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  // ==========================================================================
  // Movements (istorija premeštanja) — fetchMovementsHistory paritet
  // Filteri: korisnik / lokacija / tip / nalog / datum (spec §3 — SVI zadržani).
  // ==========================================================================

  async listMovements(query: ListMovementsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
      500,
    );
    const and: Prisma.LocLocationMovementWhereInput[] = [];
    const where: Prisma.LocLocationMovementWhereInput = {};

    const movementType = (query.movementType ?? "").trim().toUpperCase();
    if (movementType && MOVEMENT_TYPES.has(movementType))
      where.movementType = movementType as LocMovementTypeEnum;

    if (query.userId && UUID_RE.test(query.userId.trim()))
      where.movedBy = query.userId.trim();

    if (query.orderNo && query.orderNo.trim())
      where.orderNo = query.orderNo.trim();

    if (query.itemRefId && query.itemRefId.trim()) {
      where.itemRefId = query.itemRefId.trim();
      if (query.itemRefTable && query.itemRefTable.trim())
        where.itemRefTable = query.itemRefTable.trim();
    }

    // Datum: moved_at >= dateFrom 00:00 i < (dateTo + 1 dan) 00:00.
    const movedAt = this.dateRange(query.dateFrom, query.dateTo);
    if (movedAt) where.movedAt = movedAt;

    const s = (query.search ?? "").trim();
    if (s) {
      and.push({
        OR: [
          { itemRefId: { contains: s, mode: "insensitive" } },
          { orderNo: { contains: s, mode: "insensitive" } },
        ],
      });
    }

    // Lokacija: from ILI to (bilo gde u pokretu) — paritet 1.0.
    if (query.locationId && UUID_RE.test(query.locationId.trim())) {
      const id = query.locationId.trim();
      and.push({ OR: [{ fromLocationId: id }, { toLocationId: id }] });
    }
    if (and.length) where.AND = and;

    const [data, total] = await Promise.all([
      this.sy15.db.locLocationMovement.findMany({
        where,
        orderBy: { movedAt: "desc" },
        skip,
        take,
      }),
      this.sy15.db.locLocationMovement.count({ where }),
    ]);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /** `dateFrom`/`dateTo` (YYYY-MM-DD) → Prisma DateTime filter (paritet 1.0). */
  private dateRange(
    dateFrom?: string,
    dateTo?: string,
  ): Prisma.DateTimeFilter | null {
    const from = (dateFrom ?? "").trim();
    const to = (dateTo ?? "").trim();
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const filter: Prisma.DateTimeFilter = {};
    if (ymd.test(from)) filter.gte = new Date(`${from}T00:00:00`);
    if (ymd.test(to)) {
      const d = new Date(`${to}T00:00:00`);
      d.setDate(d.getDate() + 1); // inkluzivan dan → < sledeći dan
      filter.lt = d;
    }
    return filter.gte || filter.lt ? filter : null;
  }

  // ==========================================================================
  // Izveštaj po lokacijama — loc_report_parts_by_locations (12+ filtera) + suggest
  // ==========================================================================

  async reportByLocation(query: ReportByLocationQuery, email: string) {
    const { skip: offset, take } = parsePagination(
      query.page,
      query.pageSize,
      500,
    );

    const drawingNo = this.nonEmpty(query.drawingNo);
    const orderNo = this.nonEmpty(query.orderNo);
    const tpNo = this.nonEmpty(query.tpNo);
    const projectSearch = this.nonEmpty(query.projectSearch);
    const locationId = this.uuidOrNull(query.locationId);
    const locationQ = this.nonEmpty(query.locationQ);
    const hallId = this.uuidOrNull(query.hallId);
    const nazivDela = this.nonEmpty(query.nazivDela);
    const kindRaw = (query.locationKind ?? "").trim().toLowerCase();
    const locationKind =
      kindRaw === "shelf" || kindRaw === "cage" ? kindRaw : null;
    const sortRaw = (query.sort ?? "updated_at").trim().toLowerCase();
    const sort = REPORT_SORT_WHITELIST.has(sortRaw) ? sortRaw : "updated_at";
    const desc = query.desc !== "false";

    // Redosled argumenata = potpis fn-a (snapshot 12.07): p_drawing_no, p_order_no,
    // p_tp_no, p_project_search, p_location_id, p_location_q, p_hall_id,
    // p_location_kind, p_naziv_dela, p_sort, p_desc, p_limit, p_offset.
    const rows = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw<{ result: unknown }[]>`
        SELECT loc_report_parts_by_locations(
          ${drawingNo}::text, ${orderNo}::text, ${tpNo}::text,
          ${projectSearch}::text, ${locationId}::uuid, ${locationQ}::text,
          ${hallId}::uuid, ${locationKind}::text, ${nazivDela}::text,
          ${sort}::text, ${desc}::boolean, ${take}::int, ${offset}::int
        ) AS result`,
    );
    return { data: rows[0]?.result ?? { total: 0, rows: [] } };
  }

  async reportSuggestNazivDela(q: string | undefined, email: string) {
    const query = (q ?? "").trim();
    if (query.length < 2) return { data: [] };
    const rows = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw<{ result: unknown }[]>`
        SELECT loc_report_suggest_naziv_dela(${query}::text, ${15}::int) AS result`,
    );
    return { data: rows[0]?.result ?? [] };
  }

  // ==========================================================================
  // Pregled predmeta — loc_tps_for_predmet (+ opciono loc_get_bigtehn_op_status)
  // ==========================================================================

  async predmetTps(itemIdRaw: string, query: PredmetTpsQuery, email: string) {
    const itemId = Number.parseInt(itemIdRaw, 10);
    if (!Number.isInteger(itemId) || itemId <= 0)
      return { data: { total: 0, rows: [] }, meta: { opStatus: null } };

    const onlyOpen = query.onlyOpen === "true";
    const includeAssembled = query.includeAssembled === "true";
    const tpNo = this.nonEmpty(query.tpNo);
    const drawingNo = this.nonEmpty(query.drawingNo);
    const lf = (query.locationFilter ?? "").trim().toLowerCase();
    const locationFilter = ["with", "without", "all"].includes(lf) ? lf : null;
    const { skip, take: limit } = parsePagination(
      query.page,
      query.pageSize,
      1000,
    );

    const tpsRows = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw<{ result: unknown }[]>`
        SELECT loc_tps_for_predmet(
          ${itemId}::bigint, ${onlyOpen}::boolean, ${includeAssembled}::boolean,
          ${tpNo}::text, ${drawingNo}::text, ${locationFilter}::text,
          ${limit}::int, ${skip}::int
        ) AS result`,
    );
    const data = tpsRows[0]?.result ?? { total: 0, rows: [] };

    // Op-status panel (Faza 1 Mašine × Lokacije) — samo ako je tražen konkretan RN.
    let opStatus: unknown = null;
    const woId = Number.parseInt(query.workOrderId ?? "", 10);
    if (Number.isInteger(woId) && woId > 0) {
      const opRows = await this.sy15.withUser(
        email,
        (tx) => tx.$queryRaw<{ result: unknown }[]>`
          SELECT loc_get_bigtehn_op_status(${woId}::bigint) AS result`,
      );
      opStatus = opRows[0]?.result ?? null;
    }
    return { data, meta: { opStatus } };
  }

  // ==========================================================================
  // Lookups
  // ==========================================================================

  /** Broj predmeta u aktivnim projekt+montaža predmetima — loc_order_no_in_active_proj_mont. */
  async validateOrder(orderNo: string | undefined, email: string) {
    const q = (orderNo ?? "").trim();
    if (!q) return { data: null };
    const rows = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw<{ result: boolean | null }[]>`
        SELECT loc_order_no_in_active_proj_mont(${q}::text) AS result`,
    );
    return { data: rows[0]?.result ?? null };
  }

  /**
   * Razrešavanje skeniranog/otkucanog barkoda → tip + zapis (server-side paritet
   * 1.0 `barcodeParse.js` + `shelfBarcode.js`). Prvo ITEM (RNZ/short/compact) jer
   * ti formati imaju cifru/separator; ako ne prođe → SHELF (LP:/HALA-POLICA/šifra
   * police). `kind:'UNKNOWN'` = format nije prepoznat. Row-vidljivost placements-a
   * (RLS rev_tools) ostaje u bazi.
   */
  async lookupBarcode(raw: string | undefined) {
    const clean = normalizeBarcodeText(raw);
    if (!clean)
      return { data: { kind: "UNKNOWN" as const, parsed: null, records: [] } };

    // 1) ITEM (BigTehn RNZ / short / compact)
    const parsed = parseBigTehnBarcode(clean);
    if (parsed) {
      const records = await this.resolveItemPlacements(
        "bigtehn_rn",
        parsed.orderNo,
        parsed.itemRefId,
        parsed.drawingNo,
      );
      return { data: { kind: "ITEM" as const, parsed, records } };
    }

    // 2) SHELF (polica) — potreban indeks aktivnih lokacija (kao 1.0 scan modal).
    const { locs, locById } = await this.loadActiveLocationIndex();
    const shelf = resolveCompositeShelfScan(clean, locs, locById);
    if (shelf) {
      if (shelf.ok) {
        return {
          data: {
            kind: "SHELF" as const,
            parsed: { format: "shelf", raw: clean },
            record: shelf.loc,
            presetHallFilterId: shelf.presetHallFilterId,
          },
        };
      }
      // Format police prepoznat, ali nije jednoznačno razrešen → poruka pariteta.
      return {
        data: {
          kind: "SHELF" as const,
          parsed: { format: "shelf", raw: clean },
          record: null,
          message: shelf.msg,
        },
      };
    }

    return {
      data: { kind: "UNKNOWN" as const, parsed: null, records: [] },
    };
  }

  /**
   * Trenutni placement-i za par (predmet, TP, crtež) — paritet 1.0
   * `fetchItemPlacementsForPredmetTp`: kanonski ključ + legacy fallback-i.
   * PostgREST iterativni fallback iz 1.0 nije potreban — Prisma OR pokriva sve
   * kombinacije u jednom upitu; završni filter je isti `placementRowMatchesPredmetTp`.
   */
  private async resolveItemPlacements(
    itemRefTable: string,
    orderNo: string,
    tpRef: string,
    drawingNo: string,
  ) {
    const norm = normalizeLocMovementKeys(orderNo, tpRef);
    const o = norm.orderNo;
    const t = norm.itemRefId;
    const dr = (drawingNo ?? "").trim();
    if (!t && !dr) return [];

    const itemIds = [
      ...new Set(
        [t, dr, o && t ? `${o}/${t}` : ""]
          .map((x) => String(x || "").trim())
          .filter(Boolean),
      ),
    ];

    const or: Prisma.LocItemPlacementWhereInput[] = [];
    for (const itemId of itemIds) {
      if (o) or.push({ orderNo: o, itemRefId: itemId });
      or.push({ orderNo: "", itemRefId: itemId });
      or.push({ itemRefId: itemId });
    }
    if (dr) {
      or.push({ drawingNo: dr });
      if (o) or.push({ orderNo: o, drawingNo: dr });
      or.push({ orderNo: "", drawingNo: dr });
    }
    if (!or.length) return [];

    const rows = await this.sy15.db.locItemPlacement.findMany({
      where: { itemRefTable, OR: or },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });

    const byId = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (!r?.id || !placementRowMatchesPredmetTp(r, o, t, dr)) continue;
      byId.set(r.id, r);
    }
    return [...byId.values()].sort((a, b) =>
      String(b.updatedAt.toISOString()).localeCompare(
        a.updatedAt.toISOString(),
      ),
    );
  }

  /** Aktivne lokacije + indeks po id (za shelf resolver — paritet scan modal `state.locs`). */
  private async loadActiveLocationIndex(): Promise<{
    locs: ShelfLoc[];
    locById: Map<string, ShelfLoc>;
  }> {
    const rows = await this.sy15.db.locLocation.findMany({
      where: { isActive: true },
      select: {
        id: true,
        locationCode: true,
        locationType: true,
        parentId: true,
        isActive: true,
      },
      take: 50000,
    });
    const locs: ShelfLoc[] = rows.map((r) => ({
      id: r.id,
      locationCode: r.locationCode,
      locationType: r.locationType,
      parentId: r.parentId,
      isActive: r.isActive,
    }));
    const locById = new Map(locs.map((l) => [l.id, l]));
    return { locs, locById };
  }

  // ==========================================================================
  // Sync (admin) + istorija definicija (manage)
  // ==========================================================================

  /**
   * Admin Sync status — kombinuje ingest status + health summary + heartbeat +
   * poslednji bridge sync po job-u (paritet 1.0 Sync tab; spec §3). Sve kroz GUC
   * (definer/admin fn čitaju identitet).
   */
  async syncStatus(email: string) {
    return this.sy15.withUser(email, async (tx) => {
      const ingest = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT loc_get_bigtehn_ingest_status() AS result`;
      const health = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT loc_sync_health_summary() AS result`;
      const heartbeat =
        await tx.$queryRaw`SELECT * FROM loc_sync_worker_heartbeat`;
      const bridgeRows = await tx.$queryRaw<
        { sync_job: string; finished_at: Date | null; status: string | null }[]
      >`SELECT sync_job, finished_at, status FROM bridge_sync_log
        ORDER BY finished_at DESC LIMIT 200`;

      // Poslednji red po sync_job-u (bridge_sync_log nema GROUP BY kroz PostgREST u
      // 1.0 — agregacija na aplikaciji; ovde je isti pristup radi 1:1 semantike).
      const seen = new Map<
        string,
        { sync_job: string; last_finished: Date | null; status: string | null }
      >();
      for (const r of bridgeRows) {
        if (!r?.sync_job || seen.has(r.sync_job)) continue;
        seen.set(r.sync_job, {
          sync_job: r.sync_job,
          last_finished: r.finished_at,
          status: r.status,
        });
      }

      return {
        data: {
          ingest: ingest[0]?.result ?? null,
          health: health[0]?.result ?? null,
          heartbeat,
          bridge: [...seen.values()],
        },
      };
    });
  }

  /** Admin — outbound MSSQL write-back queue (RLS admin-only → GUC obavezan). */
  async syncOutbound(limitRaw: string | undefined, email: string) {
    const l = Math.max(
      1,
      Math.min(Number.parseInt(limitRaw ?? "80", 10) || 80, 300),
    );
    const data = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw`
        SELECT * FROM loc_sync_outbound_events
        ORDER BY created_at DESC LIMIT ${l}`,
    );
    return { data };
  }

  /** Manage — istorija definisanja/izmena master lokacija (loc_locations_audit). */
  async definitionsAudit(limitRaw: string | undefined, email: string) {
    const l = Math.max(
      1,
      Math.min(Number.parseInt(limitRaw ?? "100", 10) || 100, 300),
    );
    const data = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw`SELECT * FROM loc_locations_audit(${l}::int)`,
    );
    return { data };
  }

  // ---------- helpers ----------

  private nonEmpty(v: string | undefined): string | null {
    const s = (v ?? "").trim();
    return s === "" ? null : s;
  }

  private uuidOrNull(v: string | undefined): string | null {
    const s = (v ?? "").trim().toLowerCase();
    return UUID_RE.test(s) ? s : null;
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  LocMovementTypeEnum,
  LocPlacementStatusEnum,
  LocTypeEnum,
  Prisma,
} from "@prisma-sy15/client";
import { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15Tx } from "../../common/sy15/sy15.service";
import { LabelPrintService } from "../../common/printing/label-print.service";
import type { PrintLabelDto } from "../../common/printing/print-label.dto";
import { pageMeta, parsePagination } from "../../common/pagination";
import {
  normalizeBarcodeText,
  normalizeLocMovementKeys,
  parseBigTehnBarcode,
  placementRowMatchesPredmetTp,
  resolveCompositeShelfScan,
  type ShelfLoc,
} from "./barcode";
import type {
  CageMoveDto,
  CreateLocationDto,
  CreateMovementDto,
  UpdateLocationDto,
} from "./dto/locations-tx.dto";

/** jsonb envelope koji Lokacije mutacione DB fn vraćaju (`{ok, error?, ...}`). */
export interface FnEnvelope {
  ok?: boolean;
  error?: string;
  detail?: string;
  [key: string]: unknown;
}

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

export interface PredmetWorkOrdersQuery {
  onlyOpen?: string; // "true"/"1" → samo otvoreni RN (status_rn = false)
  page?: string;
  pageSize?: string;
}

/**
 * Sirov red iz `v_bigtehn_work_orders_with_mes_active` (podskup kolona koji 1.0
 * `searchBigtehnWorkOrdersForItem` selektuje). bigint/int stižu kao BigInt/number iz
 * `$queryRaw` — mapiraju se u Number pre JSON serializacije (BigInt nije JSON-serializ.).
 */
interface WorkOrderRaw {
  id: bigint | number;
  item_id: bigint | number | null;
  ident_broj: string | null;
  broj_crteza: string | null;
  naziv_dela: string | null;
  materijal: string | null;
  dimenzija_materijala: string | null;
  jedinica_mere: string | null;
  komada: number | null;
  tezina_obr: number | null;
  status_rn: boolean | null;
  revizija: string | null;
  rok_izrade: Date | null;
  is_mes_active: boolean | null;
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

/**
 * Žive `item_ref_table` vrednosti u `loc_item_placements` (whitelist za placements
 * selektor — klijent-kontrolisan param se NE prosleđuje proizvoljno u where).
 * `rev_tools` je dozvoljen ali je ROW-SCOPED (RLS `loc_placements_select` ga krije
 * od ne-manage; zato placements idu kroz `withUserRls`).
 */
const PLACEMENT_ITEM_TABLES = new Set<string>(["bigtehn_rn", "rev_tools"]);

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
  constructor(
    private readonly sy15: Sy15Service,
    private readonly labelPrint: LabelPrintService,
  ) {}

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

  async listPlacements(query: ListPlacementsQuery, email: string) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
      500,
    );
    // Paritet 1.0 fetchPlacements: glavna lista je scope-ovana na bigtehn_rn.
    // itemRefTable je klijent-kontrolisan → whitelist (ne prosleđuj proizvoljnu
    // tabelu u where; jedine žive vrednosti su bigtehn_rn i rev_tools).
    const itemRefTable = (query.itemRefTable ?? "bigtehn_rn").trim();
    if (!PLACEMENT_ITEM_TABLES.has(itemRefTable))
      throw new BadRequestException(
        `Nedozvoljen item_ref_table „${itemRefTable}" (dozvoljeni: ${[
          ...PLACEMENT_ITEM_TABLES,
        ].join(", ")})`,
      );
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

    // ROW-SCOPED tabela: RLS `loc_placements_select` krije `item_ref_table='rev_tools'`
    // od ne-manage (rev_can_manage). `sy15.db` (BYPASSRLS) bi vratio SVE rev_tools
    // redove bilo kome sa `lokacije.read` → MORA kroz `withUserRls` (doktrina A.2a).
    const { data, total } = await this.sy15.withUserRls(email, async (tx) => {
      const rows = await tx.locItemPlacement.findMany({
        where,
        // Stabilan tiebreak (id asc) — updated_at nije jedinstven (bulk-sync grupe
        // istog timestamp-a); bez sekundarnog ključa fetch-all izvoz može duplirati
        // ili preskočiti red na granici offset-strane (paritet 1.0 stabilnog sorta).
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        skip,
        take,
      });
      const count = await tx.locItemPlacement.count({ where });
      return { data: rows, total: count };
    });
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

    const [rows, total] = await Promise.all([
      this.sy15.db.locLocationMovement.findMany({
        where,
        // Stabilan tiebreak (id asc) — moved_at nije jedinstven (bulk-sync grupe
        // istog timestamp-a; živo: grupa od 84 reda); bez sekundarnog ključa fetch-all
        // izvoz može duplirati/preskočiti red na granici offset-strane.
        orderBy: [{ movedAt: "desc" }, { id: "asc" }],
        skip,
        take,
      }),
      this.sy15.db.locLocationMovement.count({ where }),
    ]);
    // „Korisnik" kolona = ime umesto UUID (paritet 1.0): batch-resolve moved_by →
    // ime, dodaj `movedByName` (UUID `movedBy` ostaje — zero-loss; null ako nerazrešiv).
    const names = await this.resolveUserNames(rows.map((r) => r.movedBy));
    const data = rows.map((r) => ({
      ...r,
      movedByName: names.get(r.movedBy) ?? null,
    }));
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
  // Početna KPI — vremenski prozor premeštanja (paritet 1.0 dashboard „danas/7 dana")
  // ==========================================================================

  /**
   * KPI brojači za Početnu (paritet 1.0 `fetchMovementsCountSince`): koliko je
   * premeštanja „danas" i u poslednjih 7 dana. 1.0 koristi KALENDARSKE granice u
   * lokalnoj zoni (Europe/Belgrade): „danas" = od lokalne ponoći, „7 dana" = 7
   * kalendarskih dana (danas + 6 prethodnih), a NE rolling now−24h/now−168h — inače
   * bi „Premeštanja danas" pokazivalo i jučerašnje popodne. Belgrade ponoć se računa
   * preko `Intl` (ne naivni UTC) da bi bila tačna i pri CET/CEST i DST prelazima.
   * Nazivi polja ostaju `movements24h`/`movements7d` (FE ih već čita). Count kroz
   * `sy15.db` (BYPASSRLS): movements nisu row-scoped (za razliku od placements/rev_tools).
   */
  async summary() {
    const now = new Date();
    const startOfToday = this.belgradeStartOfDay(now, 0); // lokalna ponoć danas
    const startOf7d = this.belgradeStartOfDay(now, 6); // ponoć pre 6 dana (7 kal. dana)
    const [movements24h, movements7d] = await Promise.all([
      this.sy15.db.locLocationMovement.count({
        where: { movedAt: { gte: startOfToday } },
      }),
      this.sy15.db.locLocationMovement.count({
        where: { movedAt: { gte: startOf7d } },
      }),
    ]);
    return { data: { movements24h, movements7d } };
  }

  /**
   * UTC instant lokalne ponoći (Europe/Belgrade) za kalendarski dan `daysBack` pre
   * `now`. Radi tačno i preko CET/CEST i DST prelaza jer offset uzima u podne tog
   * dana (podne nikad ne pada na DST prelaz), pa ga oduzme od 00:00. Bez eksterne
   * biblioteke — samo `Intl` (isti pristup kao 1.0 `_ymd` u lokalnoj zoni pregledača,
   * ovde fiksiran na Belgrade jer server može biti u drugoj zoni).
   */
  private belgradeStartOfDay(now: Date, daysBack: number): Date {
    const tz = "Europe/Belgrade";
    // 1) Belgrade kalendarski YYYY-MM-DD za `now` (en-CA daje ISO oblik).
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(now)
      .split("-")
      .map(Number);
    // 2) pomeri unazad `daysBack` kalendarskih dana (UTC matematika hvata prelaze meseca/godine).
    const shifted = new Date(Date.UTC(y, m - 1, d - daysBack));
    const yy = shifted.getUTCFullYear();
    const mm = shifted.getUTCMonth() + 1;
    const dd = shifted.getUTCDate();
    // 3) offset zone u podne tog dana → primeni na 00:00 da dobiješ UTC instant ponoći.
    const offMin = this.tzOffsetMinutes(new Date(Date.UTC(yy, mm - 1, dd, 12)), tz);
    return new Date(Date.UTC(yy, mm - 1, dd) - offMin * 60_000);
  }

  /** Offset zone (min) u datom UTC instantu: (lokalni zidni sat − UTC). CEST=+120, CET=+60. */
  private tzOffsetMinutes(instant: Date, tz: string): number {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? "0");
    const asUtc = Date.UTC(
      g("year"),
      g("month") - 1,
      g("day"),
      g("hour") % 24,
      g("minute"),
      g("second"),
    );
    return (asUtc - instant.getTime()) / 60_000;
  }

  /**
   * Puna lista movera za „Korisnik" filter u istoriji premeštanja (paritet 1.0
   * `loadHistoryUsers`): `SELECT DISTINCT moved_by` nad CELIM `loc_location_movements`
   * + razrešeno ime (isti put kao `movedByName`). FE je ranije punio dropdown iz
   * učitane strane (prvih 500) pa je tiho gubio starije/ređe movere. Sort po imenu
   * (fallback UUID). Movements NISU row-scoped → `sy15.db` (BYPASSRLS).
   */
  async movementMovers(): Promise<{ data: { id: string; name: string | null }[] }> {
    const rows = await this.sy15.db.$queryRaw<{ moved_by: string }[]>(
      Prisma.sql`SELECT DISTINCT moved_by
                 FROM public.loc_location_movements
                 WHERE moved_by IS NOT NULL`,
    );
    const ids = [...new Set(rows.map((r) => r.moved_by).filter(Boolean))];
    const names = await this.resolveUserNames(ids);
    const data = ids
      .map((id) => ({ id, name: names.get(id) ?? null }))
      .sort((a, b) =>
        (a.name ?? a.id).localeCompare(b.name ?? b.id, "sr", {
          sensitivity: "base",
        }),
      );
    return { data };
  }

  /**
   * Batch-resolve auth uid → prikazno ime (paritet 1.0 „Korisnik" kolone). Primarno
   * `user_roles` po `user_id` (full_name → email); fallback `auth.users.email` za
   * movere kojih nema u user_roles (legacy/servisni nalozi). Vraća Map(uid → ime);
   * nerazrešeni uid-ovi se izostave (poziv-mesto zadrži UUID fallback — zero-loss).
   * Sve kroz `sy15.db` (BYPASSRLS `servosync2_app` ima SELECT na auth.users — isti
   * put kao `Sy15Service.setClaims`); imena movera nisu row-scoped PII.
   */
  private async resolveUserNames(
    uids: (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(uids.filter((x): x is string => !!x && UUID_RE.test(x))),
    ];
    const out = new Map<string, string>();
    if (!ids.length) return out;

    const roles = await this.sy15.db.userRoleSy15.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, fullName: true, email: true },
      orderBy: { createdAt: "asc" },
    });
    for (const r of roles) {
      if (!r.userId || out.has(r.userId)) continue;
      const label = (r.fullName ?? "").trim() || (r.email ?? "").trim();
      if (label) out.set(r.userId, label);
    }

    const missing = ids.filter((id) => !out.has(id));
    if (missing.length) {
      try {
        const rows = await this.sy15.db.$queryRaw<
          { id: string; email: string | null }[]
        >(
          Prisma.sql`SELECT id::text AS id, email FROM auth.users
                     WHERE id IN (${Prisma.join(missing.map((m) => Prisma.sql`${m}::uuid`))})`,
        );
        for (const r of rows) {
          const email = (r.email ?? "").trim();
          if (r.id && email && !out.has(r.id)) out.set(r.id, email);
        }
      } catch {
        /* auth.users nedostupan (privilegije) → izostavi; UUID fallback na FE-u. */
      }
    }
    return out;
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

  /**
   * SVI radni nalozi (RN) za jedan predmet — paritet 1.0
   * `searchBigtehnWorkOrdersForItem` (batch nalepnice / picker koji traži CEO BigTehn
   * spisak, ne samo MES-aktivne). Izvor: `v_bigtehn_work_orders_with_mes_active`
   * FILTRIRAN SAMO po `item_id` — BEZ `is_mes_active` predikata (za razliku od
   * `loc_tps_for_predmet`/`v_active_bigtehn_work_orders` koji gube ~77% RN). `status_rn`
   * filter se primenjuje SAMO kad `onlyOpen=1` (status_rn = false = otvoren u kešu).
   * Sort `ident_broj asc, id asc` = 1.0 (stabilna offset paginacija). WO cache NIJE
   * row-scoped (RLS „read for authenticated USING true") → `sy15.db` (BYPASSRLS); HTTP
   * guard `lokacije.read` je autorizacija.
   */
  async predmetWorkOrders(itemIdRaw: string, query: PredmetWorkOrdersQuery) {
    const itemId = Number.parseInt(itemIdRaw, 10);
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
      1000, // paritet 1.0 hard limit po upitu (predmet 9400 ima 800+ RN)
    );
    if (!Number.isInteger(itemId) || itemId <= 0)
      return { data: [], meta: pageMeta(page, pageSize, 0) };

    const onlyOpen = query.onlyOpen === "true" || query.onlyOpen === "1";
    const statusFilter = onlyOpen
      ? Prisma.sql`AND w.status_rn IS FALSE`
      : Prisma.empty;
    const whereSql = Prisma.sql`WHERE w.item_id = ${itemId}::bigint ${statusFilter}`;

    const [rows, totalRows] = await Promise.all([
      this.sy15.db.$queryRaw<WorkOrderRaw[]>(Prisma.sql`
        SELECT w.id, w.item_id, w.ident_broj, w.broj_crteza, w.naziv_dela,
               w.materijal, w.dimenzija_materijala, w.jedinica_mere, w.komada,
               w.tezina_obr, w.status_rn, w.revizija, w.rok_izrade, w.is_mes_active
        FROM public.v_bigtehn_work_orders_with_mes_active w
        ${whereSql}
        ORDER BY w.ident_broj ASC, w.id ASC
        LIMIT ${take}::int OFFSET ${skip}::int`),
      this.sy15.db.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*)::bigint AS count
        FROM public.v_bigtehn_work_orders_with_mes_active w
        ${whereSql}`),
    ]);

    const total = Number(totalRows[0]?.count ?? 0);
    const data = rows.map((r) => ({
      workOrderId: Number(r.id),
      itemId: r.item_id == null ? null : Number(r.item_id),
      identBroj: r.ident_broj,
      crtez: r.broj_crteza,
      nazivDela: r.naziv_dela,
      materijal: r.materijal,
      dimenzijaMaterijala: r.dimenzija_materijala,
      jedinicaMere: r.jedinica_mere,
      komada: r.komada == null ? null : Number(r.komada),
      tezinaObr: r.tezina_obr == null ? null : Number(r.tezina_obr),
      statusRn: r.status_rn,
      revizija: r.revizija,
      rokIzrade: r.rok_izrade ? r.rok_izrade.toISOString() : null,
      isMesActive: r.is_mes_active,
    }));
    return { data, meta: pageMeta(page, pageSize, total) };
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
  async lookupBarcode(email: string, raw: string | undefined) {
    const clean = normalizeBarcodeText(raw);
    if (!clean)
      return { data: { kind: "UNKNOWN" as const, parsed: null, records: [] } };

    // 1) ITEM (BigTehn RNZ / short / compact)
    const parsed = parseBigTehnBarcode(clean);
    if (parsed) {
      const records = await this.resolveItemPlacements(
        email,
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
    email: string,
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

    // Row-scoped tabela (rev_tools scope) → withUserRls, kao listPlacements
    // (ovde je itemRefTable uvek 'bigtehn_rn', ali RLS mora da se evaluira).
    const rows = await this.sy15.withUserRls(email, (tx) =>
      tx.locItemPlacement.findMany({
        where: { itemRefTable, OR: or },
        orderBy: { updatedAt: "desc" },
        take: 200,
      }),
    );

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
      const bridge = await this.loadBridgeLatest(tx);

      return {
        data: {
          ingest: ingest[0]?.result ?? null,
          health: health[0]?.result ?? null,
          heartbeat,
          bridge,
        },
      };
    });
  }

  /**
   * LOK-P3: READ-ONLY sažetak zdravlja sync-a za SVE uloge modula (`lokacije.read`)
   * — BEZ admin detalja (watermark/samples/heartbeat payload). Vraća samo boolove:
   *   - `cacheStale.{rn,linije,tp,predmeti,crtezi}` — po pragovima 1.0
   *     (renderBridgeStaleBanner, index.js:255-292): RN/linije/TP 6h, predmeti 36h,
   *     crteži 7d; `true` = zastareo (ili nikad završen sync).
   *   - `workerHealthy` — 1.0 renderSyncWorkerBanner logika: nijedan worker
   *     `is_alive=false` (heartbeat <10min) I `dead_letter_count=0`.
   * Cilj: ne-admin (magacioner/cnc) da VIDI upozorenja iz bannera (audit L-06/L-07),
   * a da mu se ne otkrivaju admin interne (Sync tab). Reuse istih upita kao syncStatus.
   */
  async syncHealth(email: string) {
    return this.sy15.withUser(email, async (tx) => {
      const health = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT loc_sync_health_summary() AS result`;
      const bridge = await this.loadBridgeLatest(tx);

      // cacheStale po sync_job pragovima (paritet 1.0 renderBridgeStaleBanner).
      const STALE_MS: Record<string, number> = {
        production_work_orders: 6 * 3600 * 1000,
        production_work_order_lines: 6 * 3600 * 1000,
        production_tech_routing: 6 * 3600 * 1000,
        catalog_items: 36 * 3600 * 1000,
      };
      const now = Date.now();
      const lastFinished = new Map(
        bridge.map((b) => [b.sync_job, b.last_finished]),
      );
      // `true` = zastareo: nema uspešnog sync-a ili je stariji od praga (fail-safe:
      // odsustvo reda tretiramo kao zastarelost, kao što 1.0 baner „ne vidi svež").
      const isStale = (job: string): boolean => {
        const finished = lastFinished.get(job);
        const t = finished ? new Date(finished).getTime() : NaN;
        if (!Number.isFinite(t)) return true;
        return now - t > STALE_MS[job];
      };
      const cacheStale = {
        rn: isStale("production_work_orders"),
        linije: isStale("production_work_order_lines"),
        tp: isStale("production_tech_routing"),
        predmeti: isStale("catalog_items"),
        // B1 loc-most: drawings sync je penzionisan (2.0 drawing_pdfs je vlasnik
        // crteža) — prag bi bio večno „stale" i pravio lažni baner.
        crtezi: false,
      };

      // workerHealthy — paritet 1.0 renderSyncWorkerBanner: down = is_alive===false.
      // B1 loc-most: outbound MSSQL worker (`loc-sync-mssql`) je penzionisan — ako mu
      // heartbeat red još postoji, ne sme da obara zdravlje; broji se samo ingest.
      const summary = (health[0]?.result ?? null) as {
        workers?: { worker_id?: string; is_alive?: boolean }[];
        dead_letter_count?: number | string | null;
      } | null;
      const workers = Array.isArray(summary?.workers) ? summary!.workers : [];
      const anyDown = workers.some(
        (w) => w && w.worker_id !== "loc-sync-mssql" && w.is_alive === false,
      );
      const deadCount = Number(summary?.dead_letter_count) || 0;
      const workerHealthy = !anyDown && deadCount === 0;

      return { data: { cacheStale, workerHealthy } };
    });
  }

  /**
   * Poslednji red `bridge_sync_log` po `sync_job`-u (bridge_sync_log nema GROUP BY
   * kroz PostgREST u 1.0 — agregacija na aplikaciji; isti pristup radi 1:1 semantike).
   * Deljeno između `syncStatus` (admin) i `syncHealth` (svi).
   */
  private async loadBridgeLatest(
    tx: Sy15Tx,
  ): Promise<
    { sync_job: string; last_finished: Date | null; status: string | null }[]
  > {
    const bridgeRows = await tx.$queryRaw<
      { sync_job: string; finished_at: Date | null; status: string | null }[]
    >`SELECT sync_job, finished_at, status FROM bridge_sync_log
      ORDER BY finished_at DESC LIMIT 200`;
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
    return [...seen.values()];
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
    // 🔴 PLK-01: `loc_locations_audit` RETURNS `id bigint` → Prisma $queryRaw
    // vraća BigInt, koji NestJS ne ume da serijalizuje (BigInt nije JSON-serializ.)
    // → svaki poziv sa realnim redovima obarao je response u 500 (a ne DB-drift:
    // fn i audit_log su usklađeni). Konvertujemo BigInt → Number pre serijalizacije
    // (isti obrazac kao WorkOrderRaw §125) i, kao mutacije, obmotavamo try/catch-em
    // (rethrowMutation) da DB/kontekst greška postane čist 4xx umesto 500.
    try {
      const rows = await this.sy15.withUser(
        email,
        (tx) =>
          tx.$queryRaw<
            Record<string, unknown>[]
          >`SELECT * FROM loc_locations_audit(${l}::int)`,
      );
      // „Korisnik" = ime umesto UUID (paritet 1.0): actor_uid → ime; fn već vraća
      // actor_email pa je to zadnji fallback. Dodaj `actor_name` (actor_uid/email ostaju).
      const names = await this.resolveUserNames(
        rows.map((r) => (typeof r.actor_uid === "string" ? r.actor_uid : null)),
      );
      const data = rows.map((r) => {
        const uid = typeof r.actor_uid === "string" ? r.actor_uid : null;
        const email2 =
          typeof r.actor_email === "string" && r.actor_email.trim()
            ? r.actor_email.trim()
            : null;
        return {
          ...this.jsonSafe(r),
          actor_name: (uid && names.get(uid)) || email2 || null,
        };
      });
      return { data };
    } catch (e) {
      this.rethrowMutation(e);
    }
  }

  /**
   * BigInt → Number u plitkom redu iz `$queryRaw` (BigInt nije JSON-serializ.,
   * PLK-01). Vrednosti su ID-jevi u sigurnom Number opsegu; jsonb/text[]/Date
   * ostaju netaknuti. Isti razlog kao napomena uz `WorkOrderRaw`.
   */
  private jsonSafe(
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === "bigint" ? Number(v) : v;
    }
    return out;
  }

  // ==========================================================================
  // R2: MUTACIJE (MODULE_SPEC_lokacije_30.md §3, parity §5 stavke 3/4/6/12/14)
  // Lokacije mutacione DB fn (loc_create_movement/loc_move_cage/loc_bigtehn_ingest_*)
  // NE bacaju SQLSTATE — vraćaju jsonb envelope `{ok, error?}` (unwrapEnvelope →
  // 401/403/404/422). CRUD ide direktno Prisma-om kroz withUser (RLS bypass, ali GUC
  // claims su OBAVEZNI: audit triger `audit_row_change` čita auth.jwt()/auth.uid();
  // BEFORE trigeri računaju path_cached/depth i sprovode hijerarhiju) — greške mapira
  // rethrowMutation. Autorizacija je dvoslojna: HTTP guard (lokacije.move/manage/admin)
  // + DB row-odluka (loc_can_create_movement/loc_can_manage_locations/loc_is_admin).
  // ==========================================================================

  /** Kavez/hala nedostaju → 404 (ostali cage/hall envelope errori su 422). */
  private static readonly CAGE_NOT_FOUND: ReadonlySet<string> = new Set([
    "cage_not_found",
    "hall_not_found",
  ]);
  private static readonly EMPTY_SET: ReadonlySet<string> = new Set<string>();

  /**
   * Pokret (SVE tipove) — `loc_create_movement(jsonb)` kroz GUC most. Payload = 1:1
   * paritet 1.0 jsonb (snake_case ključevi). Idempotencija je NATIVNA: DB fn proverava
   * `client_event_uuid` (UNIQUE) i na replay/23505 vraća `{ok:true, id, idempotent:true}`
   * BEZ dupliranja pokreta — zato ovde NEMA rev_api_idempotency (doktrina A4).
   */
  async createMovement(email: string, dto: CreateMovementDto) {
    const payload: Record<string, unknown> = {
      client_event_uuid: dto.clientEventUuid,
      item_ref_table: dto.itemRefTable,
      item_ref_id: dto.itemRefId,
      movement_type: dto.movementType,
    };
    if (dto.orderNo !== undefined) payload.order_no = dto.orderNo;
    if (dto.drawingNo !== undefined) payload.drawing_no = dto.drawingNo;
    if (dto.quantity !== undefined) payload.quantity = dto.quantity;
    if (dto.toLocationId !== undefined)
      payload.to_location_id = dto.toLocationId;
    if (dto.fromLocationId !== undefined)
      payload.from_location_id = dto.fromLocationId;
    if (dto.movementReason !== undefined)
      payload.movement_reason = dto.movementReason;
    if (dto.note !== undefined) payload.note = dto.note;
    if (dto.movedAt !== undefined) payload.moved_at = dto.movedAt;

    const result = await this.sy15.withUser(email, async (tx) => {
      // fnName je fiksan literal (ne korisnički unos) — payload ide kao $1 bind.
      const rows = await tx.$queryRawUnsafe<{ result: FnEnvelope }[]>(
        "SELECT loc_create_movement($1::jsonb) AS result",
        JSON.stringify(payload),
      );
      return rows[0]?.result ?? null;
    });
    const env = this.unwrapEnvelope(result);
    return { data: env, meta: { idempotent: env.idempotent === true } };
  }

  /** Premeštaj kaveza u drugu halu — `loc_move_cage` (manage: loc_can_manage_locations). */
  async moveCage(email: string, dto: CageMoveDto) {
    const result = await this.sy15.withUser(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: FnEnvelope }[]>`
        SELECT loc_move_cage(
          ${dto.cageId}::uuid, ${dto.newHallId}::uuid, ${dto.reason ?? null}::text
        ) AS result`;
      return rows[0]?.result ?? null;
    });
    return {
      data: this.unwrapEnvelope(result, LocationsService.CAGE_NOT_FOUND),
    };
  }

  /** Nova master lokacija (Prisma INSERT; paritet 1.0 createLocation, is_active=true). */
  async createLocation(email: string, dto: CreateLocationDto) {
    try {
      const data = await this.sy15.withUser(email, (tx) =>
        tx.locLocation.create({
          data: {
            locationCode: dto.locationCode.trim(),
            name: dto.name.trim(),
            locationType: dto.locationType as LocTypeEnum,
            parentId: dto.parentId ?? null,
            capacityNote: dto.capacityNote ?? null,
            notes: dto.notes ?? null,
            isActive: true,
          },
        }),
      );
      return { data };
    } catch (e) {
      this.rethrowMutation(e);
    }
  }

  /** Izmena master lokacije (Prisma UPDATE; SAMO 1.0-editabilna polja). */
  async updateLocation(email: string, id: string, dto: UpdateLocationDto) {
    const data: Prisma.LocLocationUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.locationType !== undefined)
      data.locationType = dto.locationType as LocTypeEnum;
    if (dto.parentId !== undefined) data.parentId = dto.parentId; // može null (koren)
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.capacityNote !== undefined) data.capacityNote = dto.capacityNote;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (Object.keys(data).length === 0)
      throw new BadRequestException("PATCH bez ijednog polja za izmenu");

    try {
      const updated = await this.sy15.withUser(email, (tx) =>
        tx.locLocation.update({ where: { id }, data }),
      );
      return { data: updated };
    } catch (e) {
      this.rethrowMutation(e);
    }
  }

  /** Sync: arm/disarm bigtehn ingest worker — `loc_bigtehn_ingest_arm` (admin). */
  async syncArm(email: string, armed: boolean) {
    const result = await this.sy15.withUser(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: FnEnvelope }[]>`
        SELECT loc_bigtehn_ingest_arm(${armed}::boolean) AS result`;
      return rows[0]?.result ?? null;
    });
    return { data: this.unwrapEnvelope(result) };
  }

  /** Sync: ručno okidanje ingest-a — `loc_bigtehn_ingest_run_now` (admin). */
  async syncRunNow(email: string) {
    const result = await this.sy15.withUser(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: FnEnvelope }[]>`
        SELECT loc_bigtehn_ingest_run_now() AS result`;
      return rows[0]?.result ?? null;
    });
    return { data: this.unwrapEnvelope(result) };
  }

  /**
   * Štampa nalepnica (police + TP) — REUSE deljenog 2.0 TSPL2 transporta
   * (`LabelPrintService`, isti koji koristi Tehnologija). Front (R3) gradi TSPL2 u
   * 1.0 formatu (shelf: `LP:`/„ŠIF_HALE - ŠIF_POLICE`); backend samo prosleđuje RAW.
   */
  async printLabel(dto: PrintLabelDto) {
    return { data: await this.labelPrint.printRawTspl(dto) };
  }

  /**
   * jsonb envelope `{ok, error?}` → HTTP semantika. `not_authenticated`→401,
   * `not_authorized`/`not_admin`/`no_role`→403, navedeni „not_found" errori→404,
   * sve ostalo (poslovna/validaciona greška DB fn) → 422.
   */
  private unwrapEnvelope(
    result: FnEnvelope | null,
    notFound: ReadonlySet<string> = LocationsService.EMPTY_SET,
  ): FnEnvelope {
    if (!result || typeof result !== "object")
      throw new UnprocessableEntityException(
        "DB funkcija nije vratila rezultat",
      );
    if (result.ok === true) return result;

    const error = typeof result.error === "string" ? result.error : "unknown";
    const scalar = (v: unknown): string =>
      typeof v === "number" || typeof v === "string" || typeof v === "boolean"
        ? String(v)
        : JSON.stringify(v);
    let msg =
      typeof result.detail === "string" ? `${error}: ${result.detail}` : error;
    if (error === "insufficient_quantity" && result.available !== undefined)
      msg = `${error} (dostupno ${scalar(result.available)}, traženo ${scalar(result.requested)})`;

    if (error === "not_authenticated") throw new UnauthorizedException(msg);
    if (
      error === "not_authorized" ||
      error === "not_admin" ||
      error === "no_role"
    )
      throw new ForbiddenException(msg);
    if (notFound.has(error)) throw new NotFoundException(msg);
    throw new UnprocessableEntityException(msg);
  }

  /** Prisma/PG greška iz CRUD-a → HTTP (unique→409, not_found→404, triger/FK→422). */
  private rethrowMutation(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2002")
        throw new ConflictException(
          "location_code već postoji (jedinstvena šifra)",
        );
      if (e.code === "P2025")
        throw new NotFoundException("Lokacija ne postoji");
      // FK (P2003) / raw DB constraint (P2010) / ostalo znano = poslovna greška.
      throw new UnprocessableEntityException(this.dbMessage(e));
    }
    // Triger RAISE EXCEPTION (hijerarhija/ciklus) stiže kao Unknown/Validation.
    if (
      e instanceof Prisma.PrismaClientUnknownRequestError ||
      e instanceof Prisma.PrismaClientValidationError
    ) {
      throw new UnprocessableEntityException(this.dbMessage(e));
    }
    // Reversi obrazac: SQLSTATE iz $queryRaw (defanzivno, ako se ikad koristi).
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const code = meta?.code;
    const message = meta?.message ?? this.dbMessage(e);
    if (code === "42501") throw new ForbiddenException(message);
    if (code === "23505") throw new ConflictException(message);
    if (code === "P0001" || code === "23514" || code === "23503")
      throw new UnprocessableEntityException(message);
    throw e;
  }

  /** Poslednji neprazan red Prisma poruke (DB tekst trigera) — čist 422 message. */
  private dbMessage(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return lines[lines.length - 1] ?? raw;
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

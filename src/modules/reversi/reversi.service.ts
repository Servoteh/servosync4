import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { LabelPrintService } from "../../common/printing/label-print.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import type {
  JsonPayloadTxDto,
  SeedStockDto,
  StockDeltaDto,
  TxBaseDto,
  WriteOffDto,
} from "./dto/reversi-tx.dto";
import type { BulkToolRowDto } from "./dto/reversi-bulk.dto";
import type {
  CuttingToolCreateDto,
  CuttingToolUpdateDto,
} from "./dto/reversi-cutting.dto";
import type {
  AddSubgroupDto,
  AddSubsubgroupDto,
  CreateToolDto,
  ReversiPrintLabelDto,
  UpdateToolDto,
} from "./dto/reversi-inventory.dto";
import type {
  CreateBatteryDto,
  CreateMachineHeadDto,
  CreateServiceDto,
  UpdateBatteryDto,
  UpdateMachineHeadDto,
  UpdateServiceDto,
} from "./dto/reversi-detail.dto";

/**
 * Reversi — 3.0 PILOT, R1 read sloj (MODULE_SPEC_reversi.md §4/§9).
 * Podaci žive u sy15 (1.0) bazi (spec §0); ovaj servis samo ČITA:
 *  - tabele kroz Prisma (`prisma/sy15.prisma`, bez FK relacija — 1.0 šema ih nema,
 *    spajanja su ručna batch-resolve),
 *  - view-ove kroz $queryRaw (view-ovi ostaju u bazi — paritet 1:1 sa 1.0 frontom),
 *  - „moje/tim" preglede kroz GUC most (`Sy15Service.withUser`) jer view/fn u bazi
 *    čitaju identitet iz `auth.jwt()` (rev_current_employee_id, get_team_issued_tools).
 * Mutacije (issue/return/otpis/inventar) su R2 — idu kao pozivi postojećih DB fn u tx.
 */

export interface ListDocumentsQuery {
  status?: string;
  /** CSV lista statusa (paritet 1.0 `statuses[]`) — ima prednost nad `status`. */
  statuses?: string;
  /** `'true'` → OPEN/PARTIALLY_RETURNED sa isteklim rokom (RB-20 „Rok istekao"). */
  overdue?: string;
  docType?: string;
  /** ISO — `issued_at >=` (RB-19 filter meseca izdavanja, UTC početak meseca). */
  issuedFrom?: string;
  /** ISO — `issued_at <=` (RB-19 UTC kraj meseca). */
  issuedTo?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

/** Kontekst-filteri za KPI karticu „Primaoci (aktivno)" (RB-16). */
export interface RecipientCardinalityQuery {
  docType?: string;
  issuedFrom?: string;
  issuedTo?: string;
  q?: string;
}

export interface ListToolsQuery {
  status?: string;
  subgroupId?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

export interface LedgerQuery {
  toolId?: string;
  page?: string;
  pageSize?: string;
}

/**
 * Magacionerski izveštaj potrošnje (RA-39/40/41 — paritet 1.0 `fetchConsumptionReport`).
 * Period + tip pokreta iz obogaćenog ledgera (`v_rev_stock_ledger_detail`).
 */
export interface ConsumptionReportQuery {
  /** 'YYYY-MM-DD' — `created_at >=` (FE default = 1. tekućeg meseca). */
  from?: string;
  /** 'YYYY-MM-DD' — `created_at <= to 23:59:59` (uključuje ceo `to` dan). */
  to?: string;
  /** ISSUE | WRITE_OFF | RECEIPT | RETURN | ADJUST | ALL (ALL/prazno = bez filtera tipa). */
  reason?: string;
  /** Fetch-all obrazac (R1): jedan poziv do `limit` redova; FE agregira + CSV. */
  limit?: string;
}

/**
 * Lista pojedinačnih jedinica inventara (RA-14/16/17/13/15/18/23 — paritet 1.0
 * `fetchTools`). Server-side status filter + kaskadni klasifikacioni filteri +
 * sort (allowlist) + paginacija; svaki red nosi zaduženje/lokaciju.
 */
export interface InventoryUnitsQuery {
  status?: string;
  q?: string;
  groupCode?: string;
  subgroupId?: string;
  subsubgroupId?: string;
  sort?: string;
  dir?: string;
  page?: string;
  pageSize?: string;
}

/** Sort allowlist za jedinice (paritet 1.0 `FETCH_TOOLS_SORTABLE`). */
const UNIT_SORTABLE: Record<
  string,
  "oznaka" | "naziv" | "status" | "createdAt"
> = {
  oznaka: "oznaka",
  naziv: "naziv",
  status: "status",
  created_at: "createdAt",
  createdAt: "createdAt",
};

/** Dokument-statusi koji drže jedinicu „na reversu" (paritet 1.0 issuedByTool). */
const OPEN_DOC_STATUSES = new Set(["OPEN", "PARTIALLY_RETURNED"]);

/** Sirovi red iz `v_rev_my_issued_cutting_tools` ($queryRaw → snake_case + float8 qty). */
interface CuttingOpenLineRow {
  line_id: string;
  document_id: string;
  doc_number: string;
  catalog_id: string;
  barcode: string | null;
  oznaka: string;
  naziv: string;
  quantity: number;
  returned_quantity: number;
  remaining_quantity: number;
  unit: string;
  recipient_machine_code: string | null;
  issued_at: Date;
  expected_return_date: Date | null;
  line_status: string;
  document_status: string;
}

/** Allowlist sort/filter pariteta iz 1.0 (`FETCH_TOOLS_SORTABLE`) — proširuje se u R3 po potrebi UI-ja. */
const TOOL_STATUSES = new Set(["active", "scrapped", "lost"]);

@Injectable()
export class ReversiService {
  constructor(
    private readonly sy15: Sy15Service,
    private readonly labelPrint: LabelPrintService,
  ) {}

  // ---------- Dokumenti (reversi) ----------

  /**
   * Lista revers dokumenata (RB-15/22) sa server-side filterima pariteta 1.0
   * `fetchDocuments` + `docFetchParamsFromUi`:
   *   - status: `overdue` > `statuses[]` (CSV) > `status` (`ALL` = bez filtera) —
   *     RB-19/20 (segment + „Rok istekao" = OPEN/PARTIALLY sa `expected_return_date < danas`),
   *   - `issuedFrom`/`issuedTo` (RB-19 mesec, UTC opseg), `docType` (RB-21), `q` (pretraga),
   *   - `lineCount` po dokumentu (RB-22 kolona „Stavki" + RB-25 CSV) — jedan groupBy.
   * KPI kartice (RB-16 Aktivna/Prekoračen/Vraćeno/Otkazano) FE računa iz `meta.total`
   * ovih poziva (pageSize=1 po statusu/overdue); „Primaoci (aktivno)" = recipientCardinality.
   */
  async listDocuments(query: ListDocumentsQuery) {
    // maxSize=500: Mapa (RA-47/48) i workbench povlače do 500 aktivnih dokumenata u
    // jednom pozivu (paritet 1.0 `fetchDocuments({ limit: 500 })`) za kartice mašina
    // i „Aging" donut. R4 Zaduženja panel traži ≤50/str → default ponašanje netaknuto.
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
      500,
    );
    const where = this.buildDocumentWhere(query);
    const [docs, total] = await Promise.all([
      this.sy15.db.revDocument.findMany({
        where,
        orderBy: { issuedAt: "desc" },
        skip,
        take,
      }),
      this.sy15.db.revDocument.count({ where }),
    ]);
    // RB-22/25: broj stavki po dokumentu (kolona „Stavki" + CSV) — jedan agregat.
    const ids = docs.map((d) => d.id);
    const counts = ids.length
      ? await this.sy15.db.revDocumentLine.groupBy({
          by: ["documentId"],
          where: { documentId: { in: ids } },
          _count: { _all: true },
        })
      : [];
    const countById = new Map(counts.map((c) => [c.documentId, c._count._all]));
    const data = docs.map((d) => ({
      ...d,
      lineCount: countById.get(d.id) ?? 0,
    }));
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /** Zajednički WHERE za listu i KPI count-ove (paritet 1.0 docFetchParamsFromUi). */
  private buildDocumentWhere(
    query: ListDocumentsQuery,
  ): Prisma.RevDocumentWhereInput {
    const where: Prisma.RevDocumentWhereInput = {};
    // Redosled prednosti (1.0): overdue → statuses[] → status (ALL = bez filtera).
    if (query.overdue === "true") {
      // „Rok istekao": OPEN/PARTIALLY_RETURNED sa `expected_return_date` STROGO pre
      // današnjeg dana (dok dospeva danas NIJE prekoračen — paritet 1.0 `lt.${today}`).
      const today = new Date(new Date().toISOString().slice(0, 10));
      where.status = { in: ["OPEN", "PARTIALLY_RETURNED"] };
      where.expectedReturnDate = { lt: today };
    } else {
      const multi = (query.statuses ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (multi.length > 0) where.status = { in: multi };
      else if (query.status && query.status !== "ALL")
        where.status = query.status;
    }
    if (query.docType) where.docType = query.docType;
    const from = query.issuedFrom?.trim();
    const to = query.issuedTo?.trim();
    if (from || to) {
      where.issuedAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }
    if (query.q) {
      where.OR = [
        { docNumber: { contains: query.q, mode: "insensitive" } },
        { recipientEmployeeName: { contains: query.q, mode: "insensitive" } },
        { recipientDepartment: { contains: query.q, mode: "insensitive" } },
        { recipientCompanyName: { contains: query.q, mode: "insensitive" } },
      ];
    }
    return where;
  }

  /**
   * Broj RAZLIČITIH primalaca na aktivnim (OPEN/PARTIALLY_RETURNED) dokumentima
   * — KPI kartica „Primaoci (aktivno)" (RB-16). Paritet 1.0
   * `fetchOpenRecipientCardinality`, ali tačan `COUNT(DISTINCT …)` u jednom upitu
   * (bez klijentskog cap-a/uzorka → `truncated` uvek false). Ključ primaoca:
   * EMPLOYEE→id, DEPARTMENT→naziv, inače firma, pa odeljenje (isti prioritet kao 1.0).
   */
  async recipientCardinality(query: RecipientCardinalityQuery) {
    const conds: Prisma.Sql[] = [
      Prisma.sql`status IN ('OPEN', 'PARTIALLY_RETURNED')`,
    ];
    const from = query.issuedFrom?.trim();
    const to = query.issuedTo?.trim();
    if (from) conds.push(Prisma.sql`issued_at >= ${new Date(from)}`);
    if (to) conds.push(Prisma.sql`issued_at <= ${new Date(to)}`);
    // R4-REG-02 — isti passthrough kao `buildDocumentWhere` (lista + 4 count-a): svaki
    // `docType` filtrira, ne samo TOOL/COOPERATION_GOODS — inače bi pri proširenju
    // filtera tipa (npr. CUTTING_TOOL) ova KPI kartica tiho ignorisala tip. Parametrizovan
    // SQL (bind), pa je passthrough bezbedan i za buduće vrednosti.
    if (query.docType) conds.push(Prisma.sql`doc_type = ${query.docType}`);
    const q = query.q?.trim();
    if (q) {
      const like = `%${q}%`;
      conds.push(Prisma.sql`(doc_number ILIKE ${like}
        OR recipient_employee_name ILIKE ${like}
        OR recipient_department ILIKE ${like}
        OR recipient_company_name ILIKE ${like})`);
    }
    const rows = await this.sy15.db.$queryRaw<{ count: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT CASE
        WHEN recipient_type = 'EMPLOYEE' AND recipient_employee_id IS NOT NULL
          THEN 'e:' || recipient_employee_id::text
        WHEN recipient_type = 'DEPARTMENT' AND recipient_department IS NOT NULL
          THEN 'd:' || recipient_department
        WHEN recipient_company_name IS NOT NULL THEN 'c:' || recipient_company_name
        WHEN recipient_department IS NOT NULL THEN 'd:' || recipient_department
        ELSE 'x:' || id::text
      END)::int AS count
      FROM rev_documents
      WHERE ${Prisma.join(conds, " AND ")}`);
    return { data: { count: Number(rows[0]?.count) || 0, truncated: false } };
  }

  /**
   * Otvorena ISSUED linija RUČNOG alata za skenirani barkod — podrška Quick Return
   * skeneru (RB-43/44 HAND grana). Paritet 1.0 `fetchOpenHandLineByToolBarcode`:
   * NIJE user-scoped (magacioner vraća tuđi alat) — nalazi otvoren revers BILO KOG
   * primaoca; kad ih je više, uzima NAJSTARIJI (FIFO po `issued_at`). Vraća SVE
   * preostalo na liniji (`remainingQty`); `null` = nema otvorenog reversa za taj alat.
   * Klasni default `reversi.read` (kao cutting open-lines — otkrivanje linije nije
   * role-gated; sam povraćaj `POST /return` ostaje `reversi.manage`).
   */
  async openHandLineByBarcode(barcodeRaw?: string) {
    const barcode = this.normalizeBarcode(barcodeRaw);
    if (!barcode) return { data: null };
    const tool = await this.sy15.db.revTool.findFirst({ where: { barcode } });
    if (!tool) return { data: null };
    const lines = await this.sy15.db.revDocumentLine.findMany({
      where: { toolId: tool.id, lineStatus: "ISSUED" },
      select: {
        id: true,
        documentId: true,
        quantity: true,
        returnedQuantity: true,
      },
    });
    if (lines.length === 0) return { data: null };
    const docIds = [...new Set(lines.map((l) => l.documentId))];
    const docs = await this.sy15.db.revDocument.findMany({
      where: { id: { in: docIds }, status: { in: [...OPEN_DOC_STATUSES] } },
      select: {
        id: true,
        docNumber: true,
        issuedAt: true,
        recipientEmployeeName: true,
        recipientDepartment: true,
        recipientCompanyName: true,
      },
    });
    const docById = new Map(docs.map((d) => [d.id, d]));
    const openLines = lines.filter((l) => docById.has(l.documentId));
    if (openLines.length === 0) return { data: null };
    // FIFO: najstariji otvoren revers prvi (paritet cutting open-lines).
    openLines.sort(
      (a, b) =>
        docById.get(a.documentId)!.issuedAt.getTime() -
        docById.get(b.documentId)!.issuedAt.getTime(),
    );
    const ln = openLines[0];
    const d = docById.get(ln.documentId)!;
    const issuedQty = Number(ln.quantity) || 1;
    const returnedQty = Number(ln.returnedQuantity) || 0;
    return {
      data: {
        lineId: ln.id,
        documentId: d.id,
        docNumber: d.docNumber,
        recipientLabel:
          d.recipientEmployeeName ||
          d.recipientDepartment ||
          d.recipientCompanyName ||
          "—",
        issuedQty,
        returnedQty,
        remainingQty: Math.max(1, issuedQty - returnedQty),
        tool: {
          id: tool.id,
          oznaka: tool.oznaka,
          naziv: tool.naziv,
          barcode: tool.barcode,
          serijskiBroj: tool.serijskiBroj,
        },
      },
    };
  }

  async findOneDocument(id: string) {
    const doc = await this.sy15.db.revDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException(`Reversi dokument ${id} ne postoji`);
    const lines = await this.sy15.db.revDocumentLine.findMany({
      where: { documentId: id },
      orderBy: { sortOrder: "asc" },
    });
    // Ručni resolve alata (šema bez FK relacija).
    const toolIds = [
      ...new Set(lines.map((l) => l.toolId).filter((x): x is string => !!x)),
    ];
    const tools = toolIds.length
      ? await this.sy15.db.revTool.findMany({ where: { id: { in: toolIds } } })
      : [];
    const toolById = new Map(tools.map((t) => [t.id, t]));
    // R4-PAR-02 — odeljenje radnika-primaoca za potpisnicu PDF „(Radnik — …)"
    // (paritet 1.0 `fetchEmployeeDepartment`). Samo za EMPLOYEE primaoce; jedan lagan
    // upit po PK. `recipient_company_pib` je već u `...doc` spread-u (za eksterne firme).
    let recipientEmployeeDepartment: string | null = null;
    if (doc.recipientType === "EMPLOYEE" && doc.recipientEmployeeId) {
      const rows = await this.sy15.db.$queryRaw<
        { department: string | null }[]
      >(
        Prisma.sql`SELECT department FROM employees WHERE id = ${doc.recipientEmployeeId}::uuid LIMIT 1`,
      );
      recipientEmployeeDepartment = rows[0]?.department ?? null;
    }
    return {
      data: {
        ...doc,
        recipientEmployeeDepartment,
        lines: lines.map((l) => ({
          ...l,
          tool: l.toolId ? (toolById.get(l.toolId) ?? null) : null,
        })),
      },
    };
  }

  // ---------- Alat ----------

  async listTools(query: ListToolsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.RevToolWhereInput = {
      ...(query.status && TOOL_STATUSES.has(query.status)
        ? { status: query.status }
        : {}),
      ...(query.subgroupId ? { subgroupId: query.subgroupId } : {}),
      ...(query.q
        ? {
            OR: [
              { oznaka: { contains: query.q, mode: "insensitive" } },
              { naziv: { contains: query.q, mode: "insensitive" } },
              { barcode: { contains: query.q, mode: "insensitive" } },
              { serijskiBroj: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.sy15.db.revTool.findMany({
        where,
        orderBy: [{ oznaka: "asc" }],
        skip,
        take,
      }),
      this.sy15.db.revTool.count({ where }),
    ]);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * Kartica ručnog alata (RB-01/04/05/06/08) — pun red `rev_tools` + baterije +
   * servisi, i (RB-04, KLJUČNO) razrešena KLASIFIKACIJA, TRENUTNA LOKACIJA i
   * OTVORENO ZADUŽENJE. Paritet 1.0 `fetchToolById`:
   *   - `group`/`subgroup`/`subsubgroup` = isti oblik kao `inventory-units`
   *     (RA-14, reuse `UnitGroupRef`/`UnitSubRef`) — FE gradi „Klasifikacija" put,
   *   - `currentLocationCode` = poslednji `loc_item_placements` → `loc_locations`
   *     (magacin „Slobodan · Magacin <kod>"),
   *   - `issuedHolder` = otvorena ISSUED linija + dokument OPEN/PARTIALLY_RETURNED
   *     („Na reversu <doc> · <ko>") — isti oblik kao `inventory-units` (`IssuedHolder`).
   * Garancija (RB-05) i sva master polja (nabavna, punjač, otpis blok) su već u
   * `...tool` spreadu — FE računa badž iz `garancijaDo`. Baterije nose status+napomena
   * (RB-06), servisi izvršilac+status+trošak (RB-08) — sve u `...` redova.
   */
  async findOneTool(id: string) {
    const tool = await this.sy15.db.revTool.findUnique({ where: { id } });
    if (!tool) throw new NotFoundException(`Alat ${id} ne postoji`);
    const [batteries, services] = await Promise.all([
      this.sy15.db.revToolBattery.findMany({
        where: { toolId: id },
        orderBy: { createdAt: "desc" },
      }),
      this.sy15.db.revToolServiceLog.findMany({
        where: { toolId: id },
        orderBy: [{ datum: "desc" }, { createdAt: "desc" }],
      }),
    ]);

    // Klasifikacija (grupa · podgrupa · podpodgrupa) — targetirani lookupi.
    const [sg, ss] = await Promise.all([
      tool.subgroupId
        ? this.sy15.db.revInventorySubgroup.findUnique({
            where: { id: tool.subgroupId },
            select: { id: true, code: true, label: true, groupId: true },
          })
        : Promise.resolve(null),
      tool.subsubgroupId
        ? this.sy15.db.revInventorySubsubgroup.findUnique({
            where: { id: tool.subsubgroupId },
            select: { id: true, code: true, label: true },
          })
        : Promise.resolve(null),
    ]);
    const g = sg?.groupId
      ? await this.sy15.db.revInventoryGroup.findUnique({
          where: { id: sg.groupId },
          select: { code: true, label: true },
        })
      : null;

    // Trenutna lokacija — poslednji placement (kao 1.0 order=placed_at.desc limit 1).
    let currentLocationId: string | null = null;
    let currentLocationCode: string | null = null;
    if (tool.locItemRefId) {
      const pl = await this.sy15.db.locItemPlacement.findFirst({
        where: { itemRefTable: "rev_tools", itemRefId: tool.locItemRefId },
        orderBy: { placedAt: "desc" },
        select: { locationId: true },
      });
      currentLocationId = pl?.locationId ?? null;
      if (currentLocationId) {
        const loc = await this.sy15.db.locLocation.findUnique({
          where: { id: currentLocationId },
          select: { locationCode: true },
        });
        currentLocationCode = loc?.locationCode ?? null;
      }
    }

    // Otvoreno zaduženje — ISSUED linija + dokument OPEN/PARTIALLY_RETURNED.
    const openLines = await this.sy15.db.revDocumentLine.findMany({
      where: { toolId: id, lineStatus: "ISSUED" },
      select: { documentId: true },
    });
    let issuedHolder: {
      docNumber: string;
      recipientType: string;
      recipientEmployeeName: string | null;
      recipientDepartment: string | null;
      recipientCompanyName: string | null;
    } | null = null;
    if (openLines.length > 0) {
      const openDoc = await this.sy15.db.revDocument.findFirst({
        where: {
          id: { in: [...new Set(openLines.map((l) => l.documentId))] },
          status: { in: ["OPEN", "PARTIALLY_RETURNED"] },
        },
        orderBy: { issuedAt: "desc" },
        select: {
          docNumber: true,
          recipientType: true,
          recipientEmployeeName: true,
          recipientDepartment: true,
          recipientCompanyName: true,
        },
      });
      if (openDoc) {
        issuedHolder = {
          docNumber: openDoc.docNumber,
          recipientType: openDoc.recipientType,
          recipientEmployeeName: openDoc.recipientEmployeeName,
          recipientDepartment: openDoc.recipientDepartment,
          recipientCompanyName: openDoc.recipientCompanyName,
        };
      }
    }

    return {
      data: {
        ...tool,
        batteries,
        services,
        group: g ? { code: g.code, label: g.label } : null,
        subgroup: sg ? { id: sg.id, code: sg.code, label: sg.label } : null,
        subsubgroup: ss ? { id: ss.id, code: ss.code, label: ss.label } : null,
        currentLocationId,
        currentLocationCode,
        issuedHolder,
      },
    };
  }

  /**
   * Istorija zaduženja jednog alata (RB-10) — sve `rev_document_lines` za alat +
   * pripadajući dokument (batch-resolve, šema bez FK). Paritet 1.0 `fetchToolDocuments`
   * (order=created_at.desc). `reversi.read` (linija/dokument su klasni read; „Promene
   * zaliha" ide zasebno kroz `/ledger?toolId=` koji je manage-gated). FE gradi tabelu
   * (Izdato/Dokument/Primalac/Stavka[Vraćen/Zadužen]/Vraćeno) iz `line` + `line.document`.
   */
  async toolDocuments(id: string) {
    const lines = await this.sy15.db.revDocumentLine.findMany({
      where: { toolId: id },
      orderBy: { createdAt: "desc" },
    });
    const docIds = [...new Set(lines.map((l) => l.documentId))];
    const docs = docIds.length
      ? await this.sy15.db.revDocument.findMany({
          where: { id: { in: docIds } },
          select: {
            id: true,
            docNumber: true,
            docType: true,
            recipientType: true,
            recipientEmployeeName: true,
            recipientDepartment: true,
            recipientCompanyName: true,
            issuedAt: true,
            status: true,
            returnConfirmedAt: true,
          },
        })
      : [];
    const byId = new Map(docs.map((d) => [d.id, d]));
    return {
      data: lines.map((l) => ({
        ...l,
        document: byId.get(l.documentId) ?? null,
      })),
    };
  }

  // ---------- Baterije / Servis alata (RB-07/09 — CRUD sub-evidencije) ----------

  /**
   * Dodaj bateriju (RB-07). `withUser` → `created_by` = auth.uid() iz GUC claims
   * (paritet 1.0 INSERT pod korisničkom rolom); status default 'active' (DB CHECK).
   */
  async addToolBattery(email: string, toolId: string, dto: CreateBatteryDto) {
    const row = await this.sy15.withUser(email, (tx) =>
      tx.revToolBattery.create({
        data: {
          toolId,
          serijskiBroj: dto.serijskiBroj?.trim() || null,
          kapacitet: dto.kapacitet?.trim() || null,
          datumNabavke: dto.datumNabavke ? new Date(dto.datumNabavke) : null,
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          napomena: dto.napomena?.trim() || null,
        },
      }),
    );
    return { data: row };
  }

  /** Izmena baterije (RB-07) — typed PATCH; P2025 (stale id) → 404. */
  async updateToolBattery(id: string, dto: UpdateBatteryDto) {
    const data: Prisma.RevToolBatteryUpdateInput = {};
    if (dto.serijskiBroj !== undefined)
      data.serijskiBroj = dto.serijskiBroj?.trim() || null;
    if (dto.kapacitet !== undefined)
      data.kapacitet = dto.kapacitet?.trim() || null;
    if (dto.datumNabavke !== undefined)
      data.datumNabavke = dto.datumNabavke ? new Date(dto.datumNabavke) : null;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.napomena !== undefined)
      data.napomena = dto.napomena?.trim() || null;
    try {
      const row = await this.sy15.db.revToolBattery.update({
        where: { id },
        data,
      });
      return { data: row };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        throw new NotFoundException(`Baterija ${id} ne postoji`);
      }
      throw e;
    }
  }

  /** Brisanje baterije (RB-07) — typed DELETE; P2025 → 404. */
  async deleteToolBattery(id: string) {
    try {
      await this.sy15.db.revToolBattery.delete({ where: { id } });
      return { data: { id } };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        throw new NotFoundException(`Baterija ${id} ne postoji`);
      }
      throw e;
    }
  }

  /**
   * Dodaj servis/popravku (RB-09). `withUser` → `created_by` = auth.uid(). `datum`/
   * `tip`/`status` izostavljeni → DB podrazumeva (CURRENT_DATE / 'popravka' / 'zavrsen').
   * „Isplativost" (RB-08) FE računa: Σ trošak SAMO `status='zavrsen'` / nabavna vrednost.
   */
  async addToolService(email: string, toolId: string, dto: CreateServiceDto) {
    const row = await this.sy15.withUser(email, (tx) =>
      tx.revToolServiceLog.create({
        data: {
          toolId,
          ...(dto.datum ? { datum: new Date(dto.datum) } : {}),
          ...(dto.tip !== undefined ? { tip: dto.tip } : {}),
          opis: dto.opis?.trim() || null,
          izvrsilac: dto.izvrsilac?.trim() || null,
          trosak: dto.trosak ?? null,
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          napomena: dto.napomena?.trim() || null,
        },
      }),
    );
    return { data: row };
  }

  /** Izmena servisa (RB-09) — typed PATCH; P2025 → 404. */
  async updateToolService(id: string, dto: UpdateServiceDto) {
    const data: Prisma.RevToolServiceLogUpdateInput = {};
    if (dto.datum !== undefined) data.datum = new Date(dto.datum);
    if (dto.tip !== undefined) data.tip = dto.tip;
    if (dto.opis !== undefined) data.opis = dto.opis?.trim() || null;
    if (dto.izvrsilac !== undefined)
      data.izvrsilac = dto.izvrsilac?.trim() || null;
    if (dto.trosak !== undefined) data.trosak = dto.trosak ?? null;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.napomena !== undefined)
      data.napomena = dto.napomena?.trim() || null;
    try {
      const row = await this.sy15.db.revToolServiceLog.update({
        where: { id },
        data,
      });
      return { data: row };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        throw new NotFoundException(`Servis ${id} ne postoji`);
      }
      throw e;
    }
  }

  /** Brisanje servisa (RB-09) — typed DELETE; P2025 → 404. */
  async deleteToolService(id: string) {
    try {
      await this.sy15.db.revToolServiceLog.delete({ where: { id } });
      return { data: { id } };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        throw new NotFoundException(`Servis ${id} ne postoji`);
      }
      throw e;
    }
  }

  /**
   * Lista pojedinačnih jedinica inventara sa zaduženjem/lokacijom po jedinici
   * (RA-14/16/17/13/15/18; izvor stat kartica RA-10; fetch-all za CSV RA-23).
   *
   * Paritet 1.0 `fetchTools`: `rev_tools` (status/klasifikacija/pretraga filteri,
   * sort iz allowliste, server-side paginacija sa `total`) + ručni batch-resolve
   * (šema bez FK relacija):
   *   - klasifikacija: iz `inventoryTree` mapa (grupa · podgrupa · podpodgrupa),
   *   - lokacija: `loc_item_placements` (item_ref_table=rev_tools) → `loc_locations.location_code`,
   *   - zaduženje: otvorena ISSUED `rev_document_lines` + `rev_documents`
   *     (status OPEN/PARTIALLY_RETURNED) → primalac + broj dokumenta.
   * `pageSize` do 5000 (RA-23 izvozi ceo filtrirani skup).
   */
  async listInventoryUnits(query: InventoryUnitsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
      5000,
    );

    const where: Prisma.RevToolWhereInput = {};
    const status = (query.status ?? "active").trim();
    if (status === "active" || status === "scrapped" || status === "lost") {
      where.status = status;
    }
    // 'all' → bez filtera na status (paritet 1.0 'Svi zapisi').

    if (query.subsubgroupId && query.subsubgroupId !== "ALL") {
      where.subsubgroupId = query.subsubgroupId;
    }
    if (query.subgroupId && query.subgroupId !== "ALL") {
      where.subgroupId = query.subgroupId;
    } else if (query.groupCode && query.groupCode !== "ALL") {
      // Grupa bez izabrane podgrupe → suzi na podgrupe te grupe (nesvrstano ispada).
      const group = await this.sy15.db.revInventoryGroup.findUnique({
        where: { code: query.groupCode },
        select: { id: true },
      });
      const subs = group
        ? await this.sy15.db.revInventorySubgroup.findMany({
            where: { groupId: group.id },
            select: { id: true },
          })
        : [];
      where.subgroupId = { in: subs.map((s) => s.id) };
    }

    const q = (query.q ?? "").trim();
    if (q) {
      where.OR = [
        { oznaka: { contains: q, mode: "insensitive" } },
        { naziv: { contains: q, mode: "insensitive" } },
        { barcode: { contains: q, mode: "insensitive" } },
      ];
    }

    const col = UNIT_SORTABLE[query.sort ?? "oznaka"] ?? "oznaka";
    const dir: Prisma.SortOrder = query.dir === "desc" ? "desc" : "asc";
    // Sekundarni oznaka.asc za stabilan redosled (paritet 1.0); eksplicitne grane
    // izbegavaju računato-ključno tipovanje nad RevToolOrderByWithRelationInput.
    const orderBy: Prisma.RevToolOrderByWithRelationInput[] =
      col === "naziv"
        ? [{ naziv: dir }, { oznaka: "asc" }]
        : col === "status"
          ? [{ status: dir }, { oznaka: "asc" }]
          : col === "createdAt"
            ? [{ createdAt: dir }, { oznaka: "asc" }]
            : [{ oznaka: dir }];

    const [tools, total] = await Promise.all([
      this.sy15.db.revTool.findMany({ where, orderBy, skip, take }),
      this.sy15.db.revTool.count({ where }),
    ]);
    if (tools.length === 0) {
      return { data: [], meta: pageMeta(page, pageSize, total) };
    }

    // Klasifikacija (grupa · podgrupa · podpodgrupa) iz jednokratnih mapa.
    const [groups, subgroups, subsubgroups] = await Promise.all([
      this.sy15.db.revInventoryGroup.findMany({
        select: { id: true, code: true, label: true },
      }),
      this.sy15.db.revInventorySubgroup.findMany({
        select: { id: true, code: true, label: true, groupId: true },
      }),
      this.sy15.db.revInventorySubsubgroup.findMany({
        select: { id: true, code: true, label: true },
      }),
    ]);
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const subgroupById = new Map(subgroups.map((s) => [s.id, s]));
    const subsubById = new Map(subsubgroups.map((s) => [s.id, s]));

    // Lokacija po jedinici — loc_item_placements → loc_locations.location_code.
    const refIds = [
      ...new Set(
        tools.map((t) => t.locItemRefId).filter((x): x is string => !!x),
      ),
    ];
    const placements = refIds.length
      ? await this.sy15.db.locItemPlacement.findMany({
          where: { itemRefTable: "rev_tools", itemRefId: { in: refIds } },
          select: { itemRefId: true, locationId: true },
        })
      : [];
    const locIds = [...new Set(placements.map((p) => p.locationId))];
    const locs = locIds.length
      ? await this.sy15.db.locLocation.findMany({
          where: { id: { in: locIds } },
          select: { id: true, locationCode: true },
        })
      : [];
    const locCodeById = new Map(locs.map((l) => [l.id, l.locationCode]));
    const placeByRef = new Map(placements.map((p) => [p.itemRefId, p]));

    // Zaduženje po jedinici — otvorene ISSUED linije + dokument OPEN/PARTIALLY_RETURNED.
    const ids = tools.map((t) => t.id);
    const lines = await this.sy15.db.revDocumentLine.findMany({
      where: { toolId: { in: ids }, lineStatus: "ISSUED" },
      select: { toolId: true, documentId: true },
    });
    const docIds = [...new Set(lines.map((l) => l.documentId))];
    const docs = docIds.length
      ? await this.sy15.db.revDocument.findMany({
          where: { id: { in: docIds } },
          select: {
            id: true,
            docNumber: true,
            status: true,
            recipientType: true,
            recipientEmployeeName: true,
            recipientDepartment: true,
            recipientCompanyName: true,
          },
        })
      : [];
    const docById = new Map(docs.map((d) => [d.id, d]));
    const issuedByTool = new Map<
      string,
      {
        docNumber: string;
        recipientType: string;
        recipientEmployeeName: string | null;
        recipientDepartment: string | null;
        recipientCompanyName: string | null;
      }
    >();
    for (const ln of lines) {
      if (!ln.toolId) continue;
      const d = docById.get(ln.documentId);
      if (d && OPEN_DOC_STATUSES.has(d.status)) {
        issuedByTool.set(ln.toolId, {
          docNumber: d.docNumber,
          recipientType: d.recipientType,
          recipientEmployeeName: d.recipientEmployeeName,
          recipientDepartment: d.recipientDepartment,
          recipientCompanyName: d.recipientCompanyName,
        });
      }
    }

    const data = tools.map((t) => {
      const sg = t.subgroupId ? (subgroupById.get(t.subgroupId) ?? null) : null;
      const g = sg?.groupId ? (groupById.get(sg.groupId) ?? null) : null;
      const ss = t.subsubgroupId
        ? (subsubById.get(t.subsubgroupId) ?? null)
        : null;
      const pl = t.locItemRefId ? placeByRef.get(t.locItemRefId) : undefined;
      const currentLocationId = pl?.locationId ?? null;
      return {
        ...t,
        group: g ? { code: g.code, label: g.label } : null,
        subgroup: sg ? { id: sg.id, code: sg.code, label: sg.label } : null,
        subsubgroup: ss ? { id: ss.id, code: ss.code, label: ss.label } : null,
        currentLocationId,
        currentLocationCode: currentLocationId
          ? (locCodeById.get(currentLocationId) ?? null)
          : null,
        issuedHolder: issuedByTool.get(t.id) ?? null,
      };
    });
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * Nova jedinica ručnog alata (RB-46 — modal „Nova jedinica"). Paritet 1.0
   * `modals.js openAddToolModal` — ceo tok je jedna idempotentna transakcija
   * (INSERT rev_tools + početno stanje) keširana `clientEventId`-em, pa dupli
   * klik / retry vraća PRVU jedinicu umesto da iskuje drugi barkod:
   *   1. INSERT jedinice; barkod + `loc_item_ref_id` dodeljuju trigeri (vraćaju
   *      se za nalepnicu RB-47).
   *   2. Količinska/potrošna (jedan barkod = više komada) kreće od `total_qty=0`,
   *      pa se početna zaliha knjiži kao RECEIPT „Početno stanje" kroz
   *      `rev_hand_tool_apply_delta` — RA-20 „Istorija zaliha" tada ima red i
   *      invarijanta Σ ledger = total_qty važi (paritet 1.0 modals.js:395-413).
   *   3. Ne-količinska jedinica dobija početni smeštaj u magacin
   *      (INITIAL_PLACEMENT, podrazumevano `ALAT-MAG-01` kao 1.0
   *      `getMagacinLocationId`; klijent sme zadati drugu lokaciju preko
   *      `initialPlacementLocationId`) — bez toga bi u ćeliji „Zaduženje"
   *      pokazivao „U magacinu" bez koda i ne bi bio u magacinsko-lokacijskom
   *      praćenju (paritet 1.0 modals.js:414-428).
   */
  async createTool(email: string, dto: CreateToolDto) {
    const isQuantity = dto.isQuantity ?? false;
    const isConsumable = dto.isConsumable ?? false;
    // „qtyLike" = jedan barkod nosi više komada (količinska ili potrošna stavka);
    // prati se kroz ledger/dokumente, bez jedinstvenog placementa.
    const qtyLike = isQuantity || isConsumable;
    const seedQty = qtyLike ? (dto.totalQty ?? 0) : 0;
    const clientEventId = dto.clientEventId ?? randomUUID();

    try {
      const outcome = await this.sy15.runIdempotent(
        email,
        clientEventId,
        "reversi.create-tool",
        async (tx) => {
          const tool = await tx.revTool.create({
            data: {
              oznaka: dto.oznaka.trim(),
              naziv: dto.naziv.trim(),
              serijskiBroj: dto.serijskiBroj?.trim() || null,
              datumKupovine: dto.datumKupovine
                ? new Date(dto.datumKupovine)
                : null,
              nabavnaVrednost: dto.nabavnaVrednost ?? null,
              garancijaDo: dto.garancijaDo ? new Date(dto.garancijaDo) : null,
              garancijaNapomena: dto.garancijaNapomena?.trim() || null,
              imaPunjac: dto.imaPunjac ?? false,
              punjacSerijski: dto.punjacSerijski?.trim() || null,
              napomena: dto.napomena?.trim() || null,
              subgroupId: dto.subgroupId ?? null,
              subsubgroupId: dto.subsubgroupId ?? null,
              isQuantity,
              isConsumable,
              // Količinska kreće od 0 (zaliha se knjiži kao RECEIPT ispod);
              // ne-količinska = 1 komad.
              totalQty: qtyLike ? 0 : 1,
              minStockQty: dto.minStockQty ?? null,
              maxStockQty: dto.maxStockQty ?? null,
              status: "active",
            },
          });

          // (2) Početna zaliha količinske stavke → RECEIPT u ledger (audit trag).
          if (qtyLike && seedQty > 0) {
            await tx.$queryRaw`
              SELECT rev_hand_tool_apply_delta(${tool.id}::uuid, ${seedQty}::int,
                'RECEIPT', 'Početno stanje') AS result`;
          }

          // (3) Ne-količinska jedinica → početni smeštaj u magacin.
          let placement: unknown = null;
          if (!qtyLike && tool.locItemRefId) {
            let locationId = dto.initialPlacementLocationId ?? null;
            if (!locationId) {
              const rows = await tx.$queryRaw<{ id: string }[]>`
                SELECT id FROM loc_locations
                WHERE location_code = 'ALAT-MAG-01' LIMIT 1`;
              locationId = rows[0]?.id ?? null;
            }
            // ALAT-MAG-01 ne postoji → alat je i dalje kreiran i upotrebljiv u
            // Izdaj (paritet 1.0: unos bez početnog smeštaja, samo bez lokacije).
            if (locationId) {
              placement = await this.placeToolInWarehouse(
                tx,
                tool.locItemRefId,
                locationId,
                clientEventId,
              );
            }
          }

          return {
            id: tool.id,
            oznaka: tool.oznaka,
            naziv: tool.naziv,
            barcode: tool.barcode,
            locItemRefId: tool.locItemRefId,
            placement,
          };
        },
      );
      return { data: outcome.result, meta: { idempotent: outcome.idempotent } };
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /**
   * Izmena artikla ručnog alata (RB-11 — modal „Izmena artikla"). Direktan PATCH
   * rev_tools (konekciona rola BYPASSRLS — guard reversi.manage je granica; paritet
   * 1.0 `updateHandTool`). `null` na klasifikaciji/serijskom/garanciji briše polje.
   * P2025 (nepostojeći id) → 404 (isto kao updateCuttingTool / Lokacije).
   */
  async updateTool(id: string, dto: UpdateToolDto) {
    const data: Prisma.RevToolUpdateInput = {};
    if (dto.oznaka !== undefined) data.oznaka = dto.oznaka.trim();
    if (dto.naziv !== undefined) data.naziv = dto.naziv.trim();
    if (dto.serijskiBroj !== undefined)
      data.serijskiBroj = dto.serijskiBroj?.trim() || null;
    if (dto.datumKupovine !== undefined)
      data.datumKupovine = dto.datumKupovine
        ? new Date(dto.datumKupovine)
        : null;
    if (dto.nabavnaVrednost !== undefined)
      data.nabavnaVrednost = dto.nabavnaVrednost ?? null;
    if (dto.garancijaDo !== undefined)
      data.garancijaDo = dto.garancijaDo ? new Date(dto.garancijaDo) : null;
    if (dto.garancijaNapomena !== undefined)
      data.garancijaNapomena = dto.garancijaNapomena?.trim() || null;
    if (dto.imaPunjac !== undefined) data.imaPunjac = dto.imaPunjac;
    if (dto.punjacSerijski !== undefined)
      data.punjacSerijski = dto.punjacSerijski?.trim() || null;
    if (dto.napomena !== undefined)
      data.napomena = dto.napomena?.trim() || null;
    if (dto.subgroupId !== undefined) data.subgroupId = dto.subgroupId ?? null;
    if (dto.subsubgroupId !== undefined)
      data.subsubgroupId = dto.subsubgroupId ?? null;
    if (dto.minStockQty !== undefined)
      data.minStockQty = dto.minStockQty ?? null;
    if (dto.maxStockQty !== undefined)
      data.maxStockQty = dto.maxStockQty ?? null;
    if (dto.totalQty !== undefined) data.totalQty = dto.totalQty;
    if (dto.status !== undefined) data.status = dto.status;

    try {
      const tool = await this.sy15.db.revTool.update({ where: { id }, data });
      return { data: tool };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        throw new NotFoundException(`Alat ${id} ne postoji`);
      }
      throw e;
    }
  }

  // ---------- Klasifikacija (inventar grupe) ----------

  async inventoryTree() {
    const [groups, subgroups, subsubgroups] = await Promise.all([
      this.sy15.db.revInventoryGroup.findMany({
        orderBy: { displayOrder: "asc" },
      }),
      this.sy15.db.revInventorySubgroup.findMany({
        orderBy: { displayOrder: "asc" },
      }),
      this.sy15.db.revInventorySubsubgroup.findMany({
        orderBy: { displayOrder: "asc" },
      }),
    ]);
    return { data: { groups, subgroups, subsubgroups } };
  }

  /**
   * Broj artikala po podgrupi/podpodgrupi (RA-25 brojači u stablu; RA-28
   * upozorenje pri brisanju „X postaje nesvrstano"). Paritet 1.0
   * `fetchInventoryClassificationUsage` — rev_tools + rev_cutting_tool_catalog.
   */
  async inventoryClassificationUsage() {
    const rows = await this.sy15.db.$queryRaw<
      { k: string; id: string; n: number }[]
    >(Prisma.sql`
      SELECT 'tool_sub'::text AS k, subgroup_id::text AS id, count(*)::int AS n
        FROM rev_tools WHERE subgroup_id IS NOT NULL GROUP BY subgroup_id
      UNION ALL
      SELECT 'tool_subsub', subsubgroup_id::text, count(*)::int
        FROM rev_tools WHERE subsubgroup_id IS NOT NULL GROUP BY subsubgroup_id
      UNION ALL
      SELECT 'cutting_sub', subgroup_id::text, count(*)::int
        FROM rev_cutting_tool_catalog WHERE subgroup_id IS NOT NULL GROUP BY subgroup_id`);
    const out: {
      tools: Record<string, number>;
      cutting: Record<string, number>;
      subsubs: Record<string, number>;
    } = { tools: {}, cutting: {}, subsubs: {} };
    for (const r of rows) {
      const n = Number(r.n) || 0;
      if (r.k === "tool_sub") out.tools[r.id] = n;
      else if (r.k === "cutting_sub") out.cutting[r.id] = n;
      else if (r.k === "tool_subsub") out.subsubs[r.id] = n;
    }
    return { data: out };
  }

  /**
   * Dodaj user-defined podgrupu (RA-26) — postojeća DEFINER fn
   * `rev_add_inventory_subgroup(p_group_code, p_label, p_napomena)` koja sama
   * gate-uje `rev_can_manage()` iz GUC claims (drugi sloj posle guarda) i izvodi
   * `code` iz label-a. Zato ide kroz `withUser`. Greške: 42501→403, 22023/23503→422.
   */
  async addInventorySubgroup(email: string, dto: AddSubgroupDto) {
    try {
      const rows = await this.sy15.withUser(
        email,
        (tx) => tx.$queryRaw<unknown[]>`
          SELECT * FROM rev_add_inventory_subgroup(
            ${dto.groupCode.trim()}, ${dto.label.trim()}, ${dto.napomena?.trim() || null})`,
      );
      return { data: rows[0] ?? null };
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** Dodaj podpodgrupu (RA-26) — DEFINER fn `rev_add_inventory_subsubgroup`. */
  async addInventorySubsubgroup(email: string, dto: AddSubsubgroupDto) {
    try {
      const rows = await this.sy15.withUser(
        email,
        (tx) => tx.$queryRaw<unknown[]>`
          SELECT * FROM rev_add_inventory_subsubgroup(
            ${dto.subgroupId}::uuid, ${dto.label.trim()}, ${dto.napomena?.trim() || null})`,
      );
      return { data: rows[0] ?? null };
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /**
   * Preimenovanje nivoa klasifikacije (RA-27) — menja se samo `label` (interni
   * `code` ostaje stabilan ključ). Dozvoljeno i za sistemske (is_seeded) redove,
   * paritet 1.0 `renameInventoryClassification`. Direktan PATCH (BYPASSRLS + guard).
   */
  async renameClassification(kind: string, id: string, label: string) {
    if (kind !== "group" && kind !== "subgroup" && kind !== "subsubgroup") {
      throw new UnprocessableEntityException(
        "kind mora biti group | subgroup | subsubgroup",
      );
    }
    const trimmed = label.trim();
    try {
      if (kind === "group") {
        const row = await this.sy15.db.revInventoryGroup.update({
          where: { id },
          data: { label: trimmed },
        });
        return { data: row };
      }
      if (kind === "subgroup") {
        const row = await this.sy15.db.revInventorySubgroup.update({
          where: { id },
          data: { label: trimmed },
        });
        return { data: row };
      }
      const row = await this.sy15.db.revInventorySubsubgroup.update({
        where: { id },
        data: { label: trimmed },
      });
      return { data: row };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        throw new NotFoundException(`Klasa ${kind}/${id} ne postoji`);
      }
      throw e;
    }
  }

  /**
   * Brisanje korisničke podgrupe (RA-28). Samo `is_seeded=false` (paritet 1.0 RLS
   * — sistemske su zaključane). Artikli: `subgroup_id → NULL` (FK ON DELETE SET
   * NULL, „postaju nesvrstani"). FE prvo briše podpodgrupe (RESTRICT FK); ako ih
   * ipak ima → P2003 → 409.
   */
  async deleteInventorySubgroup(id: string) {
    const row = await this.sy15.db.revInventorySubgroup.findUnique({
      where: { id },
      select: { isSeeded: true },
    });
    if (!row) throw new NotFoundException(`Podgrupa ${id} ne postoji`);
    if (row.isSeeded)
      throw new UnprocessableEntityException(
        "Sistemska podgrupa se ne može obrisati",
      );
    try {
      await this.sy15.db.revInventorySubgroup.delete({ where: { id } });
      return { data: { deleted: true } };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2003"
      ) {
        throw new ConflictException(
          "Podgrupa ima podpodgrupe — prvo obriši podpodgrupe",
        );
      }
      throw e;
    }
  }

  /** Brisanje korisničke podpodgrupe (RA-28). Samo `is_seeded=false`. */
  async deleteInventorySubsubgroup(id: string) {
    const row = await this.sy15.db.revInventorySubsubgroup.findUnique({
      where: { id },
      select: { isSeeded: true },
    });
    if (!row) throw new NotFoundException(`Podpodgrupa ${id} ne postoji`);
    if (row.isSeeded)
      throw new UnprocessableEntityException(
        "Sistemska podpodgrupa se ne može obrisati",
      );
    await this.sy15.db.revInventorySubsubgroup.delete({ where: { id } });
    return { data: { deleted: true } };
  }

  /**
   * Štampa nalepnica (RA-22 bulk + RB-47 pri dodavanju) — REUSE deljenog TSPL2
   * transporta (`LabelPrintService`, isti koji koriste Lokacije/Tehnologija). FE
   * gradi ceo TSPL2 program u 1.0 formatu (`reversiLabelsPrint.js`: ALAT- Code128,
   * oznaka/naziv/podgrupa/serijski); backend samo prosleđuje RAW na TCP 9100.
   */
  async printLabel(dto: ReversiPrintLabelDto) {
    return { data: await this.labelPrint.printRawTspl(dto) };
  }

  /**
   * Početni smeštaj alata u WAREHOUSE lokaciju (INITIAL_PLACEMENT) kroz
   * `loc_create_movement` — paritet 1.0 `initialPlacementForTool`. Radi na
   * prosleđenom `tx` (claims su već postavljeni u `runIdempotent`), pa je deo iste
   * atomarne transakcije kao INSERT jedinice. Baca 422 ako fn vrati `ok≠true`
   * (paritet 1.0: neuspeo početni smeštaj se NE progutava kao uspeh —
   * `already_placed` / `bad_to_location` ne sme proći kao 201).
   */
  private async placeToolInWarehouse(
    tx: Sy15Tx,
    locItemRefId: string,
    locationId: string,
    clientEventId: string,
  ): Promise<{ ok?: boolean; error?: string }> {
    const payload = {
      client_event_uuid: clientEventId,
      item_ref_table: "rev_tools",
      item_ref_id: locItemRefId,
      to_location_id: locationId,
      movement_type: "INITIAL_PLACEMENT",
      movement_reason: "Ručni unos alata — Reversi UI",
      quantity: 1,
    };
    const rows = await tx.$queryRawUnsafe<
      { result: { ok?: boolean; error?: string } | null }[]
    >(
      "SELECT loc_create_movement($1::jsonb) AS result",
      JSON.stringify(payload),
    );
    const result = rows[0]?.result ?? null;
    if (!result || result.ok !== true) {
      throw new UnprocessableEntityException(
        result?.error ?? "Početni smeštaj u magacin nije uspeo",
      );
    }
    return result;
  }

  // ---------- Ledger (JEDINI ne-javni read — politika rev_tool_stock_ledger_select = rev_can_manage) ----------

  async listLedger(query: LedgerQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.RevToolStockLedgerWhereInput = query.toolId
      ? { toolId: query.toolId }
      : {};
    const [data, total] = await Promise.all([
      this.sy15.db.revToolStockLedger.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      this.sy15.db.revToolStockLedger.count({ where }),
    ]);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * Magacionerski izveštaj potrošnje/pokreta zalihe (RA-39/40/41) — paritet 1.0
   * `fetchConsumptionReport`. Čita obogaćen ledger `v_rev_stock_ledger_detail`
   * (oznaka/naziv/primalac/dokument uz deltu i stanje-posle), filtriran po
   * `created_at` opsegu i tipu pokreta (`reason`). „Fetch-all" u JEDNOM pozivu
   * (do `limit`, default 2000, max 5000) — FE gradi „Zbir po artiklu" + „Detalji"
   * + CSV (RA-40/41) klijentski, kao 1.0.
   *
   * Manage-gated (kao `/ledger` — jedini ne-javni read). Direktan `db.$queryRaw`
   * (konekciona rola je granica; view je `security_invoker`, pa pod BYPASSRLS rolom
   * vraća sve redove — isti obrazac kao `listLedger`). `delta`/`balance_after`
   * kastovani u float8 → čisti JS brojevi (bez BigInt serijalizacije).
   */
  async reportConsumption(query: ConsumptionReportQuery) {
    const limit = Math.min(
      5000,
      Math.max(1, Number.parseInt(query.limit ?? "2000", 10) || 2000),
    );
    const conds: Prisma.Sql[] = [];
    const from = query.from?.trim();
    const to = query.to?.trim();
    if (from) conds.push(Prisma.sql`created_at >= ${from}::timestamptz`);
    // Kraj dana (paritet 1.0 `lte.${to}T23:59:59`) — uključuje ceo `to` datum.
    if (to)
      conds.push(Prisma.sql`created_at <= ${`${to}T23:59:59`}::timestamptz`);
    const reason = query.reason?.trim();
    if (reason && reason !== "ALL") conds.push(Prisma.sql`reason = ${reason}`);
    const whereSql = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
      : Prisma.empty;
    const data = await this.sy15.db.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`
        SELECT ledger_id, tool_id, oznaka, naziv, is_consumable,
               subgroup_label, group_label,
               delta::float8         AS delta,
               reason,
               balance_after::float8 AS balance_after,
               ref_doc_id, doc_number, recipient_type,
               recipient_employee_name, recipient_department, recipient_company_name,
               note, created_by, created_at
        FROM v_rev_stock_ledger_detail
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT ${limit}`,
    );
    return { data };
  }

  // ---------- Pregledi (postojeći sy15 view-ovi — paritet 1:1) ----------

  /** Self-service „Moji alati" — view zavisi od `rev_current_employee_id()` → GUC. */
  async reportMyIssued(email: string) {
    const data = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw`SELECT * FROM v_rev_my_issued_tools`,
    );
    return { data };
  }

  async reportMyConsumed(email: string) {
    const data = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw`SELECT * FROM v_rev_my_consumed`,
    );
    return { data };
  }

  async reportMyMachinesCutting(email: string) {
    const data = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw`SELECT * FROM v_rev_my_machines_cutting_tools`,
    );
    return { data };
  }

  /** Tim-scope (TL/šef) — `get_team_issued_tools()` sprovodi `current_user_manages_employee` u bazi. */
  async reportTeamIssued(email: string) {
    const data = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw`SELECT * FROM get_team_issued_tools()`,
    );
    return { data };
  }

  /** Objedinjeno stanje magacina (nije user-scoped). */
  async reportWarehouse(allLocations: boolean) {
    const data = allLocations
      ? await this.sy15.db
          .$queryRaw`SELECT * FROM v_rev_inventory_all_locations`
      : await this.sy15.db.$queryRaw`SELECT * FROM v_rev_warehouse_unified`;
    return { data };
  }

  async reportScrapped() {
    const data = await this.sy15.db
      .$queryRaw`SELECT * FROM v_rev_otpisani_alat`;
    return { data };
  }

  /**
   * Mašine za Reversi kontekst (view nad maint_machines; u 1.0 REVOKE anon — ovde
   * JWT + reversi.read). Red nosi SVA polja `v_rev_machines` (RB-55: serial_number,
   * year_of_manufacture, year_commissioned, power_kw, notes) + `archived_at` (RB-52
   * „Samo aktivne" — FE filtrira, badž „arhivirana" RB-53) i AGREGATE po mašini
   * (RB-53 kolone tabele): `cuttingToolSkus`/`cuttingToolQty` iz `v_rev_cts_by_machine`
   * (broj šifri + Σ preostalo) i `headsCount` iz `rev_machine_heads`. 1.0 ove brojeve
   * računa klijentski iz 3 poziva (`fetchMachines`+`fetchCuttingByMachine`+
   * `fetchMachineHeadCounts`); ovde ih vraćamo obogaćene u JEDNOM pozivu.
   */
  async reportMachines() {
    // `machine_code` je tekst u `v_rev_machines`; tipujemo ga eksplicitno (ostala
    // polja ostaju `unknown` i prolaze kroz spread) da bi ključ agregata bio string.
    const machines = await this.sy15.db.$queryRaw<
      ({ machine_code: string } & Record<string, unknown>)[]
    >(Prisma.sql`SELECT * FROM v_rev_machines`);
    if (machines.length === 0) return { data: [] };
    const [cutRows, headRows] = await Promise.all([
      this.sy15.db.$queryRaw<
        { machine_code: string; skus: number; qty: number }[]
      >(Prisma.sql`
        SELECT machine_code, COUNT(*)::int AS skus,
               COALESCE(SUM(remaining_qty), 0)::float8 AS qty
        FROM v_rev_cts_by_machine
        WHERE machine_code IS NOT NULL
        GROUP BY machine_code`),
      this.sy15.db.$queryRaw<{ machine_code: string; n: number }[]>(Prisma.sql`
        SELECT machine_code, COUNT(*)::int AS n
        FROM rev_machine_heads
        GROUP BY machine_code`),
    ]);
    const cutBy = new Map(cutRows.map((r) => [r.machine_code, r]));
    const headBy = new Map(
      headRows.map((r) => [r.machine_code, Number(r.n) || 0]),
    );
    const data = machines.map((m) => {
      const mc = m.machine_code;
      const c = cutBy.get(mc);
      return {
        ...m,
        cuttingToolSkus: c ? Number(c.skus) || 0 : 0,
        cuttingToolQty: c ? Number(c.qty) || 0 : 0,
        headsCount: headBy.get(mc) ?? 0,
      };
    });
    return { data };
  }

  /**
   * Istorija izdavanja na mašinu (RB-58) — poslednji `rev_documents` sa
   * `recipient_machine_code = code` (order issued_at desc, limit ≤200). Paritet 1.0
   * `fetchMachineDocuments`. FE kolone: Izdato/Dokument/Potpisao(issuedToEmployeeName
   * ∨ recipientEmployeeName)/Status/Rok. `reversi.read` (dokument je klasni read).
   */
  async machineDocuments(code: string, limit?: string) {
    const take = Math.min(
      200,
      Math.max(1, Number.parseInt(limit ?? "50", 10) || 50),
    );
    const data = await this.sy15.db.revDocument.findMany({
      where: { recipientMachineCode: code },
      orderBy: { issuedAt: "desc" },
      take,
      select: {
        id: true,
        docNumber: true,
        docType: true,
        status: true,
        issuedAt: true,
        expectedReturnDate: true,
        issuedToEmployeeName: true,
        recipientEmployeeName: true,
        napomena: true,
      },
    });
    return { data };
  }

  // ---------- Glave mašine (RB-57 — CRUD evidencije) ----------

  /** Dodaj glavu (RB-57). `withUser` → created_by = auth.uid(); status default 'ACTIVE'. */
  async addMachineHead(
    email: string,
    machineCode: string,
    dto: CreateMachineHeadDto,
  ) {
    const row = await this.sy15.withUser(email, (tx) =>
      tx.revMachineHead.create({
        data: {
          machineCode,
          oznaka: dto.oznaka.trim(),
          naziv: dto.naziv.trim(),
          tip: dto.tip?.trim() || null,
          serijskiBroj: dto.serijskiBroj?.trim() || null,
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          napomena: dto.napomena?.trim() || null,
        },
      }),
    );
    return { data: row };
  }

  /** Izmena glave (RB-57) — typed PATCH + updatedAt (paritet 1.0); P2025 → 404. */
  async updateMachineHead(id: string, dto: UpdateMachineHeadDto) {
    const data: Prisma.RevMachineHeadUpdateInput = { updatedAt: new Date() };
    if (dto.oznaka !== undefined) data.oznaka = dto.oznaka.trim();
    if (dto.naziv !== undefined) data.naziv = dto.naziv.trim();
    if (dto.tip !== undefined) data.tip = dto.tip?.trim() || null;
    if (dto.serijskiBroj !== undefined)
      data.serijskiBroj = dto.serijskiBroj?.trim() || null;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.napomena !== undefined)
      data.napomena = dto.napomena?.trim() || null;
    try {
      const row = await this.sy15.db.revMachineHead.update({
        where: { id },
        data,
      });
      return { data: row };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        throw new NotFoundException(`Glava ${id} ne postoji`);
      }
      throw e;
    }
  }

  /** Brisanje glave (RB-57) — typed DELETE; P2025 → 404. */
  async deleteMachineHead(id: string) {
    try {
      await this.sy15.db.revMachineHead.delete({ where: { id } });
      return { data: { id } };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        throw new NotFoundException(`Glava ${id} ne postoji`);
      }
      throw e;
    }
  }

  // ---------- Rezni alat (rev_cutting_tool_catalog) ----------

  /**
   * Katalog reznog alata sa RAZDVOJENIM stanjem (RC-06 — kraj „tihe laži").
   *
   * 1.0 (`src/services/reversiService.js#fetchCuttingToolCatalog` + `reznialat.js`)
   * NE sabira sve lokacije u jedno „Na stanju"; razdvaja dva pojma:
   *   - `inWarehouseQty` = SUM(on_hand_qty) SAMO po lokacijama `loc_locations.location_type = 'WAREHOUSE'`
   *     (magacinski raspoloživo — po ovome okida semafor niske zalihe: `wh < min`),
   *   - `onMachinesQty` = SUM(outstanding_qty) iz `v_rev_cts_machine_stock` (izdato-a-nevraćeno
   *     po mašini, iz stavki dokumenata — ISTI izvor kao 1.0 front, ne ZADU-M stock red).
   * `onHandQty` = UKUPNO = inWarehouse + onMachines (paritet 1.0 `total_on_hand`).
   *
   * Ranije: `onHandQty = SUM(on_hand_qty)` po SVIM lokacijama → prikazivalo je „ukupno ikad
   * seedovano", pa je magacin izgledao pun i kad je sve izdato po mašinama (semafor nije okidao).
   */
  async listCuttingTools(q?: string) {
    const term = (q ?? "").trim();
    const where: Prisma.RevCuttingToolCatalogWhereInput = term
      ? {
          OR: [
            { oznaka: { contains: term, mode: "insensitive" } },
            { naziv: { contains: term, mode: "insensitive" } },
            { barcode: { contains: term, mode: "insensitive" } },
          ],
        }
      : {};
    const catalog = await this.sy15.db.revCuttingToolCatalog.findMany({
      where,
      orderBy: { oznaka: "asc" },
      take: 500,
    });
    if (catalog.length === 0) return { data: [] };

    const ids = Prisma.join(catalog.map((c) => Prisma.sql`${c.id}::uuid`));
    // Magacinski raspoloživo (samo WAREHOUSE lokacije) — paritet 1.0 in_warehouse_qty.
    const warehouse = await this.sy15.db.$queryRaw<
      { catalog_id: string; qty: number }[]
    >(Prisma.sql`
      SELECT s.catalog_id::text AS catalog_id, COALESCE(SUM(s.on_hand_qty), 0)::float8 AS qty
      FROM rev_cutting_tool_stock s
      JOIN loc_locations l ON l.id = s.location_id
      WHERE s.catalog_id IN (${ids}) AND l.location_type = 'WAREHOUSE'
      GROUP BY s.catalog_id`);
    // Izdato po mašinama (iz stavki dokumenata) — paritet 1.0 on_machines_qty.
    const machines = await this.sy15.db.$queryRaw<
      { catalog_id: string; qty: number }[]
    >(Prisma.sql`
      SELECT ms.catalog_id::text AS catalog_id, COALESCE(SUM(ms.outstanding_qty), 0)::float8 AS qty
      FROM v_rev_cts_machine_stock ms
      WHERE ms.catalog_id IN (${ids}) AND ms.outstanding_qty > 0
      GROUP BY ms.catalog_id`);

    const whBy = new Map(
      warehouse.map((r) => [r.catalog_id, Number(r.qty) || 0]),
    );
    const machBy = new Map(
      machines.map((r) => [r.catalog_id, Number(r.qty) || 0]),
    );
    const data = catalog.map((c) => {
      const inWarehouseQty = whBy.get(c.id) ?? 0;
      const onMachinesQty = machBy.get(c.id) ?? 0;
      return {
        ...c,
        inWarehouseQty,
        onMachinesQty,
        onHandQty: inWarehouseQty + onMachinesQty,
      };
    });
    return { data };
  }

  /**
   * Otvorene ISSUED linije reznog alata koje je PRIJAVLJENI korisnik potpisano preuzeo
   * (podrška povraćaju — RC-17/RC-32). Izvor = `v_rev_my_issued_cutting_tools`
   * (security_invoker view, scope po `rev_current_employee_id()` iz GUC claims — kroz
   * `withUser`, isti most kao sibling „moji" pregledi reportMy*). Vraća SAMO linije za
   * skenirani barkod kad je zadat (paritet 1.0 `cuttingToolScannerModal` FIFO logike),
   * sortirano po `issuedAt` ASC (najstariji revers prvi). Dostupno svima sa `reversi.read`
   * (1.0: povraćaj NIJE role-gated na otkrivanju linija).
   */
  async cuttingOpenLines(email: string, barcodeRaw?: string) {
    const barcode = this.normalizeBarcode(barcodeRaw);
    const rows = await this.sy15.withUser(
      email,
      (tx) => tx.$queryRaw<CuttingOpenLineRow[]>`
        SELECT line_id, document_id, doc_number, catalog_id, barcode, oznaka, naziv,
               quantity::float8            AS quantity,
               returned_quantity::float8   AS returned_quantity,
               remaining_quantity::float8  AS remaining_quantity,
               unit, recipient_machine_code, issued_at, expected_return_date,
               line_status, document_status
        FROM v_rev_my_issued_cutting_tools
        WHERE (${barcode} = '' OR barcode = ${barcode})
        ORDER BY issued_at ASC, doc_number ASC`,
    );
    const data = rows.map((r) => ({
      lineId: r.line_id,
      documentId: r.document_id,
      docNumber: r.doc_number,
      catalogId: r.catalog_id,
      barcode: r.barcode,
      oznaka: r.oznaka,
      naziv: r.naziv,
      issuedQty: Number(r.quantity) || 0,
      returnedQty: Number(r.returned_quantity) || 0,
      remainingQty: Number(r.remaining_quantity) || 0,
      unit: r.unit,
      machineCode: r.recipient_machine_code,
      issuedAt: r.issued_at,
      expectedReturnDate: r.expected_return_date,
      lineStatus: r.line_status,
      documentStatus: r.document_status,
    }));
    return { data };
  }

  async createCuttingTool(email: string, dto: CuttingToolCreateDto) {
    return this.sy15.withUser(email, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO rev_cutting_tool_catalog (oznaka, naziv, unit, min_stock_qty, compatible_machine_codes, napomena, created_by)
        VALUES (${dto.oznaka.trim()}, ${dto.naziv.trim()}, ${dto.unit ?? "kom"},
          ${dto.minStockQty ?? 0}, ${dto.compatibleMachineCodes ?? []}::text[],
          ${dto.napomena ?? null}, auth.uid())
        RETURNING id`;
      return { data: { id: rows[0]?.id } };
    });
  }

  async updateCuttingTool(
    email: string,
    id: string,
    dto: CuttingToolUpdateDto,
  ) {
    try {
      const data = await this.sy15.db.revCuttingToolCatalog.update({
        where: { id },
        data: {
          ...(dto.naziv !== undefined ? { naziv: dto.naziv.trim() } : {}),
          ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
          ...(dto.minStockQty !== undefined
            ? { minStockQty: dto.minStockQty }
            : {}),
          ...(dto.compatibleMachineCodes !== undefined
            ? { compatibleMachineCodes: dto.compatibleMachineCodes }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.napomena !== undefined ? { napomena: dto.napomena } : {}),
        },
      });
      return { data };
    } catch (e) {
      // PR-01: typed Prisma UPDATE nad nepostojećim id baca P2025 „record not found".
      // Ovde je CRUD po PK (nije RLS-filtrovan 0-red slučaj), pa je semantika 404
      // (kao Lokacije `updateLocation` — sy15-error kanon P2025→403 važi za RLS put).
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2025"
      ) {
        throw new NotFoundException(`Rezni alat ${id} ne postoji`);
      }
      throw e;
    }
  }

  /** Rezni alat po mašini (v_rev_cts_by_machine) — opcioni filter po šifri mašine. */
  async cuttingByMachine(machineCode?: string) {
    const data = machineCode
      ? await this.sy15.db
          .$queryRaw`SELECT * FROM v_rev_cts_by_machine WHERE machine_code = ${machineCode}`
      : await this.sy15.db.$queryRaw`SELECT * FROM v_rev_cts_by_machine`;
    return { data };
  }

  /** Glave na kartici mašine (rev_machine_heads). */
  async machineHeads(machineCode: string) {
    const data = await this.sy15.db.revMachineHead.findMany({
      where: { machineCode },
      orderBy: { oznaka: "asc" },
    });
    return { data };
  }

  /**
   * Bulk-import inventara ručnog alata (paritet 1.0 bulkImportModal tip 1).
   * Idempotentno po `oznaka` (postojeći alat = skip). Barkod/loc_item_ref_id
   * dodeljuju trigeri. Vraća zbir kreiranih/preskočenih + greške po redu.
   * Alat je odmah upotrebljiv u Izdaj (početno smeštanje u magacin je opcioni
   * follow-up — izdavanje uzima iz null lokacije bez problema).
   */
  async bulkImportTools(rows: BulkToolRowDto[]) {
    let created = 0;
    let skipped = 0;
    const errors: { oznaka: string; error: string }[] = [];

    for (const row of rows) {
      const oznaka = row.oznaka.trim();
      try {
        const existing = await this.sy15.db.revTool.findFirst({
          where: { oznaka },
          select: { id: true },
        });
        if (existing) {
          skipped++;
          continue;
        }
        const isQuantity = row.isQuantity ?? false;
        const isConsumable = row.isConsumable ?? false;
        await this.sy15.db.revTool.create({
          data: {
            oznaka,
            naziv: row.naziv.trim(),
            serijskiBroj: row.serijskiBroj?.trim() || null,
            // RA-24: klasifikacija + datum kupovine (1.0 uvoz ih mapira; pilot ih je gubio).
            subgroupId: row.subgroupId ?? null,
            subsubgroupId: row.subsubgroupId ?? null,
            datumKupovine: row.datumKupovine
              ? new Date(row.datumKupovine)
              : null,
            isQuantity,
            isConsumable,
            totalQty: isQuantity || isConsumable ? (row.totalQty ?? 0) : 1,
            napomena: row.napomena?.trim() || null,
            status: "active",
          },
        });
        created++;
      } catch (e) {
        errors.push({
          oznaka,
          error: e instanceof Error ? e.message : "greška",
        });
      }
    }
    return { data: { created, skipped, errors, total: rows.length } };
  }

  /**
   * Picker radnika za Izdaj modal (RB-35 — izbor primaoca po imenu/odeljenju/poziciji).
   * Paritet 1.0 `fetchEmployees`: vraća I NEAKTIVNE (FE ih prikazuje zasivljeno sa
   * badžom „neaktivan" — `is_active=false`), pretraga matchuje i `position`, aktivni
   * idu prvi. Bez PII (samo ime/odeljenje/pozicija). Izbor po kartici/bedžu ide kroz
   * `lookupBarcode` (EMPLOYEE grana, `card_barcode`).
   */
  async lookupEmployees(q?: string) {
    const raw = (q ?? "").trim();
    const term = `%${raw}%`;
    const data = await this.sy15.db.$queryRaw`
      SELECT id, full_name, department, "position", is_active
      FROM employees
      WHERE (${raw} = '' OR full_name ILIKE ${term} OR department ILIKE ${term}
             OR "position" ILIKE ${term})
      ORDER BY is_active DESC, full_name ASC
      LIMIT 50`;
    return { data };
  }

  /**
   * Aktivne lokacije za dropdown povraćaja (RB-45 — izbor lokacije u kojoj se alat
   * vraća) i izbor magacina pri seed-u/smestaju. Paritet 1.0 `fetchActiveLocations`.
   * Klasni default `reversi.read`. FE prosleđuje izabrani `id` kao
   * `return_to_location_id` u `POST /return` (bez izbora BE koristi ALAT-MAG-01).
   */
  async lookupLocations() {
    const data = await this.sy15.db.$queryRaw`
      SELECT id, location_code, name, location_type
      FROM loc_locations
      WHERE is_active IS TRUE
      ORDER BY location_code ASC
      LIMIT 500`;
    return { data };
  }

  /**
   * Razrešavanje skeniranog/otkucanog barkoda → tip + zapis (paritet 1.0
   * `resolveReversiBarcode` + `normalizeBarcodeText`):
   *   ALAT-NNNNNN → HAND (rev_tools.barcode),
   *   RZN-NNNNNN  → CUTTING (rev_cutting_tool_catalog.barcode),
   *   inače 4–16 alnum → EMPLOYEE (employees.card_barcode).
   * `data:null` = format prepoznat ali nema zapisa; `kind:UNKNOWN` = nepoznat format.
   */
  async lookupBarcode(raw?: string): Promise<{
    data: {
      kind: "HAND" | "CUTTING" | "EMPLOYEE" | "UNKNOWN";
      barcode: string;
      record: unknown;
    };
  }> {
    const barcode = this.normalizeBarcode(raw);
    if (!barcode)
      return { data: { kind: "UNKNOWN", barcode: "", record: null } };

    if (/^ALAT-\d{6}$/i.test(barcode)) {
      const rows = await this.sy15.db.revTool.findMany({
        where: { barcode },
        take: 1,
      });
      return { data: { kind: "HAND", barcode, record: rows[0] ?? null } };
    }
    if (/^RZN-\d{6}$/i.test(barcode)) {
      const rows = await this.sy15.db.revCuttingToolCatalog.findMany({
        where: { barcode },
        take: 1,
      });
      return { data: { kind: "CUTTING", barcode, record: rows[0] ?? null } };
    }
    if (/^[A-Z0-9]{4,16}$/i.test(barcode)) {
      const rows = await this.sy15.db.$queryRaw<
        { id: string; full_name: string; department: string | null }[]
      >`
        SELECT id, full_name, department FROM employees
        WHERE card_barcode = ${barcode} AND is_active IS TRUE LIMIT 1`;
      return { data: { kind: "EMPLOYEE", barcode, record: rows[0] ?? null } };
    }
    return { data: { kind: "UNKNOWN", barcode, record: null } };
  }

  /** Paritet 1.0 `normalizeBarcodeText`: skini *…* okvir, CR/LF/TAB i nevidljive znakove. */
  private normalizeBarcode(raw?: string): string {
    let t = String(raw ?? "")
      .replace(/[\r\n\t]+/g, "")
      .trim();
    if (t.startsWith("*") && t.endsWith("*") && t.length >= 3)
      t = t.slice(1, -1);
    // Zero-width space/joiner/BOM (U+200B–U+200D, U+FEFF) — bez regex-literala
    // da izvor ostane čist ASCII (eslint no-irregular-whitespace).
    const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);
    return [...t]
      .filter((ch) => !ZERO_WIDTH.has(ch.codePointAt(0)!))
      .join("")
      .trim();
  }

  // ---------- R2: transakcione akcije (Faza A — postojeće DB fn u tx + GUC + idempotency) ----------
  // DB fn SAME gate-uju rev_can_manage() iz GUC claims (drugi sloj posle guard-a) i
  // SAME drže atomarnost rev_* ↔ loc_* (spec §0). Greške: 42501→403, P0001→422, 23505→409.

  /** Izdavanje TOOL/COOPERATION_GOODS reversa — `rev_issue_reversal(jsonb)`. */
  issue(email: string, dto: JsonPayloadTxDto) {
    return this.callJsonFn(email, dto, "reversi.issue", "rev_issue_reversal");
  }

  /**
   * Povraćaj ručnog/kooperacije — `rev_confirm_return(jsonb)`.
   * Ako klijent ne pošalje `return_to_location_id`, backend ga popuni magacinom
   * `ALAT-MAG-01` (isti default koji 1.0 front hardkoduje — `MAG_CODE`).
   */
  async confirmReturn(email: string, dto: JsonPayloadTxDto) {
    if (!dto.payload.return_to_location_id) {
      const rows = await this.sy15.db.$queryRaw<{ id: string }[]>`
        SELECT id FROM loc_locations WHERE location_code = 'ALAT-MAG-01' LIMIT 1`;
      if (!rows[0]) {
        throw new UnprocessableEntityException(
          "Magacin ALAT-MAG-01 ne postoji u loc_locations — pošalji return_to_location_id",
        );
      }
      dto.payload.return_to_location_id = rows[0].id;
    }
    return this.callJsonFn(email, dto, "reversi.return", "rev_confirm_return");
  }

  /**
   * Izdavanje reznog alata na mašinu — `rev_issue_cutting_reversal(jsonb)`.
   * Ako `source_location_id` nije prosleđen, koristi magacin ALAT-MAG-01 (odakle
   * se rezni skida u mašinu — inače dekrement padne na lokaciju sa 0 → 23514).
   */
  async cuttingIssue(email: string, dto: JsonPayloadTxDto) {
    if (!dto.payload.source_location_id) {
      const rows = await this.sy15.db.$queryRaw<{ id: string }[]>`
        SELECT id FROM loc_locations WHERE location_code = 'ALAT-MAG-01' LIMIT 1`;
      if (rows[0]) dto.payload.source_location_id = rows[0].id;
    }
    return this.callJsonFn(
      email,
      dto,
      "reversi.cutting-issue",
      "rev_issue_cutting_reversal",
    );
  }

  /** Povraćaj reznog u magacin — `rev_confirm_cutting_return(jsonb)`. */
  cuttingReturn(email: string, dto: JsonPayloadTxDto) {
    return this.callJsonFn(
      email,
      dto,
      "reversi.cutting-return",
      "rev_confirm_cutting_return",
    );
  }

  /** Prijem/korekcija zalihe količinskog alata — `rev_hand_tool_apply_delta`. */
  async stockDelta(email: string, toolId: string, dto: StockDeltaDto) {
    return this.runTx(
      email,
      dto.clientEventId,
      "reversi.stock-delta",
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: number }[]>`
        SELECT rev_hand_tool_apply_delta(${toolId}::uuid, ${dto.delta}::int,
          ${dto.reason}, ${dto.note ?? null}) AS result`;
        return rows[0]?.result ?? null;
      },
    );
  }

  /** Inicijalno stanje reznog po lokaciji — `rev_cutting_tool_seed_stock`. */
  async seedStock(email: string, catalogId: string, dto: SeedStockDto) {
    let locationId = dto.locationId;
    if (!locationId) {
      const rows = await this.sy15.db.$queryRaw<{ id: string }[]>`
        SELECT id FROM loc_locations WHERE location_code = 'ALAT-MAG-01' LIMIT 1`;
      if (!rows[0]) {
        throw new UnprocessableEntityException(
          "Magacin ALAT-MAG-01 ne postoji — pošalji locationId",
        );
      }
      locationId = rows[0].id;
    }
    const locId = locationId;
    return this.runTx(
      email,
      dto.clientEventId,
      "reversi.seed-stock",
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT rev_cutting_tool_seed_stock(${catalogId}::uuid, ${locId}::uuid,
          ${dto.qty}::numeric) AS result`;
        return rows[0]?.result ?? null;
      },
    );
  }

  /** Otpis alata — `rev_write_off_tool`. */
  async writeOff(email: string, toolId: string, dto: WriteOffDto) {
    return this.runTx(
      email,
      dto.clientEventId,
      "reversi.write-off",
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT rev_write_off_tool(${toolId}::uuid, ${dto.razlog ?? null},
          ${dto.datum ?? null}::date, ${dto.status ?? "scrapped"}) AS result`;
        return rows[0]?.result ?? null;
      },
    );
  }

  /** Vraćanje otpisanog alata u upotrebu — `rev_restore_tool`. */
  async restore(email: string, toolId: string, dto: TxBaseDto) {
    return this.runTx(
      email,
      dto.clientEventId,
      "reversi.restore",
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT rev_restore_tool(${toolId}::uuid) AS result`;
        return rows[0]?.result ?? null;
      },
    );
  }

  /** Zajednički put za jsonb pass-through funkcije (issue/return varijante). */
  private callJsonFn(
    email: string,
    dto: JsonPayloadTxDto,
    action: string,
    fnName: string,
  ) {
    return this.runTx(email, dto.clientEventId, action, async (tx) => {
      // fnName je iz zatvorenog skupa iznad (nije korisnički unos) — sme u Unsafe.
      const rows = await tx.$queryRawUnsafe<{ result: unknown }[]>(
        `SELECT ${fnName}($1::jsonb) AS result`,
        JSON.stringify(dto.payload),
      );
      return rows[0]?.result ?? null;
    });
  }

  private async runTx<T>(
    email: string,
    clientEventId: string,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ) {
    try {
      const outcome = await this.sy15.runIdempotent(
        email,
        clientEventId,
        action,
        fn,
      );
      return { data: outcome.result, meta: { idempotent: outcome.idempotent } };
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** SQLSTATE iz DB fn → HTTP semantika (spec §5). */
  private rethrowSy15(e: unknown): never {
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const message = meta?.message ?? (e as Error).message;
    if (meta?.code === "42501") throw new ForbiddenException(message);
    if (meta?.code === "P0001" || meta?.code === "P0002")
      throw new UnprocessableEntityException(message);
    if (meta?.code === "23505") throw new ConflictException(message);
    // 23514 = check constraint (npr. negativna zaliha reznog) — poslovna greška, ne 500.
    if (meta?.code === "23514") throw new UnprocessableEntityException(message);
    // Klasifikacija DEFINER fn (rev_add_inventory_*): 22023 = prazan naziv/grupa,
    // 23503 = grupa/podgrupa ne postoji — poslovne validacije, ne 500.
    if (meta?.code === "22023" || meta?.code === "23503")
      throw new UnprocessableEntityException(message);
    throw e;
  }

  // ---------- R2: potpisnica PDF (bucket `reversal-pdf` u sy15 storage-api, spec §7) ----------
  // Paritet 1.0: putanja u bucketu = `${docNumber.replace(/[^\w.\-]+/g,'_')}.pdf`,
  // `pdf_storage_path` = ta ista bucket-relativna putanja (1.0 UI je čita u
  // paralelnom radu — format se NE menja). Za razliku od 1.0 (fire-and-forget,
  // greška progutana), ovde je upload deo odgovora: 4xx/5xx → klijent zna i ponovi.

  async uploadSignaturePdf(id: string, file?: Express.Multer.File) {
    if (!file?.buffer?.length || file.mimetype !== "application/pdf") {
      throw new UnprocessableEntityException(
        "Očekivan PDF fajl (multipart polje `file`)",
      );
    }
    const doc = await this.sy15.db.revDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException(`Reversi dokument ${id} ne postoji`);
    const { base, key } = this.storageCfg();
    const path = `${doc.docNumber.replace(/[^\w.-]+/g, "_")}.pdf`;
    const res = await fetch(
      `${base}/object/reversal-pdf/${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/pdf",
          "x-upsert": "true",
        },
        body: new Uint8Array(file.buffer),
      },
    );
    if (!res.ok) {
      throw new UnprocessableEntityException(
        `Upload potpisnice nije uspeo (storage ${res.status}: ${(await res.text()).slice(0, 200)})`,
      );
    }
    await this.sy15.db.revDocument.update({
      where: { id },
      data: { pdfStoragePath: path, pdfGeneratedAt: new Date() },
    });
    return { data: { path } };
  }

  async getSignaturePdfUrl(id: string) {
    const doc = await this.sy15.db.revDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException(`Reversi dokument ${id} ne postoji`);
    if (!doc.pdfStoragePath)
      throw new NotFoundException(
        "Dokument nema potpisnicu (pdf_storage_path prazan)",
      );
    const { base, key } = this.storageCfg();
    const res = await fetch(
      `${base}/object/sign/reversal-pdf/${encodeURIComponent(doc.pdfStoragePath)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      },
    );
    if (!res.ok) {
      // PR-02: `pdf_storage_path` je popunjen ali objekat NE postoji u bucketu
      // (npr. bulk-import dokument kome PDF nikad nije generisan/otpremljen, ili je
      // obrisan). storage-api tada vraća 404 (ili 400 „Object not found"). PDF
      // potpisnice pravi i uploaduje KLIJENT (POST varijanta) — BE ga NE može
      // regenerisati iz podataka (nema server-side generatora), pa je ispravan
      // odgovor čist 404 sa jasnom porukom, a ne obmanjujući 422 „potpisivanje nije uspelo".
      const bodyText = (await res.text()).slice(0, 300);
      if (
        res.status === 404 ||
        (res.status === 400 && /not.?found/i.test(bodyText))
      ) {
        throw new NotFoundException(
          `Potpisnica za dokument ${doc.docNumber} ne postoji u skladištu — regeneriši i otpremi PDF (POST /reversi/documents/${id}/signature-pdf).`,
        );
      }
      throw new UnprocessableEntityException(
        `Potpisivanje URL-a nije uspelo (storage ${res.status})`,
      );
    }
    const body = (await res.json()) as { signedURL?: string };
    if (!body.signedURL)
      throw new UnprocessableEntityException(
        "storage-api nije vratio signedURL",
      );
    return { data: { url: `${base}${body.signedURL}`, expiresIn: 3600 } };
  }

  /** sy15 storage-api (isti stack kao PostgREST — javno `/storage/v1` kroz gateway). */
  private storageCfg() {
    const base = process.env.SY15_STORAGE_URL?.replace(/\/$/, "");
    const key = process.env.SY15_SERVICE_KEY;
    if (!base || !key) {
      throw new ServiceUnavailableException(
        "sy15 storage nije konfigurisan (SY15_STORAGE_URL / SY15_SERVICE_KEY)",
      );
    }
    return { base, key };
  }
}

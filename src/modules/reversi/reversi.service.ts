import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
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
  docType?: string;
  q?: string;
  page?: string;
  pageSize?: string;
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
  constructor(private readonly sy15: Sy15Service) {}

  // ---------- Dokumenti (reversi) ----------

  async listDocuments(query: ListDocumentsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.RevDocumentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.docType ? { docType: query.docType } : {}),
      ...(query.q
        ? {
            OR: [
              { docNumber: { contains: query.q, mode: "insensitive" } },
              {
                recipientEmployeeName: {
                  contains: query.q,
                  mode: "insensitive",
                },
              },
              {
                recipientDepartment: { contains: query.q, mode: "insensitive" },
              },
              {
                recipientCompanyName: {
                  contains: query.q,
                  mode: "insensitive",
                },
              },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.sy15.db.revDocument.findMany({
        where,
        orderBy: { issuedAt: "desc" },
        skip,
        take,
      }),
      this.sy15.db.revDocument.count({ where }),
    ]);
    return { data, meta: pageMeta(page, pageSize, total) };
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
    return {
      data: {
        ...doc,
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
        orderBy: { datum: "desc" },
      }),
    ]);
    return { data: { ...tool, batteries, services } };
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

  /** Mašine za Reversi kontekst (view nad maint_machines; u 1.0 REVOKE anon — ovde JWT + reversi.read). */
  async reportMachines() {
    const data = await this.sy15.db.$queryRaw`SELECT * FROM v_rev_machines`;
    return { data };
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

    const ids = Prisma.join(
      catalog.map((c) => Prisma.sql`${c.id}::uuid`),
    );
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

    const whBy = new Map(warehouse.map((r) => [r.catalog_id, Number(r.qty) || 0]));
    const machBy = new Map(machines.map((r) => [r.catalog_id, Number(r.qty) || 0]));
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

  /** Picker radnika za Izdaj modal (paritet 1.0 fetchEmployees — samo aktivni, bez PII). */
  async lookupEmployees(q?: string) {
    const term = `%${(q ?? "").trim()}%`;
    const data = await this.sy15.db.$queryRaw`
      SELECT id, full_name, department, "position"
      FROM employees
      WHERE is_active IS TRUE
        AND (${(q ?? "").trim()} = '' OR full_name ILIKE ${term} OR department ILIKE ${term})
      ORDER BY full_name ASC
      LIMIT 50`;
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
    if (meta?.code === "P0001" || meta?.code === "P0002") throw new UnprocessableEntityException(message);
    if (meta?.code === "23505") throw new ConflictException(message);
    // 23514 = check constraint (npr. negativna zaliha reznog) — poslovna greška, ne 500.
    if (meta?.code === "23514") throw new UnprocessableEntityException(message);
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
      if (res.status === 404 || (res.status === 400 && /not.?found/i.test(bodyText))) {
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

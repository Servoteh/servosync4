import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
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

  // ---------- R2: transakcione akcije (Faza A — postojeće DB fn u tx + GUC + idempotency) ----------
  // DB fn SAME gate-uju rev_can_manage() iz GUC claims (drugi sloj posle guard-a) i
  // SAME drže atomarnost rev_* ↔ loc_* (spec §0). Greške: 42501→403, P0001→422, 23505→409.

  /** Izdavanje TOOL/COOPERATION_GOODS reversa — `rev_issue_reversal(jsonb)`. */
  issue(email: string, dto: JsonPayloadTxDto) {
    return this.callJsonFn(email, dto, "reversi.issue", "rev_issue_reversal");
  }

  /** Povraćaj ručnog/kooperacije — `rev_confirm_return(jsonb)`. */
  confirmReturn(email: string, dto: JsonPayloadTxDto) {
    return this.callJsonFn(email, dto, "reversi.return", "rev_confirm_return");
  }

  /** Izdavanje reznog alata na mašinu — `rev_issue_cutting_reversal(jsonb)`. */
  cuttingIssue(email: string, dto: JsonPayloadTxDto) {
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
    return this.runTx(
      email,
      dto.clientEventId,
      "reversi.seed-stock",
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT rev_cutting_tool_seed_stock(${catalogId}::uuid, ${dto.locationId}::uuid,
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
      const rows = await tx.$queryRawUnsafe(
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
    if (meta?.code === "P0001") throw new UnprocessableEntityException(message);
    if (meta?.code === "23505") throw new ConflictException(message);
    throw e;
  }
}

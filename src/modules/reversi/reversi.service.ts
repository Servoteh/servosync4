import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service } from "../../common/sy15/sy15.service";
import { pageMeta, parsePagination } from "../../common/pagination";

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
}

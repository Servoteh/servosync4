import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";

/**
 * Maksimalna dubina rekurzije za BOM / where-used CTE upite.
 * OBAVEZAN anti-ciklus guard (BACKEND_RULES §11.4): path array + cycle flag +
 * tvrdi limit dubine — PG bez toga visi na cikličnoj sastavnici.
 */
export const MAX_BOM_DEPTH = 20;

export interface ListDrawingsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: broj crteža / identbroj (catalog) / naziv. */
  q?: string;
  revision?: string;
  material?: string;
  /** Projektant (designed_by). */
  designedBy?: string;
  statusId?: string;
  /** "true" | "false" — kupovni vs proizvedeni delovi. */
  isProcurement?: string;
}

export interface BomQuery {
  /** Broj nivoa (1 = samo direktne komponente); default i max 20. */
  depth?: string;
  /** "true" — preskoči ugnježdeno stablo, vrati samo flat listu. */
  expandAll?: string;
}

export interface WhereUsedQuery {
  /** "true" — svi tranzitivni parent-i (CTE); default samo direktni. */
  recursive?: string;
}

export interface ImportLogQuery {
  page?: string;
  pageSize?: string;
  /** "true" | "false" — filter po uspehu uvoza. */
  success?: string;
  /** "true" | "false" — filter kritičnih grešaka. */
  isCritical?: string;
}

/** Sažetak crteža za BOM/where-used čvorove i flat liste. */
const DRAWING_SUMMARY_SELECT = {
  id: true,
  drawingNumber: true,
  revision: true,
  catalogNumber: true,
  name: true,
  material: true,
  isProcurement: true,
  weight: true,
  pdmStatus: true,
} as const;

type DrawingSummary = Prisma.DrawingGetPayload<{
  select: typeof DRAWING_SUMMARY_SELECT;
}>;

/** Red rekurzivnog CTE nad drawing_components (BOM i where-used dele oblik). */
interface ComponentEdgeRow {
  component_id: number;
  parent_drawing_id: number;
  child_drawing_id: number;
  required_quantity: number;
  /** bigint u SQL-u da množenje kroz nivoe ne prekorači int4. */
  total_quantity: bigint;
  depth: number;
  path: number[];
  is_cycle: boolean;
}

export interface BomTreeNode {
  componentId: number;
  drawing: DrawingSummary | null;
  /** Količina po jednom komadu neposrednog parent-a. */
  requiredQuantity: number;
  /** Količina po jednom komadu korenskog sklopa (pomnoženo kroz nivoe). */
  totalQuantity: number;
  depth: number;
  /** Ciklus u sastavnici — grana je presečena, children su prazni. */
  isCycle: boolean;
  children: BomTreeNode[];
}

/**
 * PDM (Projektna dokumentacija) — READ-ONLY katalog crteža.
 *
 * Piše se tek kroz PDM sync / XML import (kasnije). BOM se gradi ISKLJUČIVO
 * nad `drawing_components` (12.426 redova u sync-u); `drawing_assemblies` je
 * u sync-u PRAZNA i namerno se ignoriše (MODULE_SPEC_pdm Q1 — semantika
 * tabele nerazjašnjena).
 *
 * Orphan FK pravilo: nikad include/select nad obaveznom to-one relacijom
 * (npr. Drawing.status, statusId default 0 bez reda u drawing_statuses) —
 * FK skalari se batch-razrešavaju kao u work-orders.service.ts.
 */
@Injectable()
export class PdmService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- LISTA

  async listDrawings(query: ListDrawingsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.DrawingWhereInput = {};
    if (query.q) {
      where.OR = [
        { drawingNumber: { contains: query.q, mode: "insensitive" } },
        { catalogNumber: { contains: query.q, mode: "insensitive" } },
        { name: { contains: query.q, mode: "insensitive" } },
      ];
    }
    if (query.revision) {
      where.revision = { equals: query.revision, mode: "insensitive" };
    }
    if (query.material) {
      where.material = { contains: query.material, mode: "insensitive" };
    }
    if (query.designedBy) {
      where.designedBy = { contains: query.designedBy, mode: "insensitive" };
    }
    const intEq = (v: string | undefined) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isNaN(n) ? undefined : n;
    };
    where.statusId = intEq(query.statusId);
    if (query.isProcurement === "true") where.isProcurement = true;
    else if (query.isProcurement === "false") where.isProcurement = false;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.drawing.findMany({
        where,
        orderBy: [
          { createdAt: { sort: "desc", nulls: "last" } },
          { id: "desc" },
        ],
        skip,
        take,
        select: {
          id: true,
          drawingNumber: true,
          revision: true,
          catalogNumber: true,
          name: true,
          material: true,
          dimensions: true,
          weight: true,
          marking: true,
          isProcurement: true,
          pdmStatus: true,
          statusId: true,
          designedBy: true,
          designDate: true,
          approvedBy: true,
          approvedDate: true,
          fileName: true,
          projectName: true,
          workOrderRef: true,
          createdAt: true,
        },
      }),
      this.prisma.drawing.count({ where }),
    ]);

    const statuses = await this.resolveStatuses(rows.map((r) => r.statusId));
    const data = rows.map((r) => ({
      ...r,
      status: statuses.get(r.statusId) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  // ---------------------------------------------------------------- DETALJ

  async findDrawing(id: number) {
    const drawing = await this.prisma.drawing.findUnique({ where: { id } });
    if (!drawing) throw new NotFoundException(`Crtež ${id} ne postoji`);

    const [statuses, pdf, importLog, componentCount, whereUsedCount] =
      await Promise.all([
        this.resolveStatuses([drawing.statusId]),
        this.findPdfMeta(drawing.drawingNumber, drawing.revision),
        // Heuristika: import log nema FK ka crtežu — XML fajlovi su imenovani
        // po broju crteža (npr. "1086951_B.xml"), pa se veže startsWith.
        this.prisma.drawingImportLog.findMany({
          where: { fileName: { startsWith: drawing.drawingNumber } },
          orderBy: [{ importedAt: "desc" }, { id: "desc" }],
          take: 5,
        }),
        this.prisma.drawingComponent.count({
          where: { parentDrawingId: id },
        }),
        this.prisma.drawingComponent.count({ where: { childDrawingId: id } }),
      ]);

    const data = {
      ...drawing,
      status: statuses.get(drawing.statusId) ?? null,
      /** Metapodaci PDF-a (bez binarnog sadržaja); null ako PDF ne postoji. */
      pdf,
      /** Poslednji XML uvozi vezani za broj crteža (heuristika, nema FK). */
      importLog,
      componentCount,
      whereUsedCount,
    };
    return { data };
  }

  /**
   * PDF metapodaci iz drawing_pdfs — namerno raw upit da se `pdf_binary`
   * (bytea) nikad ne učitava; vraća se samo `hasBinary` indikator.
   */
  private async findPdfMeta(drawingNumber: string, revision: string) {
    const rows = await this.prisma.$queryRaw<
      {
        file_name: string | null;
        uploaded_at: Date;
        size_kb: number | null;
        uploaded_by: string | null;
        has_binary: boolean;
      }[]
    >`
      SELECT file_name, uploaded_at, size_kb, uploaded_by,
             (pdf_binary IS NOT NULL) AS has_binary
      FROM drawing_pdfs
      WHERE drawing_number = ${drawingNumber} AND revision = ${revision}
    `;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      fileName: r.file_name,
      uploadedAt: r.uploaded_at,
      sizeKb: r.size_kb,
      uploadedBy: r.uploaded_by,
      hasBinary: r.has_binary,
    };
  }

  /**
   * Uskladišten PDF crteža (`drawing_pdfs.pdf_binary`, bytea) za prikaz/preuzimanje.
   * 404 ako crtež ne postoji ili nema binarnog sadržaja (npr. samo metapodaci).
   */
  async getPdfContent(id: number): Promise<{ buffer: Buffer; fileName: string }> {
    const drawing = await this.prisma.drawing.findUnique({
      where: { id },
      select: { drawingNumber: true, revision: true },
    });
    if (!drawing) throw new NotFoundException(`Crtež ${id} ne postoji`);

    const pdf = await this.prisma.drawingPdf.findUnique({
      where: {
        drawingNumber_revision: {
          drawingNumber: drawing.drawingNumber,
          revision: drawing.revision,
        },
      },
      select: { pdfBinary: true, fileName: true },
    });
    if (!pdf?.pdfBinary)
      throw new NotFoundException(
        `PDF crteža ${drawing.drawingNumber} (rev ${drawing.revision}) nema uskladišten sadržaj.`,
      );

    const fileName =
      pdf.fileName?.trim() || `${drawing.drawingNumber}-${drawing.revision}.pdf`;
    return { buffer: Buffer.from(pdf.pdfBinary), fileName };
  }

  // ---------------------------------------------------------------- BOM

  /**
   * Rekurzivna sastavnica preko drawing_components.
   * Guard: path array + cycle flag + max dubina 20; količine se množe kroz
   * nivoe (bigint). Ciklične grane se seku, označe i NE ulaze u flat agregat.
   */
  async bom(id: number, query: BomQuery) {
    const root = await this.prisma.drawing.findUnique({
      where: { id },
      select: DRAWING_SUMMARY_SELECT,
    });
    if (!root) throw new NotFoundException(`Crtež ${id} ne postoji`);

    const maxDepth = this.clampDepth(query.depth);
    const expandAll = query.expandAll === "true";

    const rows = await this.queryDescendants(id, maxDepth);
    const drawings = await this.resolveDrawings(
      rows.map((r) => r.child_drawing_id),
    );

    // Ugnježdeno stablo — svaki CTE red je zaseban čvor (ključ = path).
    let tree: BomTreeNode[] | null = null;
    if (!expandAll) {
      tree = [];
      const nodeByPath = new Map<string, BomTreeNode>();
      for (const row of rows) {
        const node: BomTreeNode = {
          componentId: row.component_id,
          drawing: drawings.get(row.child_drawing_id) ?? null,
          requiredQuantity: row.required_quantity,
          totalQuantity: Number(row.total_quantity),
          depth: row.depth,
          isCycle: row.is_cycle,
          children: [],
        };
        nodeByPath.set(row.path.join(">"), node);
        if (row.depth === 1) tree.push(node);
        else
          nodeByPath.get(row.path.slice(0, -1).join(">"))?.children.push(node);
      }
    }

    // Flat lista sa agregiranim količinama (ciklične grane isključene).
    const agg = new Map<
      number,
      { totalQuantity: number; occurrences: number; minDepth: number }
    >();
    for (const row of rows) {
      if (row.is_cycle) continue;
      const a = agg.get(row.child_drawing_id) ?? {
        totalQuantity: 0,
        occurrences: 0,
        minDepth: row.depth,
      };
      a.totalQuantity += Number(row.total_quantity);
      a.occurrences += 1;
      a.minDepth = Math.min(a.minDepth, row.depth);
      agg.set(row.child_drawing_id, a);
    }
    const flat = [...agg.entries()]
      .map(([drawingId, a]) => ({
        drawing: drawings.get(drawingId) ?? null,
        ...a,
      }))
      .sort((x, y) =>
        (x.drawing?.drawingNumber ?? "").localeCompare(
          y.drawing?.drawingNumber ?? "",
        ),
      );

    const cyclesDetected = rows.filter((r) => r.is_cycle).length;
    const truncated = await this.isTruncatedAtDepth(rows, maxDepth);

    return {
      data: { drawing: root, tree, flat },
      meta: {
        depth: maxDepth,
        expandAll,
        componentRows: rows.length,
        cyclesDetected,
        truncated,
      },
    };
  }

  private async queryDescendants(id: number, maxDepth: number) {
    return this.prisma.$queryRaw<ComponentEdgeRow[]>`
      WITH RECURSIVE bom AS (
        SELECT dc.id AS component_id,
               dc.parent_drawing_id,
               dc.child_drawing_id,
               dc.required_quantity,
               dc.required_quantity::bigint AS total_quantity,
               1 AS depth,
               ARRAY[dc.parent_drawing_id, dc.child_drawing_id] AS path,
               dc.child_drawing_id = dc.parent_drawing_id AS is_cycle
        FROM drawing_components dc
        WHERE dc.parent_drawing_id = ${id}

        UNION ALL

        SELECT dc.id,
               dc.parent_drawing_id,
               dc.child_drawing_id,
               dc.required_quantity,
               b.total_quantity * dc.required_quantity,
               b.depth + 1,
               b.path || dc.child_drawing_id,
               dc.child_drawing_id = ANY(b.path)
        FROM drawing_components dc
        JOIN bom b ON dc.parent_drawing_id = b.child_drawing_id
        WHERE NOT b.is_cycle AND b.depth < ${maxDepth}
      )
      SELECT component_id, parent_drawing_id, child_drawing_id,
             required_quantity, total_quantity, depth, path, is_cycle
      FROM bom
      ORDER BY depth, component_id
    `;
  }

  // ---------------------------------------------------------------- WHERE-USED

  /**
   * Obrnuta sastavnica: direktni parent-i (default) ili tranzitivni preko
   * istog CTE naopako (?recursive=true), sa istim anti-ciklus guard-om.
   * `totalQuantity` = koliko komada ovog crteža ide u 1 komad parent-a
   * (proizvod količina duž putanje, sumirano po parent-u).
   */
  async whereUsed(id: number, query: WhereUsedQuery) {
    const drawing = await this.prisma.drawing.findUnique({
      where: { id },
      select: DRAWING_SUMMARY_SELECT,
    });
    if (!drawing) throw new NotFoundException(`Crtež ${id} ne postoji`);

    const recursive = query.recursive === "true";
    const maxDepth = recursive ? MAX_BOM_DEPTH : 1;

    const rows = await this.prisma.$queryRaw<ComponentEdgeRow[]>`
      WITH RECURSIVE used_in AS (
        SELECT dc.id AS component_id,
               dc.parent_drawing_id,
               dc.child_drawing_id,
               dc.required_quantity,
               dc.required_quantity::bigint AS total_quantity,
               1 AS depth,
               ARRAY[dc.child_drawing_id, dc.parent_drawing_id] AS path,
               dc.parent_drawing_id = dc.child_drawing_id AS is_cycle
        FROM drawing_components dc
        WHERE dc.child_drawing_id = ${id}

        UNION ALL

        SELECT dc.id,
               dc.parent_drawing_id,
               dc.child_drawing_id,
               dc.required_quantity,
               u.total_quantity * dc.required_quantity,
               u.depth + 1,
               u.path || dc.parent_drawing_id,
               dc.parent_drawing_id = ANY(u.path)
        FROM drawing_components dc
        JOIN used_in u ON dc.child_drawing_id = u.parent_drawing_id
        WHERE NOT u.is_cycle AND u.depth < ${maxDepth}
      )
      SELECT component_id, parent_drawing_id, child_drawing_id,
             required_quantity, total_quantity, depth, path, is_cycle
      FROM used_in
      ORDER BY depth, component_id
    `;

    // Agregacija po parent crtežu (ciklične grane isključene).
    const agg = new Map<
      number,
      { totalQuantity: number; occurrences: number; minDepth: number }
    >();
    for (const row of rows) {
      if (row.is_cycle) continue;
      const a = agg.get(row.parent_drawing_id) ?? {
        totalQuantity: 0,
        occurrences: 0,
        minDepth: row.depth,
      };
      a.totalQuantity += Number(row.total_quantity);
      a.occurrences += 1;
      a.minDepth = Math.min(a.minDepth, row.depth);
      agg.set(row.parent_drawing_id, a);
    }

    const parentIds = [...agg.keys()];
    const [parents, nonTopLevel] = await Promise.all([
      this.resolveDrawings(parentIds),
      this.findNonTopLevel(parentIds),
    ]);

    const usedIn = [...agg.entries()]
      .map(([parentId, a]) => ({
        drawing: parents.get(parentId) ?? null,
        totalQuantity: a.totalQuantity,
        occurrences: a.occurrences,
        depth: a.minDepth,
        isDirect: a.minDepth === 1,
        /** Nema daljih parent-a — vrh hijerarhije sklopova. */
        isTopLevel: !nonTopLevel.has(parentId),
      }))
      .sort(
        (x, y) =>
          x.depth - y.depth ||
          (x.drawing?.drawingNumber ?? "").localeCompare(
            y.drawing?.drawingNumber ?? "",
          ),
      );

    return {
      data: { drawing, usedIn },
      meta: {
        recursive,
        depth: maxDepth,
        cyclesDetected: rows.filter((r) => r.is_cycle).length,
        parentCount: usedIn.length,
      },
    };
  }

  // ---------------------------------------------------------------- IMPORT LOG

  async importLog(query: ImportLogQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.DrawingImportLogWhereInput = {};
    if (query.success === "true") where.success = true;
    else if (query.success === "false") where.success = false;
    if (query.isCritical === "true") where.isCritical = true;
    else if (query.isCritical === "false") where.isCritical = false;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.drawingImportLog.findMany({
        where,
        orderBy: [{ importedAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.prisma.drawingImportLog.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, pageSize, total) };
  }

  // ---------------------------------------------------------------- LOOKUPS

  /** Statusi + distinct materijali + distinct projektanti (za UI filtere). */
  async lookups() {
    const [statuses, materials, designers] = await Promise.all([
      this.prisma.drawingStatus.findMany({ orderBy: { id: "asc" } }),
      this.prisma.drawing.findMany({
        where: { material: { not: null } },
        distinct: ["material"],
        select: { material: true },
        orderBy: { material: "asc" },
      }),
      this.prisma.drawing.findMany({
        where: { designedBy: { not: null } },
        distinct: ["designedBy"],
        select: { designedBy: true },
        orderBy: { designedBy: "asc" },
      }),
    ]);

    const nonEmpty = (v: string | null): v is string =>
      typeof v === "string" && v.trim().length > 0;

    return {
      data: {
        statuses,
        materials: materials.map((m) => m.material).filter(nonEmpty),
        designers: designers.map((d) => d.designedBy).filter(nonEmpty),
      },
    };
  }

  // ---------------------------------------------------------------- HELPERS

  /** Depth param: 1..MAX_BOM_DEPTH, default MAX (tvrdi limit — anti-ciklus). */
  private clampDepth(raw?: string): number {
    const n = Number.parseInt(raw ?? "", 10);
    if (Number.isNaN(n)) return MAX_BOM_DEPTH;
    return Math.min(MAX_BOM_DEPTH, Math.max(1, n));
  }

  /** Da li je stablo presečeno na max dubini (listovi max nivoa imaju decu)? */
  private async isTruncatedAtDepth(
    rows: ComponentEdgeRow[],
    maxDepth: number,
  ): Promise<boolean> {
    const leafIds = uniqueIds(
      rows
        .filter((r) => r.depth === maxDepth && !r.is_cycle)
        .map((r) => r.child_drawing_id),
    );
    if (!leafIds.length) return false;
    const count = await this.prisma.drawingComponent.count({
      where: { parentDrawingId: { in: leafIds } },
    });
    return count > 0;
  }

  // --- batch resolveri (izbegavaju required-relation JOIN koji puca na orphan FK) ---

  private async resolveDrawings(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, DrawingSummary>();
    return byId(
      await this.prisma.drawing.findMany({
        where: { id: { in: uniq } },
        select: DRAWING_SUMMARY_SELECT,
      }),
    );
  }

  private async resolveStatuses(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.drawingStatus.findMany({
        where: { id: { in: uniq } },
        select: { id: true, name: true },
      }),
    );
  }

  /** Skup id-jeva koji se pojavljuju kao child (dakle NISU top-level sklop). */
  private async findNonTopLevel(ids: number[]): Promise<Set<number>> {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Set<number>();
    const rows = await this.prisma.drawingComponent.findMany({
      where: { childDrawingId: { in: uniq } },
      select: { childDrawingId: true },
      distinct: ["childDrawingId"],
    });
    return new Set(rows.map((r) => r.childDrawingId));
  }
}

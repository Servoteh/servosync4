import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { parseBoolParam, type ListItemsQuery } from "./dto/list-items.dto";

/**
 * Kolone artikla za listu (BigBit cache `items`, ~91k redova — nikad bez LIMIT-a).
 * Detalj vraća SVE kolone (`findUnique` bez `select`), pa ovde stoje samo one koje
 * tabela stvarno prikazuje: kataloški broj, naziv, JM, grupa, VP cena, aktivan.
 */
const ITEM_LIST_SELECT = {
  id: true,
  catalogNumber: true,
  barCode: true,
  name: true,
  unit: true,
  groupCode: true,
  wholesalePrice: true,
  active: true,
} as const;

/** Razrešen šifarnički kod: `{ code, description }`; `description` = null kad šifarnik nije sinkovan. */
export interface CodeRef {
  code: string;
  description: string | null;
}

/**
 * Read-only pregled matičnog podatka „Artikli" (BigBit cache `items`).
 *
 * BACKEND_RULES §3/§11.1: `items` piše ISKLJUČIVO bigbit-sync — ovaj servis NEMA
 * mutacija i nikad ih neće imati dok je BigBit vlasnik (unos artikla ostaje u
 * BigBit formi „Unos artikala", v. `docs/migration/BIGBIT_ARTIKLI.md` §4).
 *
 * ⚠️ Šifarnici `item_groups` / `item_subgroups` / `item_origins` su DANAS PRAZNI
 * (BIGBIT_ARTIKLI.md §2.1 — synceri za `R_Grupa`/`R_Podgrupa`/`R_Poreklo` ne
 * postoje). Zato se nazivi razrešavaju BATCH upitom i `description` pada na
 * `null` — nikad izuzetak, nikad required-relation JOIN (koji bi na praznom
 * šifarniku dao `Inconsistent query result` → 500; isti razlog kao u
 * `common/relations.ts`).
 */
@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListItemsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.ItemWhereInput = {};
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { catalogNumber: { contains: q, mode: "insensitive" } },
        { barCode: { contains: q, mode: "insensitive" } },
      ];
    }
    const groupCode = query.groupCode?.trim();
    if (groupCode) where.groupCode = groupCode;
    const active = parseBoolParam(query.active, "active");
    if (active !== undefined) where.active = active;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.item.findMany({
        where,
        // Kataloški broj je „ljudski ključ" artikla (BIGBIT_ARTIKLI.md §1) —
        // sortiranje po njemu; `id` je tie-break da paginacija bude stabilna.
        orderBy: [{ catalogNumber: "asc" }, { id: "asc" }],
        skip,
        take,
        select: ITEM_LIST_SELECT,
      }),
      this.prisma.item.count({ where }),
    ]);

    const groups = await this.resolveGroups(rows.map((r) => r.groupCode));
    const data = rows.map((r) => ({
      ...r,
      group: codeRef(r.groupCode, groups),
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /** Sva polja artikla + razrešeni nazivi grupe/podgrupe/porekla. */
  async findOne(id: number) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item) throw new NotFoundException(`Artikal ${id} ne postoji`);

    const [groups, subgroups, origins] = await Promise.all([
      this.resolveGroups([item.groupCode]),
      this.resolveSubgroups([item.subgroupCode]),
      this.resolveOrigins([item.originCode]),
    ]);

    // Decimal → string u JSON-u (BACKEND_RULES §6). Ostale novčane kolone su u
    // legacy portu `Float` (BigBit `Double`) i ostaju brojevi — to je zatečena
    // šema, ne menja se iz read-only modula.
    const { manualMarkupPercent, ...rest } = item;
    const data = {
      ...rest,
      manualMarkupPercent: manualMarkupPercent?.toString() ?? null,
      group: codeRef(item.groupCode, groups),
      subgroup: codeRef(item.subgroupCode, subgroups),
      origin: codeRef(item.originCode, origins),
    };
    return { data };
  }

  // --- batch resolveri šifarnika (prazan šifarnik → description null, ne 500) ---

  private async resolveGroups(codes: (string | null | undefined)[]) {
    const uniq = uniqueCodes(codes);
    if (!uniq.length) return new Map<string, string>();
    return byCode(
      await this.prisma.itemGroup.findMany({
        where: { code: { in: uniq } },
        select: { code: true, description: true },
      }),
    );
  }

  private async resolveSubgroups(codes: (string | null | undefined)[]) {
    const uniq = uniqueCodes(codes);
    if (!uniq.length) return new Map<string, string>();
    return byCode(
      await this.prisma.itemSubgroup.findMany({
        where: { code: { in: uniq } },
        select: { code: true, description: true },
      }),
    );
  }

  private async resolveOrigins(codes: (string | null | undefined)[]) {
    const uniq = uniqueCodes(codes);
    if (!uniq.length) return new Map<string, string>();
    return byCode(
      await this.prisma.itemOrigin.findMany({
        where: { code: { in: uniq } },
        select: { code: true, description: true },
      }),
    );
  }
}

/** Jedinstveni neprazni kodovi za `WHERE code IN (...)`. */
function uniqueCodes(codes: (string | null | undefined)[]): string[] {
  return [
    ...new Set(
      codes.filter((c): c is string => typeof c === "string" && c !== ""),
    ),
  ];
}

function byCode(rows: { code: string; description: string }[]) {
  return new Map(rows.map((r) => [r.code, r.description]));
}

/** `{ code, description }`; kod bez reda u šifarniku → `description: null`. */
function codeRef(
  code: string | null | undefined,
  descriptions: Map<string, string>,
): CodeRef | null {
  if (!code) return null;
  return { code, description: descriptions.get(code) ?? null };
}

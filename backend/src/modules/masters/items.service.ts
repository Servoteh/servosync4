import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { parseBoolParam, type ListItemsQuery } from "./dto/list-items.dto";
import {
  computeKilogramsPerPiece,
  toItemColumns,
  validateCreateItem,
  validateUpdateItem,
  type CreateItemDto,
  type ItemWriteFields,
  type RasterWeightInput,
  type UpdateItemDto,
} from "./dto/upsert-item.dto";
import {
  assertItemIsNative,
  assertItemWritesAllowed,
  catalogDuplicateException,
  isCatalogDuplicateError,
  NATIVE_ITEM_ID_BASE,
  NATIVE_ITEM_ID_MAX,
  NATIVE_ITEM_SOURCE,
} from "./items.write-policy";
import type { AuthUser } from "../auth/jwt.strategy";

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
 * Matični podatak „Artikli" (BigBit cache `items`) — pregled + unos/izmena.
 *
 * ⚠️ UNOS I IZMENA SU DANAS ZATVORENI BRANOM, NE IZOSTAVLJENI. `create()`/`update()`
 * postoje sa punim skupom polja BigBit forme „Unos artikala", ali prvo pitaju
 * `assertItemWritesAllowed()` — dok `items` prolazi kroz full refresh
 * (`deleteMany({})` + `createMany`), svaki upis odavde bi nestao pri prvom uvozu i
 * ostavio siročad u `price_list_entries`/`work_order_item_components`. Puno
 * obrazloženje i uslovi otvaranja: `items.write-policy.ts`.
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

  // ─────────────────────────────────────────────────────────── unos / izmena ──

  /**
   * Nov artikal (4.0-native). Redosled je namerno ovakav:
   *   1. brana upisa (stanje sistema — 409, pre svake druge poruke),
   *   2. validacija polja (400 sa spiskom svih grešaka odjednom),
   *   3. provera šifarnika i kataloškog broja (400/409 sa jasnim razlogom),
   *   4. upis pod `pg_advisory_xact_lock` sa id-em iz native opsega.
   *
   * BigBit forma sama dodeljuje sledeći kataloški broj i sledeći PLU
   * (`NajveciKatBroj`, `SledeciPLU` — BIGBIT_ARTIKLI.md §4.8). MI TO NE RADIMO:
   * BigBit ostaje vlasnik numeracije i dodelio bi isti sledeći broj svom artiklu,
   * pa bi dva sistema proizvela isti kataloški broj — istu grešku koju je paritet-
   * guard morao da leči kod predmeta. Zato je kataloški broj OBAVEZAN ULAZ.
   */
  async create(dto: CreateItemDto, user: AuthUser) {
    assertItemWritesAllowed();
    validateCreateItem(dto);
    await this.assertCodebookRefs(dto, null);

    const catalogNumber = dto.catalogNumber.trim();
    await this.assertCatalogNumberFree(catalogNumber, null);

    const columns = toItemColumns(dto);
    applyRasterWeight(columns, dto, null);

    const created = await this.runGuarded(catalogNumber, () =>
      this.prisma.$transaction(async (tx) => {
        // Serijalizuje dodelu id-a: `MAX(id)+1` bez brave daje isti id dvema
        // paralelnim transakcijama (isti obrazac kao `document-print.service`).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('items_native_id'))`;
        const id = await nextNativeItemId(tx);
        return tx.item.create({
          data: {
            ...columns,
            id,
            // MARKER POREKLA — bez njega upis fizički ne prolazi.
            // `chk_items_native_id_range` traži `(source='NATIVE') = (id >= 900000000)`,
            // a kolona ima DB default `'BIGBIT'`. Red se pravi sa id-jem iz native
            // opsega, pa bi bez ovog polja CHECK bio prekršen i baza vratila 23514 —
            // koji `runGuarded` ne prepoznaje (hvata samo duplikat kataloškog broja),
            // pa bi korisnik dobio 500 sa sirovim engleskim tekstom baze. Dakle: unos
            // ne bi radio NIJEDNOM, i to tek na dan preklapanja prekidača.
            // (Adversarni pregled 28.07.2026, KRITIČNO — dokazano izvršavanjem.)
            source: NATIVE_ITEM_SOURCE,
            // 0 = „nema BigBit porekla" (`BBSifra artikla` ne postoji za native red).
            externalItemId: 0,
            signature: signatureFor(user),
            createdAt: new Date(),
          } as unknown as Prisma.ItemUncheckedCreateInput,
          select: { id: true },
        });
      }),
    );

    return this.findOne(created.id);
  }

  /**
   * Izmena artikla — SAMO nad 4.0-native redom. BigBit-origin red se odbija sa 409:
   * sve 68 kolona modela su u sync mapi, pa bi svaka izmena nestala pri sledećem
   * uvozu (i to tiho, danima kasnije — najgori oblik kvara).
   */
  async update(id: number, dto: UpdateItemDto, user: AuthUser) {
    assertItemWritesAllowed();

    const existing = await this.prisma.item.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Artikal ${id} ne postoji`);
    assertItemIsNative(existing);

    validateUpdateItem(dto, existing.thickness ?? null);
    await this.assertCodebookRefs(dto, existing);

    const catalogNumber =
      dto.catalogNumber !== undefined ? dto.catalogNumber.trim() : null;
    if (catalogNumber !== null)
      await this.assertCatalogNumberFree(catalogNumber, id);

    const columns = toItemColumns(dto);
    applyRasterWeight(columns, dto, existing.thickness ?? null);
    // `PotpisArt` — ko je poslednji dirao slog (BigBit `PotpisiArt`, §4.8).
    columns.signature = signatureFor(user);

    await this.runGuarded(catalogNumber ?? existing.catalogNumber, () =>
      this.prisma.item.update({
        where: { id },
        data: {
          ...(columns as unknown as Prisma.ItemUncheckedUpdateInput),
          // TRAG IZMENE. Kolone su stigle migracijom 20260728170000; bez ovog
          // upisa stajale bi prazne, a kod bi tvrdio trag koji ne postoji — što
          // je gore nego da ih nema, jer se na njih računa pri svakom pitanju
          // „ko je ovo promenio". Vreme je vreme UPISA (server), ne sa ekrana.
          updatedAt: new Date(),
          updatedBy: signatureFor(user),
        },
        select: { id: true },
      }),
    );

    return this.findOne(id);
  }

  /**
   * Sirova greška iz brane `guard_catalog_unique` → srpska poruka.
   * (Migracija `20260725230000_katbroj_brana`: `RAISE EXCEPTION
   * 'CATALOG_NUMBER_DUPLICATE: …' USING ERRCODE = 'unique_violation'`.)
   */
  private async runGuarded<T>(
    catalogNumber: string,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (isCatalogDuplicateError(e)) throw catalogDuplicateException(catalogNumber);
      throw e;
    }
  }

  /**
   * Provera kataloškog broja PRE upisa — da korisnik dobije poruku sa imenom
   * postojećeg artikla umesto gole greške baze. Nije zamena za branu (trka između
   * provere i upisa ostaje na trigeru), nego bolji tekst u 99% slučajeva.
   */
  private async assertCatalogNumberFree(
    catalogNumber: string,
    selfId: number | null,
  ) {
    const clash = await this.prisma.item.findFirst({
      where: {
        catalogNumber: { equals: catalogNumber, mode: "insensitive" },
        ...(selfId !== null ? { id: { not: selfId } } : {}),
      },
      select: { id: true, name: true },
    });
    if (clash)
      throw catalogDuplicateException(catalogNumber);
  }

  /**
   * Grupa / podgrupa / poreklo / tarife / dobavljač se BIRAJU IZ ŠIFARNIKA, ne kucaju.
   *
   * Kvaka: `item_groups`/`item_subgroups`/`item_origins` su DANAS PRAZNI (nema
   * syncera za `R_Grupa`/`R_Podgrupa`/`R_Poreklo` — BIGBIT_ARTIKLI.md §7 gap #1).
   * Tvrda provera bi zato odbila SVAKI unos. Pravilo: šifarnik koji ima bar jedan
   * red se poštuje tvrdo; prazan šifarnik se preskače (i to je razlog zašto ta tri
   * syncera imaju prioritet „VISOK, odmah").
   *
   * Kaskada Grupa → Podgrupa → Poreklo (BigBit combo-boxovi, §4.9) se proverava tek
   * kad šifarnik ume da je potvrdi. `"0"` je BigBit sentinel za „nije zadato".
   */
  private async assertCodebookRefs(
    dto: ItemWriteFields,
    existing: {
      groupCode: string;
      subgroupCode: string;
      originCode: string;
    } | null,
  ) {
    const errors: string[] = [];
    const eff = {
      groupCode: effectiveCode(dto.groupCode, existing?.groupCode),
      subgroupCode: effectiveCode(dto.subgroupCode, existing?.subgroupCode),
      originCode: effectiveCode(dto.originCode, existing?.originCode),
    };

    if (
      dto.groupCode !== undefined ||
      dto.subgroupCode !== undefined ||
      dto.originCode !== undefined
    ) {
      const [group, subgroup, origin] = await Promise.all([
        this.lookupCode(this.prisma.itemGroup, eff.groupCode),
        this.lookupCode(this.prisma.itemSubgroup, eff.subgroupCode),
        this.lookupCode(this.prisma.itemOrigin, eff.originCode),
      ]);

      if (group === "MISSING")
        errors.push(`Grupa „${eff.groupCode}” ne postoji u šifarniku grupa.`);
      if (subgroup === "MISSING")
        errors.push(
          `Podgrupa „${eff.subgroupCode}” ne postoji u šifarniku podgrupa.`,
        );
      if (origin === "MISSING")
        errors.push(`Poreklo „${eff.originCode}” ne postoji u šifarniku porekla.`);

      const subgroupRow =
        subgroup !== "MISSING" && subgroup !== "SKIPPED" ? subgroup : null;
      if (
        subgroupRow &&
        "parentGroup" in subgroupRow &&
        isRealCode(subgroupRow.parentGroup) &&
        eff.groupCode !== null &&
        subgroupRow.parentGroup !== eff.groupCode
      )
        errors.push(
          `Podgrupa „${eff.subgroupCode}” pripada grupi „${subgroupRow.parentGroup}”, a izabrana je grupa „${eff.groupCode}”.`,
        );

      const originRow =
        origin !== "MISSING" && origin !== "SKIPPED" ? origin : null;
      if (
        originRow &&
        "subgroupCode" in originRow &&
        isRealCode(originRow.subgroupCode) &&
        eff.subgroupCode !== null &&
        originRow.subgroupCode !== eff.subgroupCode
      )
        errors.push(
          `Poreklo „${eff.originCode}” pripada podgrupi „${originRow.subgroupCode}”, a izabrana je podgrupa „${eff.subgroupCode}”.`,
        );
    }

    for (const [value, label] of [
      [dto.goodsTaxRateCode, "Tarifa robe"],
      [dto.serviceTaxRateCode, "Tarifa usluga"],
    ] as const) {
      const code = effectiveCode(value, undefined);
      if (value === undefined || code === null) continue;
      const total = await this.prisma.taxRate.count();
      if (total === 0) continue;
      const row = await this.prisma.taxRate.findFirst({
        where: { code },
        select: { code: true },
      });
      if (!row)
        errors.push(`${label} „${code}” ne postoji u šifarniku poreskih tarifa.`);
    }

    if (dto.supplierId !== undefined && dto.supplierId > 0) {
      const total = await this.prisma.customer.count();
      if (total > 0) {
        const supplier = await this.prisma.customer.findUnique({
          where: { id: dto.supplierId },
          select: { id: true },
        });
        if (!supplier)
          errors.push(`Dobavljač ${dto.supplierId} ne postoji u šifarniku komitenata.`);
      }
    }

    if (errors.length) throw new BadRequestException(errors);
  }

  /**
   * `SKIPPED` = kod nije zadat ili je šifarnik prazan (ne proveravamo);
   * `MISSING`  = šifarnik postoji, koda u njemu nema; inače vraćen red.
   */
  private async lookupCode<T extends { code: string }>(
    delegate: {
      count: () => Promise<number>;
      findUnique: (args: { where: { code: string } }) => Promise<T | null>;
    },
    code: string | null,
  ): Promise<T | "SKIPPED" | "MISSING"> {
    if (code === null) return "SKIPPED";
    const total = await delegate.count();
    if (total === 0) return "SKIPPED";
    const row = await delegate.findUnique({ where: { code } });
    return row ?? "MISSING";
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

/** BigBit sentinel „nije zadato" je `"0"` (a ne NULL) — v. `@default("0")` u šemi. */
function isRealCode(code: string | null | undefined): code is string {
  return typeof code === "string" && code.trim() !== "" && code.trim() !== "0";
}

/** Vrednost koja će stvarno stajati u koloni posle ovog zahteva. */
function effectiveCode(
  sent: string | null | undefined,
  existing: string | null | undefined,
): string | null {
  const value = sent !== undefined ? sent : existing;
  return isRealCode(value) ? value.trim() : null;
}

/**
 * Sledeći id iz NATIVE opsega. Zove se pod `pg_advisory_xact_lock` — bez brave dve
 * paralelne transakcije dobiju isti broj. `::int` kastovi su obavezni: bez njih
 * Prisma vezuje JS broj kao `bigint`, pa izraz pređe u `bigint` i vrati `BigInt`.
 */
async function nextNativeItemId(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ next_id: number | bigint }[]>`
    SELECT COALESCE(MAX(id), ${NATIVE_ITEM_ID_BASE - 1}::int) + 1 AS next_id
    FROM items
    WHERE id >= ${NATIVE_ITEM_ID_BASE}::int`;
  const next = Number(rows[0]?.next_id ?? NATIVE_ITEM_ID_BASE);
  if (!Number.isInteger(next) || next < NATIVE_ITEM_ID_BASE)
    throw new Error(`Neispravan id iz native opsega: ${String(next)}`);
  if (next > NATIVE_ITEM_ID_MAX)
    throw new BadRequestException(
      "Opseg šifara za artikle unete u ServoSync-u je popunjen — javite administratoru.",
    );
  return next;
}

/**
 * Obračun kg/kom iz dimenzija table (BIGBIT_ARTIKLI.md §4.10) — rezultat u `box`,
 * tačno kao BigBit dugme `DugmePreracunajTezinuUKomadu`. Dimenzije se NE ČUVAJU
 * (nema `RasterDef*` tabela), pa se pri sledećoj izmeni unose ponovo.
 */
function applyRasterWeight(
  columns: Record<string, string | number | boolean | Prisma.Decimal | null>,
  dto: ItemWriteFields & RasterWeightInput,
  existingThickness: number | null,
): void {
  if (dto.rasterWidthMm === undefined || dto.rasterLengthMm === undefined) return;
  const thickness = dto.thickness ?? existingThickness;
  if (thickness === null || thickness === undefined) return;
  const kg = computeKilogramsPerPiece(
    thickness,
    dto.rasterWidthMm,
    dto.rasterLengthMm,
  );
  if (kg !== null) columns.box = kg;
}

/** `PotpisArt` Text(50) — ko je poslednji dirao slog. */
function signatureFor(user: AuthUser): string {
  return (user.email || String(user.userId)).slice(0, 50);
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

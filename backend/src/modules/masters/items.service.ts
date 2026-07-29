import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { parseBoolParam, type ListItemsQuery } from "./dto/list-items.dto";
import { canReadCommercial, type MastersActor } from "./masters-access";

/**
 * Kolone artikla za listu (BigBit cache `items`, ~91k redova — nikad bez LIMIT-a):
 * kataloški broj, naziv, JM, grupa, aktivan. VP cena je KOMERCIJALNA i dodaje se
 * samo akteru sa `masters.read` (v. `list()` i `ITEM_COMMERCIAL_SELECT`).
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

/**
 * KOMERCIJALNI SLOJ kartona artikla — vraća se ISKLJUČIVO uz `masters.read`
 * (masters-access.ts; odluka Nenad 29.07.2026). Sve što govori o novcu i uslovima:
 * cene (VP/MP/devizne/cena za cenovnik), marže i rabati, kalo, GK konta, dobavljač,
 * takse/akcize/carine, valuta plaćanja, neoporezivi deo, zavisni trošak.
 *
 * Podela je namerno NA NIVOU `select`-a, ne brisanjem polja posle upita: nova
 * kolona u šemi tako pada u bazni sloj SAMO ako je neko svesno doda u
 * `ITEM_BASE_SELECT` — inače je nigde nema (fail-closed).
 */
const ITEM_COMMERCIAL_SELECT = {
  wholesalePrice: true,
  retailPrice: true,
  fxPurchasePrice: true,
  fxSalePrice: true,
  priceToWritePricelist: true,
  manualMarkupPercent: true,
  maxDiscountPercent: true,
  promotionDiscount: true,
  retailLossPercent: true,
  wholesaleLossPercent: true,
  finalProcessingCost: true,
  accountingCode: true,
  accountingCode2: true,
  supplierId: true,
  itemFee: true,
  itemExcise: true,
  customsRate: true,
  customsTariff: true,
  paymentTermDays: true,
  nonTaxablePart: true,
} as const;

/**
 * BAZNI SLOJ kartona artikla — ono što vidi svako sa `directory.read`: identitet,
 * klasifikacija, dimenzije/pakovanje, opisi i prevodi, linkovi na fajl-server,
 * proizvođač/polica, poreske TARIFE (šifra stope, ne iznos) i status.
 * `minQuantity` je logistička količina (ne cena) pa ostaje ovde.
 */
const ITEM_BASE_SELECT = {
  id: true,
  // Identitet
  catalogNumber: true,
  barCode: true,
  plu: true,
  externalCode: true,
  externalItemId: true,
  name: true,
  // Klasifikacija
  groupCode: true,
  subgroupCode: true,
  originCode: true,
  qualityTypeId: true,
  hps: true,
  sortOrder: true,
  // Poreske tarife (šifre stopa i zemlja porekla — ne iznosi)
  goodsTaxRateCode: true,
  serviceTaxRateCode: true,
  alwaysTaxGoods: true,
  alwaysTaxServices: true,
  originCountry: true,
  // Dimenzije i pakovanje
  unit: true,
  baseUnit: true,
  packaging: true,
  quantityInPackage: true,
  box: true,
  transportPackaging: true,
  minQuantity: true,
  weight: true,
  weightKg: true,
  volume: true,
  area: true,
  thickness: true,
  // Opisi i prevodi
  itemDescription: true,
  webDescription: true,
  foreignName: true,
  foreignUnit: true,
  memo: true,
  note2: true,
  // Linkovi (putanje na fajl-serveru)
  symbolImageLink: true,
  pdfLink: true,
  wordLocation: true,
  // Ostalo
  manufacturer: true,
  shelf: true,
  issuePlaceId: true,
  rasterId: true,
  notStockTracked: true,
  toDelete: true,
  active: true,
  signature: true,
  createdAt: true,
} as const;

/** Pun karton = bazni + komercijalni sloj (`masters.read`). */
const ITEM_FULL_SELECT = {
  ...ITEM_BASE_SELECT,
  ...ITEM_COMMERCIAL_SELECT,
} as const;

/**
 * Barkod ambalaže (`item_barcodes`) — uz svaki ide množilac količine (`multiFactor`).
 * `Decimal` → string u JSON-u (BACKEND_RULES §6).
 */
const ITEM_BARCODE_SELECT = {
  id: true,
  barCode: true,
  multiFactor: true,
} as const;

/** Prevod naziva/JM po jeziku (`item_translations`). Šifarnika jezika nema — ide go broj. */
const ITEM_TRANSLATION_SELECT = {
  languageId: true,
  foreignName: true,
  foreignUnit: true,
} as const;

/** Dobavljač artikla (`item_suppliers`) — KOMERCIJALNO (v. `findOne`). */
const ITEM_SUPPLIER_SELECT = {
  id: true,
  supplierId: true,
  isPrimary: true,
  leadTimeDays: true,
} as const;

/** Razrešen šifarnički kod: `{ code, description }`; `description` = null kad šifarnik nije sinkovan. */
export interface CodeRef {
  code: string;
  description: string | null;
}

/** Klasa kvaliteta artikla (`item_quality_types`), razrešena po `items.quality_type_id`. */
export interface ItemQualityTypeRef {
  id: number;
  qualityCode: string;
  description: string;
}

/**
 * Read-only pregled matičnog podatka „Artikli" (BigBit cache `items`).
 *
 * BACKEND_RULES §3/§11.1: `items` piše ISKLJUČIVO bigbit-sync — ovaj servis NEMA
 * mutacija i nikad ih neće imati dok je BigBit vlasnik (unos artikla ostaje u
 * BigBit formi „Unos artikala", v. `docs/migration/BIGBIT_ARTIKLI.md` §4).
 *
 * DVA SLOJA ODGOVORA (odluka Nenad 29.07.2026, v. `masters-access.ts`): ruta stoji
 * na `directory.read` i svako je vidi, ali komercijalne kolone (cene, marže, rabati,
 * GK konta, dobavljač, carine) izlaze SAMO akteru sa `masters.read`. Redakcija je
 * ovde, u backendu — ne u FE prikazu; `meta.restricted` samo javlja FE-u koji je sloj.
 *
 * ⚠️ Šifarnici `item_groups` / `item_subgroups` / `item_origins` su DANAS PRAZNI
 * (BIGBIT_ARTIKLI.md §2.1 — synceri za `R_Grupa`/`R_Podgrupa`/`R_Poreklo` ne
 * postoje). Zato se nazivi razrešavaju BATCH upitom i `description` pada na
 * `null` — nikad izuzetak, nikad required-relation JOIN (koji bi na praznom
 * šifarniku dao `Inconsistent query result` → 500; isti razlog kao u
 * `common/relations.ts`).
 *
 * ⚠️⚠️ CHILD TABELE SE ČITAJU PREKO `external_item_id`, NE PREKO `id`.
 * `item_barcodes` / `item_translations` / `item_suppliers` dolaze direktno iz BigBit
 * `.mdb`-a (Talas B, `tools/bigbit-bridge`) i njihov `item_id` je **BigBit šifra
 * artikla**. `items.id` je QBigTehn-lokalni IDENTITY iz kopije — BigBit šifra živi u
 * `items.external_item_id` (BIGBIT_ARTIKLI.md §5.1). Upit po `items.id` bi tiho vraćao
 * TUĐE barkodove/prevode/dobavljače. `external_item_id = 0` znači „nema BigBit
 * parnjaka" → child upiti se preskaču i kolekcije su prazne.
 * `quality_type_id` NIJE u tom prostoru — on je pravi FK na `R_KvalitetArtikla` i
 * razrešava se direktno.
 */
@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListItemsQuery, actor?: MastersActor) {
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

    const commercial = await canReadCommercial(this.prisma, actor);

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
    // VP cena otpada bez `masters.read`. Ovde se polje izbacuje u JS-u (a ne kroz
    // drugi `select`) jer je lista FIKSNA bela lista od 8 kolona — nova kolona u
    // šemi u nju ne može da uđe slučajno, pa nema šta da procuri.
    const data = rows.map(({ wholesalePrice, ...r }) => ({
      ...r,
      ...(commercial ? { wholesalePrice } : {}),
      group: codeRef(r.groupCode, groups),
    }));

    return {
      data,
      meta: { ...pageMeta(page, pageSize, total), restricted: !commercial },
    };
  }

  /**
   * Jedan artikal + razrešeni nazivi grupe/podgrupe/porekla + child kolekcije
   * (barkodovi, prevodi, kvalitet; dobavljači samo uz `masters.read`).
   * Skup kolona zavisi od `masters.read` (bazni vs. pun karton) — v. `ITEM_BASE_SELECT`.
   */
  async findOne(id: number, actor?: MastersActor) {
    const commercial = await canReadCommercial(this.prisma, actor);
    const item = commercial
      ? await this.prisma.item.findUnique({
          where: { id },
          select: ITEM_FULL_SELECT,
        })
      : await this.prisma.item.findUnique({
          where: { id },
          select: ITEM_BASE_SELECT,
        });
    if (!item) throw new NotFoundException(`Artikal ${id} ne postoji`);

    // BigBit šifra artikla — jedini ključ pod kojim child tabele znaju ovaj artikal.
    const bbId = item.externalItemId;
    const [groups, subgroups, origins, barcodes, translations, qualityType] =
      await Promise.all([
        this.resolveGroups([item.groupCode]),
        this.resolveSubgroups([item.subgroupCode]),
        this.resolveOrigins([item.originCode]),
        this.resolveBarcodes(bbId),
        this.resolveTranslations(bbId),
        this.resolveQualityType(item.qualityTypeId),
      ]);
    // Dobavljač i njegov lead time su komercijalni podatak (od koga i pod kojim
    // uslovima kupujemo) — bez `masters.read` se i NE ČITAJU iz baze.
    const suppliers = commercial
      ? await this.resolveSuppliers(bbId)
      : undefined;

    // Decimal → string u JSON-u (BACKEND_RULES §6). Ostale novčane kolone su u
    // legacy portu `Float` (BigBit `Double`) i ostaju brojevi — to je zatečena
    // šema, ne menja se iz read-only modula.
    const data = {
      ...item,
      ...("manualMarkupPercent" in item
        ? { manualMarkupPercent: item.manualMarkupPercent?.toString() ?? null }
        : {}),
      group: codeRef(item.groupCode, groups),
      subgroup: codeRef(item.subgroupCode, subgroups),
      origin: codeRef(item.originCode, origins),
      qualityType,
      barcodes,
      translations,
      ...(suppliers ? { suppliers } : {}),
    };
    return { data, meta: { restricted: !commercial } };
  }

  // --- child kolekcije iz BigBit `.mdb`-a (Talas B) ---------------------------
  // Sve tri gađaju `item_id = items.external_item_id` (v. doc-komentar klase).
  // Tabele su na produkciji PRAZNE dok bridge ne odradi prvi prolaz — prazan niz
  // je normalno stanje, ne greška.

  /** Barkodovi ambalaže; `multiFactor` (Decimal) → string. */
  private async resolveBarcodes(externalItemId: number) {
    if (!externalItemId) return [];
    const rows = await this.prisma.itemBarcode.findMany({
      where: { itemId: externalItemId },
      orderBy: [{ id: "asc" }],
      select: ITEM_BARCODE_SELECT,
    });
    return rows.map((r) => ({ ...r, multiFactor: r.multiFactor.toString() }));
  }

  /** Prevodi po jeziku; `languageId` ostaje broj (šifarnik jezika ne postoji). */
  private async resolveTranslations(externalItemId: number) {
    if (!externalItemId) return [];
    return this.prisma.itemTranslation.findMany({
      where: { itemId: externalItemId },
      orderBy: [{ languageId: "asc" }],
      select: ITEM_TRANSLATION_SELECT,
    });
  }

  /**
   * Dobavljači artikla + razrešeno ime iz `customers` (meki ref — dobavljač koga
   * nema u `customers` daje `supplier: null`, nikad 500). Primarni ide prvi.
   */
  private async resolveSuppliers(externalItemId: number) {
    if (!externalItemId) return [];
    const rows = await this.prisma.itemSupplier.findMany({
      where: { itemId: externalItemId },
      orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
      select: ITEM_SUPPLIER_SELECT,
    });
    if (!rows.length) return [];
    const names = byId(
      await this.prisma.customer.findMany({
        where: { id: { in: uniqueIds(rows.map((r) => r.supplierId)) } },
        select: { id: true, name: true },
      }),
    );
    return rows.map((r) => ({
      ...r,
      supplier: names.get(r.supplierId) ?? null,
    }));
  }

  /**
   * Klasa kvaliteta po `items.quality_type_id`. Ovo NIJE BigBit-item prostor —
   * `IDKvalitetArtikla` je isti broj u originalu i u kopiji. 0 = „nije zadato".
   */
  private async resolveQualityType(
    qualityTypeId: number | null | undefined,
  ): Promise<ItemQualityTypeRef | null> {
    if (typeof qualityTypeId !== "number" || qualityTypeId <= 0) return null;
    return (
      (await this.prisma.itemQualityType.findUnique({
        where: { id: qualityTypeId },
        select: { id: true, qualityCode: true, description: true },
      })) ?? null
    );
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

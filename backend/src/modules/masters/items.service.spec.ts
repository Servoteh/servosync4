import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ItemsService } from "./items.service";
import { ItemsController } from "./items.controller";
import { DirectoryController } from "../directory/directory.controller";
import { PERMISSION_KEY_METADATA } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { ROLES } from "../../common/authz/roles";

/**
 * KOMERCIJALNA POLJA artikla — ne smeju da postoje u odgovoru bez `masters.read`.
 * Lista je NAMERNO prepisana ovde, a ne uvezena iz servisa: da premeštanje kolone
 * iz `ITEM_COMMERCIAL_SELECT` u bazni sloj obori test, umesto da se test tiho
 * prilagodi izmeni (test je granica, ne ogledalo implementacije).
 */
const COMMERCIAL_KEYS = [
  "wholesalePrice",
  "retailPrice",
  "fxPurchasePrice",
  "fxSalePrice",
  "priceToWritePricelist",
  "manualMarkupPercent",
  "maxDiscountPercent",
  "promotionDiscount",
  "retailLossPercent",
  "wholesaleLossPercent",
  "finalProcessingCost",
  "accountingCode",
  "accountingCode2",
  "supplierId",
  "itemFee",
  "itemExcise",
  "customsRate",
  "customsTariff",
  "paymentTermDays",
  "nonTaxablePart",
] as const;

/** Pun red iz baze — mock ga seče po `select`-u, kao pravi Prisma. */
const ITEM_ROW: Record<string, unknown> = {
  id: 7,
  catalogNumber: "A-7",
  barCode: "123456",
  name: "Lim 3mm",
  unit: "kom",
  groupCode: "SIR",
  subgroupCode: "SIR-1",
  originCode: "D",
  qualityTypeId: 3,
  // BigBit šifra artikla — jedini ključ pod kojim child tabele znaju ovaj artikal
  // (items.id = 7 je QBigTehn IDENTITY, BIGBIT_ARTIKLI.md §5.1).
  externalItemId: 4711,
  itemDescription: "Lim hladno valjani",
  thickness: 3,
  minQuantity: 5,
  active: true,
  // komercijalne
  wholesalePrice: 1200,
  retailPrice: 1440,
  fxPurchasePrice: 10.2,
  fxSalePrice: 12.5,
  priceToWritePricelist: 1250,
  manualMarkupPercent: new Prisma.Decimal("12.5000"),
  maxDiscountPercent: 20,
  promotionDiscount: 5,
  retailLossPercent: 1,
  wholesaleLossPercent: 2,
  finalProcessingCost: 30,
  accountingCode: "1320",
  accountingCode2: "0",
  supplierId: 42,
  itemFee: 3,
  itemExcise: 0,
  customsRate: 5,
  customsTariff: "7208",
  paymentTermDays: 45,
  nonTaxablePart: 0,
};

/** Prisma `select` semantika u mock-u: vrati SAMO tražene ključeve. */
function pickBySelect(
  row: Record<string, unknown>,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) if (key in row) out[key] = row[key];
  return out;
}

/** Mock PrismaService — samo modeli koje `ItemsService` čita (+ authz override). */
function prismaMock() {
  return {
    item: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    itemGroup: { findMany: jest.fn().mockResolvedValue([]) },
    itemSubgroup: { findMany: jest.fn().mockResolvedValue([]) },
    itemOrigin: { findMany: jest.fn().mockResolvedValue([]) },
    // Talas B child tabele — na produkciji PRAZNE dok bridge ne odradi prvi
    // prolaz, pa je prazan niz podrazumevano stanje mock-a (kao i u bazi).
    itemBarcode: { findMany: jest.fn().mockResolvedValue([]) },
    itemTranslation: { findMany: jest.fn().mockResolvedValue([]) },
    itemSupplier: { findMany: jest.fn().mockResolvedValue([]) },
    itemQualityType: { findUnique: jest.fn().mockResolvedValue(null) },
    // dobavljač = komitent (meki ref); koristi se samo za razrešavanje imena
    customer: { findMany: jest.fn().mockResolvedValue([]) },
    // `resolvePermissionDecision` čita override sveže iz baze na svaki poziv.
    userPermissionOverride: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

/** Akter sa `masters.read` kroz rolu (menadzment) i akter bez njega (viewer). */
const KOMERCIJALA = {
  userId: 1,
  role: ROLES.MENADZMENT,
  email: "sef@servoteh.com",
};
const OSNOVNI = { userId: 2, role: ROLES.VIEWER, email: "radnik@servoteh.com" };

describe("ItemsService (matični podaci — Artikli)", () => {
  let service: ItemsService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [ItemsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(ItemsService);
  });

  /** Mock koji poštuje `select` (bez njega bi redakcija bila neproverljiva). */
  function mockItem(row: Record<string, unknown> | null) {
    prisma.item.findUnique.mockImplementation(
      (args: { select?: Record<string, boolean> }) =>
        Promise.resolve(row ? pickBySelect(row, args?.select) : null),
    );
  }

  it("list(): pretraga `q` gađa naziv/kataloški broj/barkod (case-insensitive), sort po kat. broju", async () => {
    await service.list({ q: " ku-12 " }, KOMERCIJALA);

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput; orderBy: unknown; take: number },
    ];
    expect(args.where.OR).toEqual([
      { name: { contains: "ku-12", mode: "insensitive" } },
      { catalogNumber: { contains: "ku-12", mode: "insensitive" } },
      { barCode: { contains: "ku-12", mode: "insensitive" } },
    ]);
    expect(args.orderBy).toEqual([{ catalogNumber: "asc" }, { id: "asc" }]);
    // 91k redova — bez LIMIT-a se ne izlazi; podrazumevano 50 (parsePagination).
    expect(args.take).toBe(50);
    // Isti `where` mora ići i u count, inače je `meta.total` laž.
    expect(prisma.item.count).toHaveBeenCalledWith({ where: args.where });
  });

  it("list(): filteri groupCode + active se prevode u tačno poklapanje", async () => {
    await service.list({ groupCode: "SIR", active: "false" }, KOMERCIJALA);

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.groupCode).toBe("SIR");
    expect(args.where.active).toBe(false);
    expect(args.where.OR).toBeUndefined();
  });

  it("list(): `active` koji nije true/false je 400, ne tiho ignorisanje", async () => {
    await expect(
      service.list({ active: "da" }, KOMERCIJALA),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("list(): grupa se razrešava batch-om; prazan šifarnik → description null (ne greška)", async () => {
    prisma.item.findMany.mockResolvedValue([
      { id: 1, catalogNumber: "A-1", groupCode: "SIR", name: "Lim" },
      { id: 2, catalogNumber: "A-2", groupCode: "SIR", name: "Cev" },
      { id: 3, catalogNumber: "A-3", groupCode: "ALU", name: "Profil" },
    ]);
    prisma.item.count.mockResolvedValue(3);
    // `item_groups` je DANAS PRAZNA (BIGBIT_ARTIKLI.md §2.1) → nijedan opis.
    prisma.itemGroup.findMany.mockResolvedValue([]);

    const res = await service.list({}, KOMERCIJALA);

    expect(prisma.itemGroup.findMany).toHaveBeenCalledWith({
      where: { code: { in: ["SIR", "ALU"] } },
      select: { code: true, description: true },
    });
    expect(res.data.map((r) => r.group)).toEqual([
      { code: "SIR", description: null },
      { code: "SIR", description: null },
      { code: "ALU", description: null },
    ]);
    expect(res.meta.pagination).toEqual({
      page: 1,
      pageSize: 50,
      total: 3,
      totalPages: 1,
    });
  });

  it("list(): kad šifarnik postoji, naziv grupe se popunjava", async () => {
    prisma.item.findMany.mockResolvedValue([
      { id: 1, catalogNumber: "A-1", groupCode: "SIR", name: "Lim" },
    ]);
    prisma.item.count.mockResolvedValue(1);
    prisma.itemGroup.findMany.mockResolvedValue([
      { code: "SIR", description: "Sirovine" },
    ]);

    const res = await service.list({}, KOMERCIJALA);
    expect(res.data[0].group).toEqual({ code: "SIR", description: "Sirovine" });
  });

  it("findOne(): nepostojeći artikal je 404, ne 500", async () => {
    mockItem(null);
    await expect(service.findOne(999, KOMERCIJALA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ============================================ dvoslojni odgovor (masters.read)

  describe("dvoslojni odgovor — komercijalna polja traže masters.read", () => {
    it("findOne() SA masters.read: pun karton, Decimal kao string, sva tri šifarnika", async () => {
      mockItem(ITEM_ROW);
      prisma.itemGroup.findMany.mockResolvedValue([
        { code: "SIR", description: "Sirovine" },
      ]);
      prisma.itemOrigin.findMany.mockResolvedValue([
        { code: "D", description: "Domaće" },
      ]);

      const { data, meta } = await service.findOne(7, KOMERCIJALA);

      expect(meta.restricted).toBe(false);
      for (const key of COMMERCIAL_KEYS) expect(data).toHaveProperty(key);
      // Decimal → string u JSON-u (BACKEND_RULES §6).
      expect(data).toHaveProperty("manualMarkupPercent", "12.5");
      expect(data.group).toEqual({ code: "SIR", description: "Sirovine" });
      // Podgrupa ima kod, ali šifarnik je prazan → naziv null, NE izuzetak.
      expect(data.subgroup).toEqual({ code: "SIR-1", description: null });
      expect(data.origin).toEqual({ code: "D", description: "Domaće" });
      expect(data.thickness).toBe(3);
    });

    it("findOne() BEZ masters.read: nijedno komercijalno polje — ni u `select`-u ni u odgovoru", async () => {
      mockItem(ITEM_ROW);

      const { data, meta } = await service.findOne(7, OSNOVNI);

      expect(meta.restricted).toBe(true);
      // 1) kolone se ne TRAŽE od baze…
      const [args] = prisma.item.findUnique.mock.calls[0] as [
        { select: Record<string, boolean> },
      ];
      for (const key of COMMERCIAL_KEYS) {
        expect(Object.keys(args.select)).not.toContain(key);
      }
      // 2) …pa ih nema ni u odgovoru (ključ ne postoji, nije samo `null`).
      for (const key of COMMERCIAL_KEYS) expect(data).not.toHaveProperty(key);
    });

    it("findOne() BEZ masters.read: bazni sloj i dalje nosi identitet/klasifikaciju/dimenzije/opise", async () => {
      mockItem(ITEM_ROW);
      prisma.itemGroup.findMany.mockResolvedValue([
        { code: "SIR", description: "Sirovine" },
      ]);

      const { data } = await service.findOne(7, OSNOVNI);

      expect(data.catalogNumber).toBe("A-7");
      expect(data.barCode).toBe("123456");
      expect(data.name).toBe("Lim 3mm");
      expect(data.unit).toBe("kom");
      expect(data.externalItemId).toBe(4711);
      expect(data.itemDescription).toBe("Lim hladno valjani");
      expect(data.thickness).toBe(3);
      expect(data.active).toBe(true);
      expect(data.group).toEqual({ code: "SIR", description: "Sirovine" });
    });

    it("list() SA masters.read: VP cena je u redovima, meta.restricted = false", async () => {
      prisma.item.findMany.mockResolvedValue([
        { id: 1, catalogNumber: "A-1", groupCode: "SIR", wholesalePrice: 1200 },
      ]);
      prisma.item.count.mockResolvedValue(1);

      const res = await service.list({}, KOMERCIJALA);

      expect(res.meta.restricted).toBe(false);
      expect(res.data[0]).toHaveProperty("wholesalePrice", 1200);
    });

    it("list() BEZ masters.read: VP cena otpada iz svakog reda, meta.restricted = true", async () => {
      prisma.item.findMany.mockResolvedValue([
        { id: 1, catalogNumber: "A-1", groupCode: "SIR", wholesalePrice: 1200 },
        { id: 2, catalogNumber: "A-2", groupCode: "SIR", wholesalePrice: 900 },
      ]);
      prisma.item.count.mockResolvedValue(2);

      const res = await service.list({}, OSNOVNI);

      expect(res.meta.restricted).toBe(true);
      for (const row of res.data)
        expect(row).not.toHaveProperty("wholesalePrice");
      // Ostatak reda ostaje netaknut.
      expect(res.data[0]).toMatchObject({ id: 1, catalogNumber: "A-1" });
    });

    it("GRANT override otvara komercijalni sloj ulozi koja ga nema po roli", async () => {
      prisma.userPermissionOverride.findUnique.mockResolvedValue({
        allow: true,
      });
      mockItem(ITEM_ROW);

      const { data, meta } = await service.findOne(7, OSNOVNI);

      expect(prisma.userPermissionOverride.findUnique).toHaveBeenCalledWith({
        where: { userId_key: { userId: 2, key: PERMISSIONS.MASTERS_READ } },
        select: { allow: true },
      });
      expect(meta.restricted).toBe(false);
      expect(data).toHaveProperty("wholesalePrice", 1200);
    });

    it("DENY override skida komercijalni sloj i ulozi koja ga ima po roli (deny > rola)", async () => {
      prisma.userPermissionOverride.findUnique.mockResolvedValue({
        allow: false,
      });
      mockItem(ITEM_ROW);

      const { data, meta } = await service.findOne(7, KOMERCIJALA);

      expect(meta.restricted).toBe(true);
      for (const key of COMMERCIAL_KEYS) expect(data).not.toHaveProperty(key);
    });

    it("bez aktera (zahtev bez identiteta) pada na bazni sloj — fail-closed", async () => {
      mockItem(ITEM_ROW);

      const { data, meta } = await service.findOne(7, undefined);

      expect(meta.restricted).toBe(true);
      for (const key of COMMERCIAL_KEYS) expect(data).not.toHaveProperty(key);
      expect(prisma.userPermissionOverride.findUnique).not.toHaveBeenCalled();
    });
  });

  // ================================ child kolekcije iz BigBit `.mdb`-a (Talas B)

  describe("child kolekcije — barkodovi, prevodi, kvalitet, dobavljači", () => {
    const BARKODOVI = [
      {
        id: 1,
        barCode: "8600001",
        multiFactor: new Prisma.Decimal("1.0000"),
      },
      {
        id: 2,
        barCode: "8600002",
        multiFactor: new Prisma.Decimal("12.0000"),
      },
    ];
    const PREVODI = [
      { languageId: 1, foreignName: "Sheet 3mm", foreignUnit: "pcs" },
      { languageId: 2, foreignName: "Blech 3mm", foreignUnit: "St" },
    ];
    const DOBAVLJACI = [
      { id: 5, supplierId: 42, isPrimary: true, leadTimeDays: 7 },
      { id: 9, supplierId: 777, isPrimary: false, leadTimeDays: 21 },
    ];

    it("prazne tabele (bridge još nije prošao) daju prazne nizove i null kvalitet, ne izuzetak", async () => {
      mockItem({ ...ITEM_ROW, qualityTypeId: 0 });

      const { data } = await service.findOne(7, KOMERCIJALA);

      expect(data.barcodes).toEqual([]);
      expect(data.translations).toEqual([]);
      expect(data.suppliers).toEqual([]);
      expect(data.qualityType).toBeNull();
      // qualityTypeId = 0 je legacy „nije zadat" → tabela se i ne dira.
      expect(prisma.itemQualityType.findUnique).not.toHaveBeenCalled();
    });

    /**
     * SRŽ TALASA B: child tabele znaju artikal po BIGBIT šifri
     * (`items.external_item_id`), a NE po `items.id` (QBigTehn IDENTITY).
     * Upit po `items.id` bi tiho vratio tuđe barkodove — zato je ovo zaseban test.
     */
    it("join ide preko external_item_id (4711), NE preko items.id (7)", async () => {
      mockItem(ITEM_ROW);

      await service.findOne(7, KOMERCIJALA);

      for (const call of [
        prisma.itemBarcode.findMany.mock.calls[0],
        prisma.itemTranslation.findMany.mock.calls[0],
        prisma.itemSupplier.findMany.mock.calls[0],
      ]) {
        const [args] = call as [{ where: { itemId: number } }];
        expect(args.where).toEqual({ itemId: 4711 });
        expect(args.where.itemId).not.toBe(7);
      }
    });

    it("artikal bez BigBit parnjaka (external_item_id = 0) uopšte ne dira child tabele", async () => {
      mockItem({ ...ITEM_ROW, externalItemId: 0 });

      const { data } = await service.findOne(7, KOMERCIJALA);

      expect(prisma.itemBarcode.findMany).not.toHaveBeenCalled();
      expect(prisma.itemTranslation.findMany).not.toHaveBeenCalled();
      expect(prisma.itemSupplier.findMany).not.toHaveBeenCalled();
      expect(data.barcodes).toEqual([]);
      expect(data.translations).toEqual([]);
      expect(data.suppliers).toEqual([]);
    });

    it("barkodovi: multiFactor (Decimal) izlazi kao string (BACKEND_RULES §6)", async () => {
      mockItem(ITEM_ROW);
      prisma.itemBarcode.findMany.mockResolvedValue(BARKODOVI);

      const { data } = await service.findOne(7, KOMERCIJALA);

      expect(data.barcodes).toEqual([
        { id: 1, barCode: "8600001", multiFactor: "1" },
        { id: 2, barCode: "8600002", multiFactor: "12" },
      ]);
    });

    it("prevodi i kvalitet stižu i u BAZNOM sloju (nisu komercijalni podatak)", async () => {
      mockItem(ITEM_ROW);
      prisma.itemBarcode.findMany.mockResolvedValue(BARKODOVI);
      prisma.itemTranslation.findMany.mockResolvedValue(PREVODI);
      prisma.itemQualityType.findUnique.mockResolvedValue({
        id: 3,
        qualityCode: "K1",
        description: "Prva klasa",
      });

      const { data, meta } = await service.findOne(7, OSNOVNI);

      expect(meta.restricted).toBe(true);
      expect(data.translations).toEqual(PREVODI);
      expect(data.barcodes).toHaveLength(2);
      expect(data.qualityType).toEqual({
        id: 3,
        qualityCode: "K1",
        description: "Prva klasa",
      });
      expect(prisma.itemQualityType.findUnique).toHaveBeenCalledWith({
        where: { id: 3 },
        select: { id: true, qualityCode: true, description: true },
      });
    });

    it("kvalitet: šifra bez reda u šifarniku → null, ne izuzetak", async () => {
      mockItem(ITEM_ROW);
      prisma.itemQualityType.findUnique.mockResolvedValue(null);

      const { data } = await service.findOne(7, KOMERCIJALA);
      expect(data.qualityType).toBeNull();
    });

    it("dobavljači SA masters.read: primarni prvi, ime iz customers, orphan → supplier null", async () => {
      mockItem(ITEM_ROW);
      prisma.itemSupplier.findMany.mockResolvedValue(DOBAVLJACI);
      // 777 je orphan (dobavljač ne postoji u `customers`) — meki ref, ne 500.
      prisma.customer.findMany.mockResolvedValue([
        { id: 42, name: "Metalka d.o.o." },
      ]);

      const { data } = await service.findOne(7, KOMERCIJALA);

      const [args] = prisma.itemSupplier.findMany.mock.calls[0] as [
        { orderBy: unknown },
      ];
      expect(args.orderBy).toEqual([{ isPrimary: "desc" }, { id: "asc" }]);
      expect(prisma.customer.findMany).toHaveBeenCalledWith({
        where: { id: { in: [42, 777] } },
        select: { id: true, name: true },
      });
      expect(data.suppliers).toEqual([
        {
          id: 5,
          supplierId: 42,
          isPrimary: true,
          leadTimeDays: 7,
          supplier: { id: 42, name: "Metalka d.o.o." },
        },
        {
          id: 9,
          supplierId: 777,
          isPrimary: false,
          leadTimeDays: 21,
          supplier: null,
        },
      ]);
    });

    it("dobavljači BEZ masters.read: ključa nema u odgovoru i tabela se NE ČITA", async () => {
      mockItem(ITEM_ROW);
      prisma.itemSupplier.findMany.mockResolvedValue(DOBAVLJACI);

      const { data, meta } = await service.findOne(7, OSNOVNI);

      expect(meta.restricted).toBe(true);
      // Ključ ne postoji (nije prazan niz) — dobavljač i lead time su komercijala.
      expect(data).not.toHaveProperty("suppliers");
      expect(prisma.itemSupplier.findMany).not.toHaveBeenCalled();
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
    });
  });
});

// ================================================================ Guard

describe("ItemsController — permisija", () => {
  it("klasa je iza `directory.read` — istog ključa kao DirectoryController", () => {
    expect(Reflect.getMetadata(PERMISSION_KEY_METADATA, ItemsController)).toBe(
      PERMISSIONS.DIRECTORY_READ,
    );
    expect(Reflect.getMetadata(PERMISSION_KEY_METADATA, ItemsController)).toBe(
      Reflect.getMetadata(PERMISSION_KEY_METADATA, DirectoryController),
    );
  });

  it("nijedna GET ruta nema svoj (širi) ključ — sve nasleđuju klasni", () => {
    for (const name of ["list", "findOne"]) {
      const handler = Object.getOwnPropertyDescriptor(
        ItemsController.prototype,
        name,
      )?.value as object;
      expect(
        Reflect.getMetadata(PERMISSION_KEY_METADATA, handler),
      ).toBeUndefined();
    }
  });

  /**
   * Kapija OSTAJE široka (`directory.read`) — `masters.read` NE sme da procuri na
   * rutu, inače bi bazni sloj (koji svako sme da vidi) postao 403.
   */
  it("ruta NIJE iza `masters.read` — taj ključ bira sloj kolona, ne pristup", () => {
    expect(
      Reflect.getMetadata(PERMISSION_KEY_METADATA, ItemsController),
    ).not.toBe(PERMISSIONS.MASTERS_READ);
  });
});

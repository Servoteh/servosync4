import { UnprocessableEntityException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { escapeLike, ItemLookupService } from "./item-lookup.service";
import { LookupsController } from "./lookups.controller";
import { LookupsModule } from "./lookups.module";
import {
  ITEM_LOOKUP_DEFAULT_LIMIT,
  ITEM_LOOKUP_MAX_LIMIT,
} from "./dto/item-lookup.dto";

/** Red kakav sirovi upit vraća iz `items` (snake_case, kao iz baze). */
function itemRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    catalog_number: "4711-02",
    bar_code: "8600000000017",
    external_code: "EXT-1",
    plu: 0,
    name: "Lim 2mm",
    unit: "kom",
    active: true,
    not_stock_tracked: false,
    goods_tax_rate_code: "3",
    service_tax_rate_code: "1",
    ...over,
  };
}

interface MockOpts {
  items?: ReturnType<typeof itemRow>[];
  onHand?: Array<{ item_id: number; warehouse_id: number; state: unknown }>;
  reservations?: Array<{
    itemId: number;
    warehouseId: number;
    _sum: { quantity: Prisma.Decimal | null };
  }>;
  taxRates?: Array<Record<string, unknown>>;
  warehouse?: { id: number } | null;
}

/**
 * Dvojnik Prisma klijenta.
 *
 * NAMERNO NEMA `stockLevel` — isto kao u `reservation.service.spec.ts`: ako se
 * ikad neko vrati na `stock_levels` (tabelu koju NIKO u `src/` ne upisuje, pa je
 * uvek prazna), test pada ovde, a ne tek na produkciji sa „nema na stanju".
 */
function prismaMock(opts: MockOpts = {}) {
  const sqlSeen: string[] = [];
  return {
    sqlSeen,
    $queryRaw: jest.fn((q: Prisma.Sql) => {
      const text = String(q.sql);
      sqlSeen.push(text);
      return Promise.resolve(
        text.includes("stock_document_items")
          ? (opts.onHand ?? [])
          : (opts.items ?? []),
      );
    }),
    stockReservation: {
      groupBy: jest.fn().mockResolvedValue(opts.reservations ?? []),
    },
    taxRate: { findMany: jest.fn().mockResolvedValue(opts.taxRates ?? []) },
    warehouse: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.warehouse === undefined ? { id: 7 } : opts.warehouse,
        ),
    },
  };
}

async function makeService(opts: MockOpts = {}) {
  const prisma = prismaMock(opts);
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      ItemLookupService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return { service: mod.get(ItemLookupService), prisma };
}

/** Sirovi upit nad `items` (ne nad kretanjima) — za tvrdnje o SQL-u. */
function itemQuery(prisma: ReturnType<typeof prismaMock>): Prisma.Sql {
  const call = prisma.$queryRaw.mock.calls.find(([q]: [Prisma.Sql]) =>
    String(q.sql).includes("FROM items i"),
  );
  if (!call) throw new Error("upit nad `items` nije izvršen");
  return call[0];
}

describe("ItemLookupService — GET /v1/lookups/items", () => {
  // ------------------------------------------------------------- KRATAK UPIT

  it("bez `q` NE dira bazu i vraća praznu listu (ne ceo šifarnik)", async () => {
    const { service, prisma } = await makeService({ items: [itemRow()] });
    const res = await service.search({});
    expect(res.data).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(res.meta.note).toContain("bar 2 znaka");
  });

  it("`q` od jednog znaka je i dalje prazna lista", async () => {
    const { service, prisma } = await makeService({ items: [itemRow()] });
    const res = await service.search({ q: " a " });
    expect(res.data).toEqual([]);
    expect(res.meta.count).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------- DŽOKERI (LIKE)

  it("ekranira LIKE džokere — `q=%` ne sme da izlista šifarnik", async () => {
    expect(escapeLike("%")).toBe("\\%");
    expect(escapeLike("_")).toBe("\\_");
    // Bekslež prvi, inače bi se ekranirao sopstveni bekslež.
    expect(escapeLike("a\\%b")).toBe("a\\\\\\%b");

    const { service, prisma } = await makeService({ items: [] });
    await service.search({ q: "ab%" });
    const values = itemQuery(prisma).values;
    expect(values).toContain("%ab\\%%");
    expect(values).not.toContain("%ab%%");
  });

  // -------------------------------------------------------------------- KLJUČ

  it("podrazumevani ključ je CATALOG i pretražuje kataloški broj", async () => {
    const { service, prisma } = await makeService({ items: [] });
    const res = await service.search({ q: "4711" });
    expect(res.meta.key).toBe("CATALOG");
    expect(String(itemQuery(prisma).sql)).toContain("i.catalog_number ILIKE");
  });

  it.each([
    ["BARCODE", "i.bar_code ILIKE"],
    ["EXT", "i.external_code ILIKE"],
    ["NAME", "i.name ILIKE"],
  ])("ključ %s gađa svoju kolonu", async (key, fragment) => {
    const { service, prisma } = await makeService({ items: [] });
    const res = await service.search({ q: "abc", key });
    expect(res.meta.key).toBe(key);
    expect(String(itemQuery(prisma).sql)).toContain(fragment);
  });

  it("ključ je neosetljiv na veličinu slova i razmake", async () => {
    const { service } = await makeService({ items: [] });
    const res = await service.search({ q: "abc", key: " name " });
    expect(res.meta.key).toBe("NAME");
  });

  it("nepoznat ključ = 422 sa srpskom porukom i spiskom dozvoljenih", async () => {
    const { service } = await makeService();
    await expect(service.search({ q: "abc", key: "SIFRA" })).rejects.toThrow(
      UnprocessableEntityException,
    );
    await expect(service.search({ q: "abc", key: "SIFRA" })).rejects.toThrow(
      /Nepoznat ključ pretrage/,
    );
  });

  // --------------------------------------------------------------------- PLU

  it("PLU sa slovima vraća praznu listu, ne 500 i ne upit", async () => {
    const { service, prisma } = await makeService({ items: [itemRow()] });
    const res = await service.search({ q: "12a", key: "PLU" });
    expect(res.data).toEqual([]);
    expect(res.meta.note).toContain("PLU je broj");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("PLU sa ciframa traži tačnu jednakost i NE stavlja golu nulu u ORDER BY", async () => {
    const { service, prisma } = await makeService({ items: [] });
    await service.search({ q: "1234", key: "PLU" });
    const q = itemQuery(prisma);
    expect(String(q.sql)).toContain("i.plu = ?");
    expect(q.values).toContain(1234);
    // `ORDER BY 0` bi Postgres pročitao kao redni broj kolone → greška.
    expect(String(q.sql)).toMatch(/ORDER BY i\.name ASC, i\.id ASC/);
    expect(String(q.sql)).not.toMatch(/ORDER BY\s+0/);
  });

  // ------------------------------------------------------------ RELEVANTNOST

  it("tačno poklapanje ide pre prefiksa, prefiks pre sredine reči", async () => {
    const { service, prisma } = await makeService({ items: [] });
    await service.search({ q: "4711-02" });
    const q = itemQuery(prisma);
    const sql = String(q.sql);
    expect(sql).toContain("ORDER BY CASE");
    expect(sql).toContain("lower(i.catalog_number) = lower(?)");
    // Neekranirani pojam za jednakost + prefiks šablon za drugi nivo.
    expect(q.values).toContain("4711-02");
    expect(q.values).toContain("4711-02%");
  });

  // ------------------------------------------------------------------- LIMIT

  it("limit: podrazumevano 20, gornja granica 50, smeće → podrazumevano", async () => {
    for (const [raw, expected] of [
      [undefined, ITEM_LOOKUP_DEFAULT_LIMIT],
      ["5", 5],
      ["999", ITEM_LOOKUP_MAX_LIMIT],
      ["-3", 1],
      ["abc", ITEM_LOOKUP_DEFAULT_LIMIT],
    ] as Array<[string | undefined, number]>) {
      const { service, prisma } = await makeService({ items: [] });
      const res = await service.search({ q: "abc", limit: raw });
      expect(res.meta.limit).toBe(expected);
      // Uvek se traži limit + 1 reda — `hasMore` bez zasebnog COUNT-a.
      expect(itemQuery(prisma).values).toContain(expected + 1);
    }
  });

  it("`hasMore` je tačan, a vraća se tačno `limit` redova", async () => {
    const items = Array.from({ length: 4 }, (_, i) =>
      itemRow({ id: i + 1, catalog_number: `K${i}` }),
    );
    const { service } = await makeService({ items });
    const res = await service.search({ q: "abc", limit: "3" });
    expect(res.data).toHaveLength(3);
    expect(res.meta.count).toBe(3);
    expect(res.meta.hasMore).toBe(true);
    expect(res.meta.note).toContain("Prikazano prvih 3");
  });

  // ------------------------------------------------------------------ ZALIHE

  it("bez `warehouseId` zaliha je NULL (nikad lažna nula) i kretanja se ne čitaju", async () => {
    const { service, prisma } = await makeService({ items: [itemRow()] });
    const res = await service.search({ q: "4711" });
    expect(res.data[0].stock).toBeNull();
    expect(res.meta.stockSource).toBeNull();
    expect(res.meta.stockNote).toContain("Zalihe nisu tražene");
    expect(prisma.sqlSeen.some((s) => s.includes("stock_document_items"))).toBe(
      false,
    );
    expect(prisma.stockReservation.groupBy).not.toHaveBeenCalled();
  });

  it("sa `warehouseId` zaliha se računa IZ KRETANJA minus otvorene rezervacije", async () => {
    const { service, prisma } = await makeService({
      items: [itemRow({ id: 42 })],
      onHand: [{ item_id: 42, warehouse_id: 7, state: new Prisma.Decimal(60) }],
      reservations: [
        {
          itemId: 42,
          warehouseId: 7,
          _sum: { quantity: new Prisma.Decimal(6) },
        },
      ],
    });
    const res = await service.search({ q: "4711", warehouseId: "7" });

    expect(res.data[0].stock).toEqual({
      warehouseId: 7,
      onHand: "60.000",
      reserved: "6.000",
      available: "54.000",
    });
    expect(res.meta.stockSource).toContain("stock_document_items");
    // Mrtav snapshot `stock_levels` se NE dira ni u jednom upitu…
    expect(prisma.sqlSeen.some((s) => s.includes("stock_levels"))).toBe(false);
    // …i dvojnik ga uopšte nema, pa bi poziv pao ovde, ne na produkciji.
    expect(
      (prisma as unknown as Record<string, unknown>).stockLevel,
    ).toBeUndefined();
  });

  it("artikal bez kretanja dobija stanje 0 iz agregata, ne `null`", async () => {
    const { service } = await makeService({
      items: [itemRow({ id: 42 })],
      onHand: [],
      reservations: [],
    });
    const res = await service.search({ q: "4711", warehouseId: "7" });
    expect(res.data[0].stock).toEqual({
      warehouseId: 7,
      onHand: "0.000",
      reserved: "0.000",
      available: "0.000",
    });
  });

  it("artikal koji se ne vodi na zalihama ima `stock: null`, ne 0", async () => {
    const { service } = await makeService({
      items: [itemRow({ id: 42, not_stock_tracked: true })],
      onHand: [],
    });
    const res = await service.search({ q: "4711", warehouseId: "7" });
    expect(res.data[0].stockTracked).toBe(false);
    expect(res.data[0].stock).toBeNull();
    expect(res.meta.stockNote).toContain("nije stanje 0");
  });

  it("nepostojeći magacin = 422 (inače bi svaki artikal lagao stanje 0)", async () => {
    const { service, prisma } = await makeService({
      items: [itemRow()],
      warehouse: null,
    });
    await expect(
      service.search({ q: "4711", warehouseId: "99" }),
    ).rejects.toThrow(/Magacin 99 ne postoji/);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(["abc", "0", "-1", "2.5"])(
    "warehouseId=%s je 422, ne tiho ignorisanje",
    async (raw) => {
      const { service } = await makeService();
      await expect(
        service.search({ q: "4711", warehouseId: raw }),
      ).rejects.toThrow(/warehouseId mora biti pozitivan ceo broj/);
    },
  );

  // -------------------------------------------------------------- PDV TARIFE

  it("stopa se čita iz `tax_rates` kao ΣStopa (sve komponente tarife)", async () => {
    const { service } = await makeService({
      items: [
        itemRow({ goods_tax_rate_code: "3", service_tax_rate_code: "1" }),
      ],
      taxRates: [
        {
          code: "3",
          baseRate: 18,
          railwayRate: 1,
          cityRate: 0.5,
          warRate: 0.5,
          specialRate: 0,
        },
        {
          code: "1",
          baseRate: 20,
          railwayRate: 0,
          cityRate: 0,
          warRate: 0,
          specialRate: 0,
        },
      ],
    });
    const res = await service.search({ q: "4711" });
    expect(res.data[0].goodsVatRatePercent).toBe("20.00");
    expect(res.data[0].serviceVatRatePercent).toBe("20.00");
  });

  it("bez reda u `tax_rates` pada na zajedničku mapu VAT_RATE_BY_CODE", async () => {
    const { service } = await makeService({
      items: [
        itemRow({
          id: 1,
          goods_tax_rate_code: "2",
          service_tax_rate_code: "4",
        }),
        itemRow({
          id: 2,
          goods_tax_rate_code: "XX",
          service_tax_rate_code: "0",
        }),
      ],
      taxRates: [],
    });
    const res = await service.search({ q: "4711" });
    expect(res.data[0].goodsVatRatePercent).toBe("10.00"); // kod „2" = NIZA 10%
    expect(res.data[0].serviceVatRatePercent).toBe("8.00"); // kod „4" = POLJO 8%
    expect(res.data[1].goodsVatRatePercent).toBe("0.00"); // nepoznat kod → 0
    expect(res.data[1].serviceVatRatePercent).toBe("0.00");
  });

  it("NULL šifra tarife pada na legacy podrazumevane (3 = roba, 1 = usluga)", async () => {
    const { service } = await makeService({
      items: [
        itemRow({ goods_tax_rate_code: null, service_tax_rate_code: null }),
      ],
      taxRates: [],
    });
    const res = await service.search({ q: "4711" });
    expect(res.data[0].goodsTaxRateCode).toBe("3");
    expect(res.data[0].serviceTaxRateCode).toBe("1");
    expect(res.data[0].goodsVatRatePercent).toBe("20.00");
  });

  // ------------------------------------------------------ AKTIVNI / OBRISANI

  it("obrisani artikli se ne prikazuju NIKAD, neaktivni samo na zahtev", async () => {
    const { service, prisma } = await makeService({ items: [] });
    await service.search({ q: "abc" });
    const base = String(itemQuery(prisma).sql);
    expect(base).toContain("COALESCE(i.to_delete, FALSE) = FALSE");
    expect(base).toContain("COALESCE(i.active, TRUE) = TRUE");

    const second = await makeService({ items: [] });
    await second.service.search({ q: "abc", includeInactive: "true" });
    const relaxed = String(itemQuery(second.prisma).sql);
    expect(relaxed).toContain("COALESCE(i.to_delete, FALSE) = FALSE");
    expect(relaxed).not.toContain("COALESCE(i.active, TRUE) = TRUE");
  });

  // ------------------------------------------------------------------ OMOTAČ

  it("odgovor je `{ data, meta }` sa poljima koje ekran unosa traži", async () => {
    const { service } = await makeService({
      items: [itemRow({ id: 42, plu: 0 })],
      taxRates: [],
    });
    const res = await service.search({ q: "4711", limit: "10" });
    expect(Object.keys(res).sort()).toEqual(["data", "meta"]);
    expect(res.data[0]).toEqual({
      id: 42,
      catalogNumber: "4711-02",
      barCode: "8600000000017",
      externalCode: "EXT-1",
      plu: null, // legacy 0 = „nema PLU", ne PLU nula
      name: "Lim 2mm",
      unit: "kom",
      active: true,
      stockTracked: true,
      goodsTaxRateCode: "3",
      serviceTaxRateCode: "1",
      goodsVatRatePercent: "20.00",
      serviceVatRatePercent: "20.00",
      stock: null,
    });
    expect(res.meta).toMatchObject({
      key: "CATALOG",
      q: "4711",
      limit: 10,
      count: 1,
      hasMore: false,
      warehouseId: null,
    });
  });
});

/**
 * Ožičenje modula — bez ovoga bi `ItemLookupService` mogao da bude savršen, a ruta
 * `/v1/lookups/items` i dalje mrtva (nedostaje provider u `lookups.module.ts` →
 * Nest padne tek na dizanju aplikacije, ne na testu).
 */
describe("LookupsModule — ožičenje rute /items", () => {
  it("kontroler dobija oba servisa i ruta vraća `{ data, meta }`", async () => {
    const prisma = prismaMock({ items: [itemRow({ id: 42 })] });
    const mod: TestingModule = await Test.createTestingModule({
      imports: [LookupsModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    const controller = mod.get(LookupsController);
    const res = await controller.items("4711");
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe(42);
    expect(res.meta.key).toBe("CATALOG");
  });
});

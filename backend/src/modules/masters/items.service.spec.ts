import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ItemsService } from "./items.service";
import { ItemsController } from "./items.controller";
import { ITEM_SORT_COLUMNS } from "./dto/list-items.dto";
import { DirectoryController } from "../directory/directory.controller";
import { PERMISSION_KEY_METADATA } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import {
  ITEM_WRITE_BLOCKED_MESSAGE,
  NATIVE_ITEM_ID_BASE,
} from "./items.write-policy";
import type { AuthUser } from "../auth/jwt.strategy";

/** Mock PrismaService — samo modeli koje `ItemsService` čita. */
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
    // Šifarnici koje forma „Unos artikala" nudi kroz combo (kvalitet, dimenzija).
    itemQualityType: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    itemRaster: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    taxRate: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

/** Tekst upita iz `Prisma.sql` objekta — servis uvek zove `$queryRaw(Prisma.sql\`…\`)`. */
function rawSql(call: unknown[]): string {
  return (call[0] as Prisma.Sql).sql;
}

/**
 * Sortabilne kolone podeljene po tome SME LI IM VREDNOST BITI PRAZNA — pročitano iz
 * same šeme (`Prisma.dmmf`), ne prepisano ovde.
 *
 * Prepisan spisak bi zastario ćutke: kolona koja u `schema.prisma` postane nullable
 * ostala bi bez `nulls: "last"`, test bi i dalje bio zelen, a korisnik bi na drugi
 * klik zaglavlja dobio ekran pun praznih redova.
 */
function itemFieldIsRequired(name: string): boolean {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "Item");
  const field = model?.fields.find((f) => f.name === name);
  if (!field) throw new Error(`Kolona '${name}' ne postoji u modelu Item.`);
  return field.isRequired;
}

function nullableSortColumns(): string[] {
  return ITEM_SORT_COLUMNS.filter((c) => !itemFieldIsRequired(c));
}

function notNullSortColumns(): string[] {
  return ITEM_SORT_COLUMNS.filter((c) => itemFieldIsRequired(c));
}

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

  it("list(): pretraga `q` gađa kat. broj/naziv/barkod/ext. šifru (case-insensitive)", async () => {
    await service.list({ q: " ku-12 " });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput; orderBy: unknown; take: number },
    ];
    expect(args.where.OR).toEqual([
      { catalogNumber: { contains: "ku-12", mode: "insensitive" } },
      { name: { contains: "ku-12", mode: "insensitive" } },
      { barCode: { contains: "ku-12", mode: "insensitive" } },
      { externalCode: { contains: "ku-12", mode: "insensitive" } },
    ]);
    // 91k redova — bez LIMIT-a se ne izlazi; podrazumevano 50 (parsePagination).
    expect(args.take).toBe(50);
    // Isti `where` mora ići i u count, inače je `meta.total` laž.
    expect(prisma.item.count).toHaveBeenCalledWith({ where: args.where });
  });

  it("list(): ekran skroluje nadovezivanjem strana — `pageSize=200` prolazi, veće se seče", async () => {
    await service.list({ pageSize: "200", page: "3" });
    const [first] = prisma.item.findMany.mock.calls[0] as [
      { take: number; skip: number },
    ];
    expect(first.take).toBe(200);
    expect(first.skip).toBe(400);

    prisma.item.findMany.mockClear();
    await service.list({ pageSize: "1000" });
    const [second] = prisma.item.findMany.mock.calls[0] as [{ take: number }];
    // 92.592 reda — tvrda kapa ostaje 200 i kad frontend zatraži više.
    expect(second.take).toBe(200);
  });

  it("list(): sort je BigBit sort pregleda — grupa, kataloški broj, naziv (uz `id` kao tie-break)", async () => {
    await service.list({});

    const [args] = prisma.item.findMany.mock.calls[0] as [{ orderBy: unknown }];
    // `ORDER BY Grupa, [Kataloski broj], Naziv` iz BigBit upita „Pregled artikala".
    // `id` NE menja vidljiv redosled — kataloški broj nije jedinstven (1.980 grupa
    // duplikata), pa bez njega paginacija ume da ponovi ili preskoči red.
    expect(args.orderBy).toEqual([
      { groupCode: "asc" },
      { catalogNumber: "asc" },
      { name: "asc" },
      { id: "asc" },
    ]);
  });

  it("list(): `?sort=&dir=` sortira po traženoj koloni, a `id` ostaje kao tie-break", async () => {
    await service.list({ sort: "wholesalePrice", dir: "desc" });

    const [args] = prisma.item.findMany.mock.calls[0] as [{ orderBy: unknown }];
    // Traženi ključ je PRVI i jedini — BigBit grupisanje se ne zadržava kao
    // sekundarni kriterijum, inače bi „najskuplji artikli" bili razbijeni po grupama.
    // VP cena je nullable → prazno ide na kraj (v. blok „prazne vrednosti" niže).
    expect(args.orderBy).toEqual([
      { wholesalePrice: { sort: "desc", nulls: "last" } },
      { id: "asc" },
    ]);
  });

  it("list(): `dir` se sme izostaviti — podrazumevano je rastuće", async () => {
    await service.list({ sort: "shelf" });

    const [args] = prisma.item.findMany.mock.calls[0] as [{ orderBy: unknown }];
    expect(args.orderBy).toEqual([
      { shelf: { sort: "asc", nulls: "last" } },
      { id: "asc" },
    ]);
  });

  it("list(): SVAKI sort nosi `id` na kraju — bez toga skrol duplira i preskače redove", async () => {
    // Nijedna sortabilna kolona nije jedinstvena (kat. broj: 1.980 grupa duplikata;
    // polica: 2.839 nepraznih na 92.592 reda), a Postgres sme da promeni redosled
    // jednakih redova između dva LIMIT/OFFSET upita. Zato se tie-break pinuje za sve.
    // Provera je nad SVIM dozvoljenim kolonama i namerno ne gleda OBLIK vrednosti
    // (golo `desc` vs `{ sort, nulls }`) — to je posao testova o praznim vrednostima.
    for (const column of ITEM_SORT_COLUMNS) {
      prisma.item.findMany.mockClear();
      await service.list({ sort: column, dir: "desc" });
      const [args] = prisma.item.findMany.mock.calls[0] as [
        { orderBy: Record<string, unknown>[] },
      ];
      expect(args.orderBy).toHaveLength(2);
      expect(Object.keys(args.orderBy[0])).toEqual([column]);
      expect(args.orderBy[1]).toEqual({ id: "asc" });
    }
  });

  it("list(): sort po NULLABLE koloni gura prazne redove NA KRAJ — i uzlazno i silazno", async () => {
    // 🔴 Bez `nulls: "last"` Postgres na DESC podrazumeva NULLS FIRST: drugi klik na
    // „Polica" je vraćao prvo 89.753 artikla bez police (92.592 ukupno, policu ima
    // 2.839 — mereno na produkciji 04.08.2026), a kapa učitavanja je 5.000 redova.
    // Korisnik dakle nikad ne bi video nijednu policu, uz listu koja izgleda ispravna.
    // Isto važi za „Bar kod" (10 nepraznih), „INO naziv", „Ext. šifru"…
    for (const column of nullableSortColumns()) {
      for (const dir of ["asc", "desc"] as const) {
        prisma.item.findMany.mockClear();
        await service.list({ sort: column, dir });
        const [args] = prisma.item.findMany.mock.calls[0] as [
          { orderBy: unknown[] },
        ];
        expect(args.orderBy[0]).toEqual({
          [column]: { sort: dir, nulls: "last" },
        });
        // Tie-break se ne gubi ni u ovom obliku.
        expect(args.orderBy[1]).toEqual({ id: "asc" });
      }
    }
  });

  it("list(): sort po NOT NULL koloni ostaje golo `asc`/`desc` (Prisma tamo ne prima `nulls`)", async () => {
    // `{ sort, nulls }` na NOT NULL polju Prisma odbija tek u radu (validaciona
    // greška upita) — klik na zaglavlje „Naziv" bi postao 500. Nema šta ni da gura
    // na kraj: te kolone praznu vrednost nemaju.
    for (const column of notNullSortColumns()) {
      for (const dir of ["asc", "desc"] as const) {
        prisma.item.findMany.mockClear();
        await service.list({ sort: column, dir });
        const [args] = prisma.item.findMany.mock.calls[0] as [
          { orderBy: unknown[] },
        ];
        expect(args.orderBy[0]).toEqual({ [column]: dir });
        expect(args.orderBy[1]).toEqual({ id: "asc" });
      }
    }
  });

  it("list(): kolona van allowlist-a je 400 sa spiskom dozvoljenih (ne tiho vraćanje na BigBit sort)", async () => {
    // Tiho ignorisanje bi korisniku dalo listu sortiranu po grupi, a on bi prvih 50
    // redova pročitao kao „vrh po ceni" — pogrešan odgovor koji izgleda tačno.
    let thrown: unknown;
    try {
      await service.list({ sort: "cena" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const message = (thrown as BadRequestException).message;
    expect(message).toContain("cena");
    expect(message).toContain("wholesalePrice");
    expect(prisma.item.findMany).not.toHaveBeenCalled();
  });

  it("list(): sort po tehničkim/nevidljivim kolonama nije dozvoljen (`id`, `active`, `password`…)", async () => {
    for (const column of ["id", "active", "alwaysTaxGoods", "signature"]) {
      await expect(service.list({ sort: column })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it("list(): `dir` van asc|desc je 400", async () => {
    await expect(
      service.list({ sort: "name", dir: "nagore" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("list(): loš `sort` pada PRE podupita o duplikatima", async () => {
    await expect(
      service.list({ sort: "nepostojeca", duplicateCatalogNumbers: "true" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("list(): filteri groupCode + active se prevode u tačno poklapanje", async () => {
    await service.list({ groupCode: "SIR", active: "false" });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.groupCode).toBe("SIR");
    expect(args.where.active).toBe(false);
    expect(args.where.OR).toBeUndefined();
  });

  it("list(): podgrupa i PodPodgrupa (poreklo) su tačno poklapanje, kao u BigBit combo-u", async () => {
    await service.list({ subgroupCode: " SIR-1 ", originCode: "D " });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.subgroupCode).toBe("SIR-1");
    // „PodPodgrupa" na ekranu = kolona `origin_code` u bazi (BigBit `Poreklo`).
    expect(args.where.originCode).toBe("D");
  });

  it('list(): kataloški broj je PREFIKS (BigBit `Like "…*"`), naziv je „sadrži”', async () => {
    await service.list({ catalogNumber: " 004 ", name: " lim " });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.catalogNumber).toEqual({
      startsWith: "004",
      mode: "insensitive",
    });
    expect(args.where.name).toEqual({ contains: "lim", mode: "insensitive" });
  });

  it("list(): jedinica mere je TAČNO poklapanje bez obzira na velika/mala slova", async () => {
    await service.list({ unit: " kom " });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    // `startsWith` bi na „m" povukao i „m2" i „mm" — korisnik koji iz padajuće liste
    // bira metar nikako ne bi mogao da izdvoji samo metar. Zato `equals`.
    expect(args.where.unit).toEqual({ equals: "kom", mode: "insensitive" });
  });

  it("list(): prazna/izostavljena jedinica mere ne filtrira ništa", async () => {
    await service.list({ unit: "   " });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    // Prazno polje u traci filtera mora značiti „sve jedinice", a ne „jedinica je ''".
    expect(args.where.unit).toBeUndefined();
  });

  it("list(): jedinica mere se slaže sa ostalim filterima i ne dira `OR` pretrage", async () => {
    await service.list({ q: "lim", unit: "kg", groupCode: "SIR" });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.OR).toHaveLength(4);
    expect(args.where.unit).toEqual({ equals: "kg", mode: "insensitive" });
    expect(args.where.groupCode).toBe("SIR");
  });

  it("list(): polica je PREFIKS — uneto „A” daje ceo red A, ne sve što sadrži „A”", async () => {
    await service.list({ shelf: " A " });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.shelf).toEqual({ startsWith: "A", mode: "insensitive" });
    // Sam prefiks ne dodaje uslov prisustva — nema šta da stoji u AND.
    expect(args.where.AND).toBeUndefined();
  });

  it("list(): `shelfPresence=with` pokriva OBA oblika praznog (NULL i prazan string)", async () => {
    await service.list({ shelfPresence: "with" });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    // Uvoz iz BigBit-a piše i NULL i "" za „nema police"; sam `not: null` bi prazne
    // stringove proglasio policom. `not: ""` u Prismi 4+ propušta NULL, pa idu oba.
    expect(args.where.AND).toEqual([
      { shelf: { not: null } },
      { shelf: { not: "" } },
    ]);
    expect(args.where.shelf).toBeUndefined();
  });

  it("list(): `shelfPresence=without` hvata i NULL i prazan string", async () => {
    await service.list({ shelfPresence: "without" });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.AND).toEqual([{ OR: [{ shelf: null }, { shelf: "" }] }]);
  });

  it("list(): prisustvo police NE PREGAZI `OR` objedinjene pretrage ni prefiks police", async () => {
    await service.list({ q: "lim", shelf: "A", shelfPresence: "with" });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    // `q` drži `where.OR`; da je „bez police" upisano tamo, pretraga bi nestala.
    expect(args.where.OR).toHaveLength(4);
    expect(args.where.shelf).toEqual({ startsWith: "A", mode: "insensitive" });
    expect(args.where.AND).toEqual([
      { shelf: { not: null } },
      { shelf: { not: "" } },
    ]);
  });

  it("list(): prisustvo police i filter duplih kat. brojeva se SLAŽU u istom AND-u", async () => {
    prisma.$queryRaw.mockResolvedValue([{ catalog_number: "00001" }]);

    await service.list({
      shelfPresence: "without",
      duplicateCatalogNumbers: "true",
    });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    // `AND` se PUNI, ne dodeljuje — inače bi poslednji filter obrisao prethodni.
    expect(args.where.AND).toEqual([
      { OR: [{ shelf: null }, { shelf: "" }] },
      { catalogNumber: { in: ["00001"] } },
    ]);
  });

  it("list(): `shelfPresence` van with|without je 400, ne tiho prikazivanje svih artikala", async () => {
    await expect(service.list({ shelfPresence: "sve" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.item.findMany).not.toHaveBeenCalled();
  });

  it("list(): izostavljen `shelfPresence` ne filtrira ništa (svi artikli)", async () => {
    await service.list({ shelfPresence: "" });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.AND).toBeUndefined();
    expect(args.where.shelf).toBeUndefined();
  });

  it("list(): dimenzija i kvalitet se filtriraju po celom broju; tekst je 400", async () => {
    await service.list({ rasterId: "12", qualityTypeId: "3" });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.rasterId).toBe(12);
    expect(args.where.qualityTypeId).toBe(3);

    await expect(service.list({ rasterId: "dvanaest" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("list(): `active` koji nije true/false je 400, ne tiho ignorisanje", async () => {
    await expect(service.list({ active: "da" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("list(): `duplicateCatalogNumbers=true` traži kat. brojeve sa COUNT(*)>1 i sužava listu na njih", async () => {
    prisma.$queryRaw.mockResolvedValue([
      { catalog_number: "00001" },
      { catalog_number: "00042" },
    ]);

    await service.list({
      duplicateCatalogNumbers: "true",
      catalogNumber: "00",
    });

    const sql = rawSql(prisma.$queryRaw.mock.calls[0] as unknown[]);
    expect(sql).toContain("HAVING COUNT(*) > 1");
    expect(sql).toContain("GROUP BY catalog_number");
    // Radna lista za čišćenje, ne izveštaj — spisak duplikata je ograničen.
    expect(sql).toContain("LIMIT 5000");

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    // Duplikati idu u AND, da se smeju kombinovati sa prefiks filterom nad ISTOM kolonom.
    expect(args.where.AND).toEqual([
      { catalogNumber: { in: ["00001", "00042"] } },
    ]);
    expect(args.where.catalogNumber).toEqual({
      startsWith: "00",
      mode: "insensitive",
    });
  });

  it("list(): kad duplikata nema, filter vraća praznu listu — ne sve artikle", async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.list({ duplicateCatalogNumbers: "true" });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.AND).toEqual([{ catalogNumber: { in: [] } }]);
  });

  it("list(): `duplicateCatalogNumbers=false` ne pokreće podupit", async () => {
    await service.list({ duplicateCatalogNumbers: "false" });

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.AND).toBeUndefined();
  });

  it("list(): loš parametar je 400 PRE podupita o duplikatima (ne plaća se skup upit za neispravan zahtev)", async () => {
    await expect(
      service.list({ duplicateCatalogNumbers: "true", active: "mozda" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("list(): vraća 22 BigBit kolone u BigBit REDOSLEDU (korisnička navika je ugovor)", async () => {
    prisma.item.findMany.mockResolvedValue([
      {
        id: 1,
        catalogNumber: "00042",
        name: "Lim",
        unit: "kom",
        shelf: "A-1",
        weight: 2.5,
        groupCode: "SIR",
        subgroupCode: "SIR-1",
        originCode: "D",
        wholesalePrice: new Prisma.Decimal("1200.0000"),
        retailPrice: new Prisma.Decimal("1440.0000"),
        goodsTaxRateCode: "3",
        alwaysTaxGoods: true,
        thickness: 3,
        box: 11.775,
        fxSalePrice: new Prisma.Decimal("10.2500"),
        accountingCode: "1320",
        accountingCode2: "0",
        plu: 7,
        externalItemId: 55123,
        barCode: "860123",
        externalCode: "EXT-1",
        foreignName: "Sheet",
        active: true,
      },
    ]);
    prisma.item.count.mockResolvedValue(1);

    const res = await service.list({});
    const row = res.data[0];

    // Redosled ključeva u odgovoru = redosled kolona na ekranu (levo → desno).
    expect(Object.keys(row).slice(0, 24)).toEqual([
      "id",
      "catalogNumber",
      "name",
      "unit",
      "shelf",
      "weight",
      "groupCode",
      "subgroupCode",
      "originCode",
      "wholesalePrice",
      "retailPrice",
      "goodsTaxRateCode",
      "alwaysTaxGoods",
      "thickness",
      "box",
      "fxSalePrice",
      "accountingCode",
      "accountingCode2",
      "plu",
      "externalItemId",
      "barCode",
      "externalCode",
      "foreignName",
      "active",
    ]);
    // Novac ide kao string (BACKEND_RULES §6), a ne kao Decimal objekat.
    expect(row.wholesalePrice).toBe("1200");
    expect(row.retailPrice).toBe("1440");
    expect(row.fxSalePrice).toBe("10.25");
    // Kolona „ID" = BigBit šifra artikla, NIKAD `items.id`.
    expect(row.externalItemId).toBe(55123);
    expect(row.native).toBe(false);
  });

  it("list(): 4.0-native red je označen — kolona „ID” mu je 0, pa UI mora znati zašto", async () => {
    prisma.item.findMany.mockResolvedValue([
      {
        id: 900_000_001,
        catalogNumber: "00043",
        name: "Nov artikal",
        groupCode: "SIR",
        subgroupCode: "0",
        originCode: "0",
        externalItemId: 0,
      },
    ]);
    prisma.item.count.mockResolvedValue(1);

    const res = await service.list({});
    expect(res.data[0].native).toBe(true);
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

    const res = await service.list({});

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

  it("list(): kad šifarnik postoji, popunjavaju se opisi GRUPE, PODGRUPE i PodPodgrupe", async () => {
    prisma.item.findMany.mockResolvedValue([
      {
        id: 1,
        catalogNumber: "A-1",
        groupCode: "SIR",
        subgroupCode: "SIR-1",
        originCode: "D",
        name: "Lim",
      },
    ]);
    prisma.item.count.mockResolvedValue(1);
    prisma.itemGroup.findMany.mockResolvedValue([
      { code: "SIR", description: "Sirovine" },
    ]);
    prisma.itemSubgroup.findMany.mockResolvedValue([
      { code: "SIR-1", description: "Limovi" },
    ]);
    prisma.itemOrigin.findMany.mockResolvedValue([
      { code: "D", description: "Domaće" },
    ]);

    const res = await service.list({});

    // Do 04.08.2026 su se u listi razrešavale samo grupe — kolone Podgrupa i
    // PodPodgrupa su prikazivale golu šifru, a u BigBit-u operater vidi opis.
    expect(prisma.itemSubgroup.findMany).toHaveBeenCalledWith({
      where: { code: { in: ["SIR-1"] } },
      select: { code: true, description: true },
    });
    expect(res.data[0].group).toEqual({ code: "SIR", description: "Sirovine" });
    expect(res.data[0].subgroup).toEqual({
      code: "SIR-1",
      description: "Limovi",
    });
    expect(res.data[0].origin).toEqual({ code: "D", description: "Domaće" });
  });

  it("findOne(): vraća pun slog, Decimal kao string i sva tri razrešena šifarnika", async () => {
    prisma.item.findUnique.mockResolvedValue({
      id: 7,
      catalogNumber: "A-7",
      name: "Lim 3mm",
      groupCode: "SIR",
      subgroupCode: "SIR-1",
      originCode: "D",
      manualMarkupPercent: new Prisma.Decimal("12.5000"),
      thickness: 3,
    });
    prisma.itemGroup.findMany.mockResolvedValue([
      { code: "SIR", description: "Sirovine" },
    ]);
    prisma.itemSubgroup.findMany.mockResolvedValue([]);
    prisma.itemOrigin.findMany.mockResolvedValue([
      { code: "D", description: "Domaće" },
    ]);

    const { data } = await service.findOne(7);

    expect(data.manualMarkupPercent).toBe("12.5");
    expect(typeof data.manualMarkupPercent).toBe("string");
    expect(data.group).toEqual({ code: "SIR", description: "Sirovine" });
    // Podgrupa ima kod, ali šifarnik je prazan → naziv null, NE izuzetak.
    expect(data.subgroup).toEqual({ code: "SIR-1", description: null });
    expect(data.origin).toEqual({ code: "D", description: "Domaće" });
    expect(data.thickness).toBe(3);
  });

  it("findOne(): nepostojeći artikal je 404, ne 500", async () => {
    prisma.item.findUnique.mockResolvedValue(null);
    await expect(service.findOne(999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("findOne(): dimenzija i kvalitet stižu kao NAZIVI, ne kao gole šifre", async () => {
    prisma.item.findUnique.mockResolvedValue({
      id: 7,
      groupCode: "SIR",
      subgroupCode: "0",
      originCode: "0",
      rasterId: 12,
      qualityTypeId: 3,
      goodsTaxRateCode: "0",
      serviceTaxRateCode: "0",
    });
    prisma.itemRaster.findUnique.mockResolvedValue({ name: "1000x2000" });
    prisma.itemQualityType.findUnique.mockResolvedValue({ code: "S235" });

    const { data } = await service.findOne(7);

    expect(prisma.itemRaster.findUnique).toHaveBeenCalledWith({
      where: { id: 12 },
      select: { name: true },
    });
    expect(data.rasterName).toBe("1000x2000");
    expect(data.qualityName).toBe("S235");
  });

  it("findOne(): brojčana 0 NIJE „prazno” — kvalitet `id = 0` postoji u šifarniku i prikazuje se", async () => {
    prisma.item.findUnique.mockResolvedValue({
      id: 7,
      groupCode: "SIR",
      subgroupCode: "0",
      originCode: "0",
      rasterId: 0,
      qualityTypeId: 0,
      goodsTaxRateCode: "0",
      serviceTaxRateCode: "0",
    });
    // `item_quality_types` ima stvaran red sa `id = 0` (v. `///` u schema.prisma) —
    // preskakanje nule bi u BigBit-u vidljivu vrednost sakrilo kao praznu.
    prisma.itemQualityType.findUnique.mockResolvedValue({
      code: "NE TREBA",
    });
    prisma.itemRaster.findUnique.mockResolvedValue(null);

    const { data } = await service.findOne(7);

    expect(prisma.itemQualityType.findUnique).toHaveBeenCalledWith({
      where: { id: 0 },
      select: { code: true },
    });
    expect(data.qualityName).toBe("NE TREBA");
    // Dimenzije sa id 0 nema → prazno polje, bez pretpostavke i bez greške.
    expect(data.rasterName).toBeNull();
    // TEKSTUALNI kod `"0"` JESTE sentinel „nije zadato" → tarifa se i ne traži.
    expect(prisma.taxRate.findUnique).not.toHaveBeenCalled();
    expect(data.goodsTaxTotalRate).toBeNull();
  });

  it("findOne(): zbirna PDV stopa = zbir SVIH pet komponenti (BigBit `RobaZbirnaStopa`)", async () => {
    prisma.item.findUnique.mockResolvedValue({
      id: 7,
      groupCode: "SIR",
      subgroupCode: "0",
      originCode: "0",
      goodsTaxRateCode: "3",
      serviceTaxRateCode: "1",
    });
    prisma.taxRate.findUnique.mockImplementation(
      ({ where }: { where: { code: string } }) =>
        Promise.resolve(
          where.code === "3"
            ? {
                code: "3",
                baseRate: 8.5,
                railwayRate: 0.5,
                cityRate: 1,
                warRate: 0,
                specialRate: 0.25,
              }
            : null,
        ),
    );

    const { data } = await service.findOne(7);

    // 8.5 + 0.5 + 1 + 0 + 0.25 — zaokruženo, da se `Float` sabiranje ne vidi na ekranu.
    expect(data.goodsTaxTotalRate).toBe(10.25);
    // Tarife nema u registru (`tax_rates` je na produkciji prazna) → null, NE 0:
    // nula bi značila „stopa je 0%", što je poslovno pogrešna tvrdnja.
    expect(data.serviceTaxTotalRate).toBeNull();
  });
});

// ============================================ Allowlist kolona za sortiranje

describe("ITEM_SORT_COLUMNS — zatvoren spisak kolona za sortiranje", () => {
  it("svaka dozvoljena kolona je STVARNO skalarno polje modela `Item`", () => {
    // Tipfeler u allowlist-u ne bi pao na kompilaciji (spisak je niz stringova) nego
    // tek na produkciji — Prisma bi na nepoznat ključ u `orderBy` bacila grešku, pa
    // bi korisnik klikom na zaglavlje kolone dobio 500. Zato se spisak proverava
    // prema samom modelu, a ne prema našem sećanju kako se kolona zove.
    const item = Prisma.dmmf.datamodel.models.find((m) => m.name === "Item");
    const scalars = new Set(
      item?.fields.filter((f) => f.kind === "scalar").map((f) => f.name) ?? [],
    );
    expect(scalars.size).toBeGreaterThan(0);
    for (const column of ITEM_SORT_COLUMNS)
      expect(scalars.has(column)).toBe(true);
  });

  it("podela na prazno-može / prazno-ne-može je tačno ova (promena šeme mora da se vidi ovde)", () => {
    // Spisak je popisan da bi promena u `schema.prisma` pala OVDE, uz ime kolone, a ne
    // kroz ekran pun praznih redova. `SORT_COLUMN_IS_NULLABLE` u servisu drži isti
    // podatak i TS ga proverava prema Prisma tipovima — ovo je runtime kontrola istog.
    expect(nullableSortColumns().sort()).toEqual(
      [
        "accountingCode",
        "accountingCode2",
        "barCode",
        "box",
        "externalCode",
        "foreignName",
        "fxSalePrice",
        "plu",
        "retailPrice",
        "shelf",
        "thickness",
        "unit",
        "weight",
        "wholesalePrice",
      ].sort(),
    );
    expect(notNullSortColumns().sort()).toEqual(
      [
        "catalogNumber",
        "externalItemId",
        "goodsTaxRateCode",
        "groupCode",
        "name",
        "originCode",
        "subgroupCode",
      ].sort(),
    );
  });

  it("spisak ne sadrži `id` — on je tie-break, ne korisnički izbor", () => {
    expect(ITEM_SORT_COLUMNS).not.toContain("id");
    // 21 vidljiva kolona pregleda (22 BigBit kolone bez PPD checkbox-a).
    expect(new Set(ITEM_SORT_COLUMNS).size).toBe(ITEM_SORT_COLUMNS.length);
  });
});

// ======================================================= Šifarnici (lookups)

describe("ItemsService.lookups() — padajuće liste pregleda i forme", () => {
  let service: ItemsService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [ItemsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(ItemsService);
  });

  it("vraća sve šifarnike jednim pozivom, sa vezama za kaskadu Grupa → Podgrupa → PodPodgrupa", async () => {
    prisma.itemGroup.findMany.mockResolvedValue([
      { code: "SIR", description: "Sirovine" },
    ]);
    prisma.itemSubgroup.findMany.mockResolvedValue([
      { code: "SIR-1", description: "Limovi", parentGroup: "SIR" },
    ]);
    prisma.itemOrigin.findMany.mockResolvedValue([
      { code: "D", description: "Domaće", subgroupCode: "SIR-1" },
    ]);
    prisma.itemQualityType.findMany.mockResolvedValue([
      { id: 3, code: "S235", description: "Konstrukcioni" },
    ]);
    prisma.itemRaster.findMany.mockResolvedValue([
      {
        id: 12,
        name: "1000x2000",
        description: null,
        widthMm: 1000,
        lengthMm: 2000,
      },
    ]);

    const { data } = await service.lookups();

    // Bez `parentGroup`/`subgroupCode` frontend ne može da suzi niže combo-boxove
    // (BigBit `FilterZaGrupu_AfterUpdate`) — kaskada bi ostala mrtvo slovo.
    expect(data.subgroups[0].parentGroup).toBe("SIR");
    expect(data.origins[0].subgroupCode).toBe("SIR-1");
    expect(data.groups).toHaveLength(1);
    expect(data.qualityTypes[0].id).toBe(3);
    expect(data.rasters[0].widthMm).toBe(1000);
  });

  it("tarife nose ZBIRNU stopu, kao combo na BigBit formi", async () => {
    prisma.taxRate.findMany.mockResolvedValue([
      {
        code: "3",
        description: "Opšta",
        baseRate: 20,
        railwayRate: 0,
        cityRate: 0,
        warRate: 0,
        specialRate: 0,
      },
    ]);

    const { data } = await service.lookups();
    expect(data.taxRates).toEqual([
      { code: "3", description: "Opšta", totalRate: 20 },
    ]);
  });

  it("JM / proizvođač / zemlja porekla se čitaju iz ZATVORENOG spiska kolona (nikad iz zahteva)", async () => {
    prisma.$queryRaw.mockImplementation((sql: Prisma.Sql) => {
      if (sql.sql.includes("manufacturer"))
        return Promise.resolve([{ value: "Sigen" }]);
      if (sql.sql.includes("origin_country"))
        return Promise.resolve([{ value: "SRB" }]);
      return Promise.resolve([{ value: "kom" }, { value: "kg" }]);
    });

    const { data } = await service.lookups();

    expect(data.units).toEqual(["kom", "kg"]);
    expect(data.manufacturers).toEqual(["Sigen"]);
    expect(data.countries).toEqual(["SRB"]);

    // Tri upita, tri unapred napisane kolone — nijedan ulaz ne dolazi do teksta upita.
    const queries = prisma.$queryRaw.mock.calls.map(rawSql);
    expect(queries).toHaveLength(3);
    expect(queries.every((q: string) => q.includes("FROM items"))).toBe(true);
    // Bez LIMIT-a bi combo proizvođača umeo da povuče hiljade slobodno kucanih vrednosti.
    expect(queries.every((q: string) => q.includes("LIMIT 500"))).toBe(true);
  });

  it("prazan šifarnik je OČEKIVAN odgovor, ne greška (grupe/podgrupe/poreklo se još ne sinkuju)", async () => {
    const { data } = await service.lookups();
    expect(data.groups).toEqual([]);
    expect(data.subgroups).toEqual([]);
    expect(data.origins).toEqual([]);
  });
});

// ==================================================== Brana upisa (zatečeno stanje)

describe("ItemsService — unos/izmena su DANAS zatvoreni branom", () => {
  let service: ItemsService;
  let prisma: ReturnType<typeof prismaMock>;

  const user: AuthUser = {
    userId: 1,
    email: "test@servoteh.rs",
    role: "admin",
    workerId: null,
  };

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [ItemsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(ItemsService);
  });

  it("create(): 409 pre ijednog upita — `items` ide kroz full refresh koji briše native red", async () => {
    let thrown: unknown;
    try {
      await service.create(
        { catalogNumber: "00042", name: "Lim", groupCode: "SIR" },
        user,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(
      ((thrown as ConflictException).getResponse() as { code: string }).code,
    ).toBe("BIGBIT_OWNED_READ_ONLY");
    // Brana je PRVA: nijedan red se ne čita niti piše.
    expect(prisma.item.findUnique).not.toHaveBeenCalled();
    expect(prisma.item.findMany).not.toHaveBeenCalled();
  });

  it("update(): isti odgovor, takođe bez dodira baze", async () => {
    await expect(
      service.update(NATIVE_ITEM_ID_BASE + 1, { name: "X" }, user),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.item.findUnique).not.toHaveBeenCalled();
  });

  it("poruka je srpska (latinica) i kaže ŠTA DA SE URADI, ne samo „nije dozvoljeno”", () => {
    expect(ITEM_WRITE_BLOCKED_MESSAGE).toContain("BigBit");
    expect(ITEM_WRITE_BLOCKED_MESSAGE).toContain("Pokreni sync");
    // Latinica — nijedan ćirilični znak (BACKEND_RULES: poruke na srpskom, latinica).
    expect(ITEM_WRITE_BLOCKED_MESSAGE).not.toMatch(/[Ѐ-ӿ]/);
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

  it("`/lookups` je DEKLARISAN pre `/:id` — inače ga guta ParseIntPipe sa 400", () => {
    const methods = Object.getOwnPropertyNames(ItemsController.prototype);
    // Nest mapira rute redom kojim su metode deklarisane u klasi; `:id` bi se
    // poklopio i sa „lookups", a `ParseIntPipe` bi vratio 400 na tekst — ekran bi
    // ostao bez ijedne padajuće liste, uz poruku koja ne kaže ništa o uzroku.
    expect(methods.indexOf("lookups")).toBeGreaterThan(-1);
    expect(methods.indexOf("lookups")).toBeLessThan(methods.indexOf("findOne"));
  });

  it("nijedna GET ruta nema svoj (širi) ključ — sve nasleđuju klasni", () => {
    for (const name of ["list", "lookups", "findOne"]) {
      const handler = Object.getOwnPropertyDescriptor(
        ItemsController.prototype,
        name,
      )?.value as object;
      expect(
        Reflect.getMetadata(PERMISSION_KEY_METADATA, handler),
      ).toBeUndefined();
    }
  });

  it("mutacije traže UŽI ključ od čitanja (`masters.write`, ne `directory.read`)", () => {
    // Do 28.07.2026 je ovde stajao `sync.run` — pozajmljen ključ, jer svog nije
    // bilo: „ko sme da pokrene uvoz, sme i da upiše". Sa uvođenjem `masters.write`
    // (isti ključ za artikle i komitente) pozajmica prestaje. Test i dalje pinuje
    // ISTU stvar: mutacija NE SME da prođe na čitalačkom ključu.
    for (const name of ["create", "update"]) {
      const handler = Object.getOwnPropertyDescriptor(
        ItemsController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(PERMISSION_KEY_METADATA, handler)).toBe(
        PERMISSIONS.MASTERS_WRITE,
      );
      expect(Reflect.getMetadata(PERMISSION_KEY_METADATA, handler)).not.toBe(
        PERMISSIONS.DIRECTORY_READ,
      );
    }
  });
});

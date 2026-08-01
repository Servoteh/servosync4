import "reflect-metadata";

/**
 * UNOS/IZMENA ARTIKLA — ponašanje SERVISA kad brana padne.
 *
 * Danas `assertItemWritesAllowed()` odbija svaki upis (v. `items.service.spec.ts`),
 * pa bi cela logika kreiranja ostala neproverena. Ovde se simulira BUDUĆE stanje —
 * dan kad vlasnik otvori unos — da bi se pinovalo šta se tačno tada dešava: dodela
 * id-a iz native opsega, marker porekla, obračun kg/kom, brana kataloškog broja,
 * odbijanje BigBit-origin reda.
 *
 * NEUTRALIŠE SE SAMO PREKIDAČ, ne i pravila. Do integracije 28.07.2026 je ovaj
 * spec mokovao ceo `../sync/table-ownership` (`items` kao aditivna tabela), jer je
 * tada zaštita sync-a BILA prekidač za unos. Sada su to dve stvari:
 * `itemsSurviveSync()` (činjenica — `items` je u rezervisanom opsegu, već `true`)
 * i `ITEMS_WRITE_OPEN` (odluka — `false`). Mok zato pogađa samo `assertItemWrites-
 * Allowed`, a sve ostalo iz modula ostaje STVARNO — `assertItemIsNative`,
 * `NATIVE_ITEM_ID_BASE`, brana kataloškog broja se testiraju u pravom obliku.
 */
jest.mock("./items.write-policy", () => ({
  ...jest.requireActual<typeof import("./items.write-policy")>(
    "./items.write-policy",
  ),
  assertItemWritesAllowed: jest.fn(), // vlasnik otvorio unos
}));

import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ItemsService } from "./items.service";
import { NATIVE_ITEM_ID_BASE } from "./items.write-policy";
import type { CreateItemDto } from "./dto/upsert-item.dto";
import type { AuthUser } from "../auth/jwt.strategy";

const USER: AuthUser = {
  userId: 7,
  email: "nenad@servoteh.rs",
  role: "admin",
  workerId: null,
};

function prismaMock() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ next_id: NATIVE_ITEM_ID_BASE + 3 }]),
    item: {
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: args.data.id as number }),
      ),
    },
  };

  const prisma = {
    __tx: tx,
    item: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(
        (args: { where: { id: number }; data: Record<string, unknown> }) =>
          Promise.resolve({ id: args.where.id }),
      ),
    },
    // Prazni šifarnici = zatečeno stanje (nema syncera za R_Grupa/R_Podgrupa/R_Poreklo).
    itemGroup: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    itemSubgroup: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    itemOrigin: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    taxRate: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    customer: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (t: typeof tx) => Promise<unknown>)(tx),
    ),
  };
  return prisma;
}

function validDto(over: Partial<CreateItemDto> = {}): CreateItemDto {
  return {
    catalogNumber: "00042",
    name: "Lim 3mm S235",
    groupCode: "SIR",
    ...over,
  };
}

describe("ItemsService.create — kad `items` uđe u zaštićeni skup", () => {
  let service: ItemsService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [ItemsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(ItemsService);
    prisma.item.findUnique.mockResolvedValue({
      id: NATIVE_ITEM_ID_BASE + 3,
      catalogNumber: "00042",
      name: "Lim 3mm S235",
      groupCode: "SIR",
      subgroupCode: "0",
      originCode: "0",
      manualMarkupPercent: new Prisma.Decimal(0),
      thickness: 3,
    });
  });

  it("id se dodeljuje iz NATIVE opsega, pod advisory bravom — nikad iz BigBit prostora", async () => {
    await service.create(validDto(), USER);

    // Brava mora biti UZETA PRE računanja MAX(id) — inače dve paralelne
    // transakcije dobiju isti id (i druga pukne na PK).
    expect(prisma.__tx.$executeRaw).toHaveBeenCalled();
    const created = prisma.__tx.item.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.id).toBe(NATIVE_ITEM_ID_BASE + 3);
    expect(created.data.id as number).toBeGreaterThanOrEqual(
      NATIVE_ITEM_ID_BASE,
    );
  });

  it("native red dobija marker porekla `externalItemId = 0` i potpis korisnika", async () => {
    await service.create(validDto(), USER);
    const created = prisma.__tx.item.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.externalItemId).toBe(0);
    expect(created.data.signature).toBe("nenad@servoteh.rs");
    expect(created.data.createdAt).toBeInstanceOf(Date);
  });

  it("prazna tabela native opsega → prvi id je tačno granica opsega", async () => {
    prisma.__tx.$queryRaw.mockResolvedValue([{ next_id: NATIVE_ITEM_ID_BASE }]);
    await service.create(validDto(), USER);
    const created = prisma.__tx.item.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.id).toBe(NATIVE_ITEM_ID_BASE);
  });

  it("`bigint` iz baze se ne prosleđuje dalje kao BigInt", async () => {
    prisma.__tx.$queryRaw.mockResolvedValue([
      { next_id: BigInt(NATIVE_ITEM_ID_BASE + 9) },
    ]);
    await service.create(validDto(), USER);
    const created = prisma.__tx.item.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.id).toBe(NATIVE_ITEM_ID_BASE + 9);
    expect(typeof created.data.id).toBe("number");
  });

  it("zauzet kataloški broj → 409 sa srpskom porukom, PRE nego što baza pukne", async () => {
    prisma.item.findFirst.mockResolvedValue({ id: 12, name: "Stari lim" });

    await expect(service.create(validDto(), USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.__tx.item.create).not.toHaveBeenCalled();

    const where = prisma.item.findFirst.mock.calls[0][0] as {
      where: { catalogNumber: unknown };
    };
    // Brana u bazi poredi `lower(btrim(...))` — provera mora biti case-insensitive.
    expect(where.where.catalogNumber).toEqual({
      equals: "00042",
      mode: "insensitive",
    });
  });

  it("brana `guard_catalog_unique` iz baze → srpska poruka, ne sirov tekst trigera", async () => {
    prisma.__tx.item.create.mockRejectedValue(
      new Error(
        'CATALOG_NUMBER_DUPLICATE: kataloški broj "00042" već postoji (artikal id=12).',
      ),
    );
    let thrown: unknown;
    try {
      await service.create(validDto(), USER);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    const body = (thrown as ConflictException).getResponse() as {
      code: string;
      message: string;
    };
    expect(body.code).toBe("CATALOG_NUMBER_DUPLICATE");
    expect(body.message).toContain("mora biti jedinstven");
    expect(body.message).not.toContain("CATALOG_NUMBER_DUPLICATE:");
  });

  it("P2002 (23505) iz iste brane se prevodi isto", async () => {
    prisma.__tx.item.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6",
      }),
    );
    await expect(service.create(validDto(), USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("dimenzije table → kg po komadu u `box` (BigBit §4.10, gustina 7850)", async () => {
    await service.create(
      validDto({ thickness: 3, rasterWidthMm: 1000, rasterLengthMm: 2000 }),
      USER,
    );
    const created = prisma.__tx.item.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.box).toBe(47.1);
    // Prelazne dimenzije se NE upisuju (nema kolona za njih).
    expect(created.data.rasterWidthMm).toBeUndefined();
    expect(created.data.rasterLengthMm).toBeUndefined();
  });

  it("prazan šifarnik grupa NE blokira unos (nema syncera za R_Grupa)", async () => {
    await expect(
      service.create(validDto({ groupCode: "BILO-STA" }), USER),
    ).resolves.toBeDefined();
    expect(prisma.itemGroup.findUnique).not.toHaveBeenCalled();
  });

  it("popunjen šifarnik grupa se poštuje TVRDO → nepostojeća grupa je 400", async () => {
    prisma.itemGroup.count.mockResolvedValue(120);
    prisma.itemGroup.findUnique.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await service.create(validDto({ groupCode: "NEMA" }), USER);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(
      ((thrown as BadRequestException).getResponse() as { message: string[] })
        .message[0],
    ).toContain("ne postoji u šifarniku grupa");
  });

  it("kaskada Grupa → Podgrupa se proverava kad šifarnik ume da je potvrdi", async () => {
    prisma.itemGroup.count.mockResolvedValue(120);
    prisma.itemGroup.findUnique.mockResolvedValue({ code: "SIR" });
    prisma.itemSubgroup.count.mockResolvedValue(300);
    prisma.itemSubgroup.findUnique.mockResolvedValue({
      code: "ALU-1",
      parentGroup: "ALU",
    });

    let thrown: unknown;
    try {
      await service.create(
        validDto({ groupCode: "SIR", subgroupCode: "ALU-1" }),
        USER,
      );
    } catch (e) {
      thrown = e;
    }
    const msg = (
      (thrown as BadRequestException).getResponse() as { message: string[] }
    ).message[0];
    expect(msg).toContain("pripada grupi");
  });

  it('"0" je sentinel „nije zadato” — ne traži se u šifarniku', async () => {
    prisma.itemSubgroup.count.mockResolvedValue(300);
    await service.create(validDto({ subgroupCode: "0" }), USER);
    expect(prisma.itemSubgroup.findUnique).not.toHaveBeenCalled();
  });

  it("nepostojeći dobavljač → 400 (meki FK na komitente)", async () => {
    prisma.customer.count.mockResolvedValue(5000);
    prisma.customer.findUnique.mockResolvedValue(null);

    await expect(
      service.create(validDto({ supplierId: 12345 }), USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("ItemsService.update — kad `items` uđe u zaštićeni skup", () => {
  let service: ItemsService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [ItemsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(ItemsService);
  });

  const nativeRow = {
    id: NATIVE_ITEM_ID_BASE + 1,
    catalogNumber: "00042",
    name: "Lim 3mm",
    groupCode: "SIR",
    subgroupCode: "0",
    originCode: "0",
    manualMarkupPercent: new Prisma.Decimal(0),
    thickness: 3,
  };

  it("BigBit-origin artikal se NE menja ovde → 409 sa uputstvom za BigBit", async () => {
    prisma.item.findUnique.mockResolvedValue({ ...nativeRow, id: 500 });

    let thrown: unknown;
    try {
      await service.update(500, { name: "Novi naziv" }, USER);
    } catch (e) {
      thrown = e;
    }
    const body = (thrown as ConflictException).getResponse() as {
      code: string;
      message: string;
    };
    expect(body.code).toBe("BIGBIT_OWNED_READ_ONLY");
    expect(body.message).toContain("BigBit");
    expect(prisma.item.update).not.toHaveBeenCalled();
  });

  it("nepostojeći artikal je 404, ne 409", async () => {
    prisma.item.findUnique.mockResolvedValue(null);
    await expect(
      service.update(NATIVE_ITEM_ID_BASE + 1, { name: "X" }, USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("native artikal se menja; šalju se SAMO poslata polja + potpis", async () => {
    prisma.item.findUnique.mockResolvedValue(nativeRow);

    await service.update(nativeRow.id, { name: "Lim 4mm", active: false }, USER);

    const args = prisma.item.update.mock.calls[0][0] as {
      where: { id: number };
      data: Record<string, unknown>;
    };
    expect(args.where.id).toBe(nativeRow.id);
    // Uz poslata polja idu i potpis i TRAG IZMENE — kolone `updated_at`/`updated_by`
    // iz migracije 20260728170000. Ranije su stajale prazne, pa je pitanje „ko je
    // ovo promenio" ostajalo bez odgovora iako kolone postoje.
    expect(args.data).toEqual({
      name: "Lim 4mm",
      active: false,
      signature: "nenad@servoteh.rs",
      updatedAt: expect.any(Date),
      updatedBy: "nenad@servoteh.rs",
    });
  });

  it("izmena dimenzija koristi zatečenu debljinu iz baze", async () => {
    prisma.item.findUnique.mockResolvedValue(nativeRow);

    await service.update(
      nativeRow.id,
      { rasterWidthMm: 1250, rasterLengthMm: 2500 },
      USER,
    );

    const args = prisma.item.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // 3 * 1250 * 2500 * 7850 / 1e9 = 73,59375 → 4 decimale
    expect(args.data.box).toBe(73.5938);
  });

  it("izmena kataloškog broja proverava zauzeće ISKLJUČUJUĆI sam red", async () => {
    prisma.item.findUnique.mockResolvedValue(nativeRow);

    await service.update(nativeRow.id, { catalogNumber: "00099" }, USER);

    const where = prisma.item.findFirst.mock.calls[0][0] as {
      where: { id?: unknown };
    };
    expect(where.where.id).toEqual({ not: nativeRow.id });
  });

  it("prazno telo → 400, bez ijednog upita ka bazi za izmenu", async () => {
    prisma.item.findUnique.mockResolvedValue(nativeRow);
    await expect(service.update(nativeRow.id, {}, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.item.update).not.toHaveBeenCalled();
  });
});

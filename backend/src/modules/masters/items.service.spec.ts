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
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
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

  it("list(): pretraga `q` gađa naziv/kataloški broj/barkod (case-insensitive), sort po kat. broju", async () => {
    await service.list({ q: " ku-12 " });

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
    await service.list({ groupCode: "SIR", active: "false" });

    const [args] = prisma.item.findMany.mock.calls[0] as [
      { where: Prisma.ItemWhereInput },
    ];
    expect(args.where.groupCode).toBe("SIR");
    expect(args.where.active).toBe(false);
    expect(args.where.OR).toBeUndefined();
  });

  it("list(): `active` koji nije true/false je 400, ne tiho ignorisanje", async () => {
    await expect(service.list({ active: "da" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
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

  it("list(): kad šifarnik postoji, naziv grupe se popunjava", async () => {
    prisma.item.findMany.mockResolvedValue([
      { id: 1, catalogNumber: "A-1", groupCode: "SIR", name: "Lim" },
    ]);
    prisma.item.count.mockResolvedValue(1);
    prisma.itemGroup.findMany.mockResolvedValue([
      { code: "SIR", description: "Sirovine" },
    ]);

    const res = await service.list({});
    expect(res.data[0].group).toEqual({ code: "SIR", description: "Sirovine" });
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

  it("mutacije traže UŽI ključ od čitanja (`sync.run`, ne `directory.read`)", () => {
    for (const name of ["create", "update"]) {
      const handler = Object.getOwnPropertyDescriptor(
        ItemsController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(PERMISSION_KEY_METADATA, handler)).toBe(
        PERMISSIONS.SYNC_RUN,
      );
    }
  });
});

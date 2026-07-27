import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MasterCustomersService } from "./customers.service";
import { MasterCustomersController } from "./customers.controller";
import { DirectoryController } from "../directory/directory.controller";
import { PERMISSION_KEY_METADATA } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";

/** Mock PrismaService — samo modeli koje `MasterCustomersService` čita. */
function prismaMock() {
  return {
    customer: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    salesperson: { findMany: jest.fn().mockResolvedValue([]) },
    codeType: { findMany: jest.fn().mockResolvedValue([]) },
    paymentAccount: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

describe("MasterCustomersService (matični podaci — Komitenti)", () => {
  let service: MasterCustomersService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        MasterCustomersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(MasterCustomersService);
  });

  it("list(): pretraga `q` gađa naziv/PIB/mesto, filter codeTypeCode je tačno poklapanje", async () => {
    await service.list({ q: " beograd ", codeTypeCode: "KUP" });

    const [args] = prisma.customer.findMany.mock.calls[0] as [
      { where: Prisma.CustomerWhereInput; orderBy: unknown; take: number },
    ];
    expect(args.where.OR).toEqual([
      { name: { contains: "beograd", mode: "insensitive" } },
      { taxId: { contains: "beograd", mode: "insensitive" } },
      { city: { contains: "beograd", mode: "insensitive" } },
    ]);
    expect(args.where.codeTypeCode).toBe("KUP");
    expect(args.orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
    expect(args.take).toBe(50);
    expect(prisma.customer.count).toHaveBeenCalledWith({ where: args.where });
  });

  it("list(): prodavac i vrsta šifre se razrešavaju batch-om; orphan FK → null, ne 500", async () => {
    prisma.customer.findMany.mockResolvedValue([
      { id: 1, name: "A", salespersonId: 5, codeTypeCode: "KUPDOB" },
      { id: 2, name: "B", salespersonId: 0, codeTypeCode: "KUPDOB" },
      { id: 3, name: "C", salespersonId: 99, codeTypeCode: "XX" },
    ]);
    prisma.customer.count.mockResolvedValue(3);
    // `salesperson_id = 0` je legacy „nije zadat"; 99 je orphan (nema reda).
    prisma.salesperson.findMany.mockResolvedValue([
      { id: 5, name: "Petrović", firstName: "Ana" },
    ]);
    prisma.codeType.findMany.mockResolvedValue([
      { code: "KUPDOB", description: "Kupac i dobavljač" },
    ]);

    const res = await service.list({});

    expect(prisma.salesperson.findMany).toHaveBeenCalledWith({
      where: { id: { in: [5, 99] } },
      select: { id: true, name: true, firstName: true },
    });
    expect(res.data.map((r) => r.salesperson)).toEqual([
      { id: 5, name: "Petrović", firstName: "Ana" },
      null,
      null,
    ]);
    expect(res.data.map((r) => r.codeType)).toEqual([
      { code: "KUPDOB", description: "Kupac i dobavljač" },
      { code: "KUPDOB", description: "Kupac i dobavljač" },
      { code: "XX", description: null },
    ]);
  });

  it("findOne(): pun slog, Decimal kao string, uplatni račun razrešen", async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 42,
      name: "Servoteh",
      taxId: "100123456",
      salespersonId: 5,
      codeTypeCode: "KUPDOB",
      paymentAccountId: 3,
      creditLimit: new Prisma.Decimal("250000.0000"),
      manualMarkupPercent: new Prisma.Decimal("0.0000"),
      checkDebt: true,
    });
    prisma.salesperson.findMany.mockResolvedValue([
      { id: 5, name: "Petrović", firstName: "Ana" },
    ]);
    prisma.codeType.findMany.mockResolvedValue([
      { code: "KUPDOB", description: "Kupac i dobavljač" },
    ]);
    prisma.paymentAccount.findUnique.mockResolvedValue({
      id: 3,
      accountNumber: "160-1234-56",
      bankName: "Banca Intesa",
      bankCode: "160",
      countryCode: "RS",
    });

    const { data } = await service.findOne(42);

    expect(data.creditLimit).toBe("250000");
    expect(typeof data.creditLimit).toBe("string");
    expect(data.manualMarkupPercent).toBe("0");
    expect(data.salesperson).toEqual({
      id: 5,
      name: "Petrović",
      firstName: "Ana",
    });
    expect(data.codeType).toEqual({
      code: "KUPDOB",
      description: "Kupac i dobavljač",
    });
    expect(data.paymentAccount?.accountNumber).toBe("160-1234-56");
    expect(data.checkDebt).toBe(true);
  });

  it("findOne(): paymentAccountId = 0 (legacy „nije zadat“) ne ide u bazu, vraća null", async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 42,
      name: "Servoteh",
      salespersonId: 0,
      codeTypeCode: null,
      paymentAccountId: 0,
      creditLimit: null,
      manualMarkupPercent: null,
    });

    const { data } = await service.findOne(42);

    expect(prisma.paymentAccount.findUnique).not.toHaveBeenCalled();
    expect(data.paymentAccount).toBeNull();
    expect(data.codeType).toBeNull();
    expect(data.creditLimit).toBeNull();
  });

  it("findOne(): nepostojeći komitent je 404, ne 500", async () => {
    prisma.customer.findUnique.mockResolvedValue(null);
    await expect(service.findOne(999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ================================================================ Guard

describe("MasterCustomersController — permisija", () => {
  it("klasa je iza `directory.read` — istog ključa kao DirectoryController", () => {
    expect(
      Reflect.getMetadata(PERMISSION_KEY_METADATA, MasterCustomersController),
    ).toBe(PERMISSIONS.DIRECTORY_READ);
    expect(
      Reflect.getMetadata(PERMISSION_KEY_METADATA, MasterCustomersController),
    ).toBe(Reflect.getMetadata(PERMISSION_KEY_METADATA, DirectoryController));
  });

  it("nijedna GET ruta nema svoj (širi) ključ — sve nasleđuju klasni", () => {
    for (const name of ["list", "findOne"]) {
      const handler = Object.getOwnPropertyDescriptor(
        MasterCustomersController.prototype,
        name,
      )?.value as object;
      expect(
        Reflect.getMetadata(PERMISSION_KEY_METADATA, handler),
      ).toBeUndefined();
    }
  });
});

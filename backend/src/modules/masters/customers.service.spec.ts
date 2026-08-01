import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  CUSTOMERS_WRITE_OPEN,
  MasterCustomersService,
  assertCustomerWriteAllowed,
} from "./customers.service";
import { MasterCustomersController } from "./customers.controller";
import { DirectoryController } from "../directory/directory.controller";
import { PERMISSION_KEY_METADATA } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";

/** Mock PrismaService — modeli koje `MasterCustomersService` čita i (uslovno) piše. */
function prismaMock() {
  const client = {
    customer: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 1, driverId: null }),
      update: jest.fn().mockResolvedValue({ id: 1 }),
    },
    salesperson: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    codeType: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ code: "KUPDOB" }),
    },
    paymentAccount: { findUnique: jest.fn().mockResolvedValue(null) },
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  // Podržava oba oblika: niz obećanja (čitanja) i callback (upis u transakciji).
  // Veže se POSLE literala: callback vraća `client`, pa bi unutar literala tip zavisio
  // od samog sebe (TS7022/TS7024 — implicitni `any` u sopstvenom inicijalizatoru).
  client.$transaction.mockImplementation(
    (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof arg === "function" ? arg(client) : Promise.all(arg),
  );
  return client;
}

/** Telo koje prolazi SVE provere — koristi se da se dokaže da brana puca poslednja. */
const VALIDAN_UNOS = { name: "Ino Kupac", taxId: "100002887" };

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

// ======================================================= Unos / izmena (upis)

describe("Brana upisa — `customers` je BigBit-ov (odluka 26.07.2026)", () => {
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

  it("prekidač stoji na `false` — nijedan upis nije otvoren", () => {
    expect(CUSTOMERS_WRITE_OPEN).toBe(false);
  });

  it("`assertCustomerWriteAllowed()` baca 409 `BIGBIT_OWNED_READ_ONLY` sa uputstvom", () => {
    try {
      assertCustomerWriteAllowed();
      fail("očekivan izuzetak");
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      const body = (e as ConflictException).getResponse() as {
        code: string;
        message: string;
      };
      expect(body.code).toBe("BIGBIT_OWNED_READ_ONLY");
      // Tekst dolazi iz `directory/bigbit-owned.ts` — jedan izvor za backend i ekrane.
      expect(body.message).toContain("BigBit");
      expect(body.message).toContain("uvoz");
    }
  });

  it("create(): ispravno telo ne piše NIŠTA — 409 i nula poziva ka bazi za upis", async () => {
    await expect(service.create(VALIDAN_UNOS)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.customer.create).not.toHaveBeenCalled();
    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("update(): postojeći komitent i ispravna izmena → 409, bez `update` upita", async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 42,
      taxId: "100002887",
      skipTaxIdValidation: false,
      codeTypeCode: "KUPDOB",
      driverId: null,
    });

    await expect(service.update(42, { city: "Čačak" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });
});

describe("Provere se izvršavaju PRE brane (klijent dobija grešku o svom podatku)", () => {
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

  it("create(): bez naziva → 400, ne 409", async () => {
    await expect(service.create({ taxId: "100002887" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("create(): pogrešan PIB → 422 `PIB_NIJE_DOBAR` (BigBit polu-tvrda brana)", async () => {
    try {
      await service.create({ name: "K", taxId: "123456789" });
      fail("očekivan izuzetak");
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect(
        ((e as UnprocessableEntityException).getResponse() as { code: string })
          .code,
      ).toBe("PIB_NIJE_DOBAR");
    }
  });

  it("create(): potvrđen loš PIB prolazi validaciju i stiže do brane (409)", async () => {
    await expect(
      service.create({
        name: "K",
        taxId: "123456789",
        confirmInvalidTaxId: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("create(): prazan PIB uz `skipTaxIdValidation` prolazi — strani kupac nema PIB", async () => {
    await expect(
      service.create({ name: "Ino GmbH", skipTaxIdValidation: true }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("create(): nepostojeća vrsta šifre → 422 sa IMENOVANOM vrednošću", async () => {
    prisma.codeType.findUnique.mockResolvedValue(null);
    try {
      await service.create({ ...VALIDAN_UNOS, codeTypeCode: "NEMA" });
      fail("očekivan izuzetak");
    } catch (e) {
      const body = (e as UnprocessableEntityException).getResponse() as {
        code: string;
        message: string[];
      };
      expect(body.code).toBe("NEPOSTOJECA_REFERENCA");
      expect(body.message.join(" ")).toContain("NEMA");
    }
  });

  it("create(): nepostojeći prodavac → 422; `0` (legacy „nije zadat“) se ne pita", async () => {
    prisma.salesperson.findUnique.mockResolvedValue(null);
    await expect(
      service.create({ ...VALIDAN_UNOS, salespersonId: 99 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // `0` → `null` (FK `fk_customers_salespeople` je pravi) → nema upita ni greške.
    prisma.salesperson.findUnique.mockClear();
    await expect(
      service.create({ ...VALIDAN_UNOS, salespersonId: 0 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.salesperson.findUnique).not.toHaveBeenCalled();
  });

  it("create(): `paymentMethod` je zaključano polje (BigBit grupa KomAvPlacanje) → 403", async () => {
    try {
      await service.create({ ...VALIDAN_UNOS, paymentMethod: "Avansno" });
      fail("očekivan izuzetak");
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenException);
      const body = (e as ForbiddenException).getResponse() as {
        code: string;
        field: string;
      };
      expect(body.code).toBe("POLJE_ZAKLJUCANO");
      expect(body.field).toBe("paymentMethod");
    }
  });

  it("create(): dupli PIB se TRAŽI u bazi (upozorenje, ne brana — BigBit ga tolerira)", async () => {
    await expect(service.create(VALIDAN_UNOS)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taxId: "100002887" },
        select: { id: true, name: true, city: true },
      }),
    );
  });

  it("update(): nepostojeći komitent je 404, ne 409", async () => {
    prisma.customer.findUnique.mockResolvedValue(null);
    await expect(service.update(999, { city: "Niš" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("update(): prazno telo je 400 (nema šta da se promeni)", async () => {
    await expect(service.update(42, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
  });

  it("update(): PIB se ocenjuje nad SPOJENIM stanjem — gašenje bypass-a otkriva loš PIB", async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 42,
      taxId: "123456789", // upisan ranije uz NeProveravajPIB
      skipTaxIdValidation: true,
      codeTypeCode: "KUPDOB",
      driverId: null,
    });

    try {
      await service.update(42, { skipTaxIdValidation: false });
      fail("očekivan izuzetak");
    } catch (e) {
      expect(
        ((e as UnprocessableEntityException).getResponse() as { code: string })
          .code,
      ).toBe("PIB_NIJE_DOBAR");
    }
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

  it("mutacije imaju SVOJ ključ `masters.write` — ne nasleđuju čitalački", () => {
    // Ovaj test je do 28.07.2026 tvrdio suprotno („ni create/update nemaju svoj
    // ključ") i sam je najavio sopstvenu izmenu: dok je stajala brana, POST/PATCH
    // nisu pisali nego objašnjavali, pa im je čitalački ključ bio dovoljan. Sada
    // ključ postoji, pa mutacija mora biti iza njega — inače bi na dan otvaranja
    // upisa svako sa `directory.read` (npr. kontrolor) mogao da menja komitente.
    for (const name of ["create", "update"]) {
      const handler = Object.getOwnPropertyDescriptor(
        MasterCustomersController.prototype,
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

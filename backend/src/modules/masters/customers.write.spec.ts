import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { MasterCustomersService } from "./customers.service";

/**
 * ŠTA SE DESI KAD SE ODLUKA OD 26.07.2026. POVUČE.
 * =========================================================================
 * `create`/`update` u produkciji nikad ne stignu do upisa — `assertCustomerWriteAllowed()`
 * baca 409 (v. `customers.service.spec.ts`). Da upis ipak ne bi bio nepokriven kod, ovde
 * se ISKLJUČIVO za test neutrališe `rejectCustomerWrite` iz `directory/bigbit-owned.ts`,
 * pa se proverava ono što se stvarno upisuje: placeholder PIB-a, automatika vozača,
 * audit kolone i legacy `0` sentinel.
 *
 * Ovaj fajl je ujedno i regresija za dan otvaranja: ako se ponašanje upisa promeni,
 * test pukne pre nego što se prekidač uopšte prebaci.
 */
jest.mock("../directory/bigbit-owned", () => ({
  ...jest.requireActual("../directory/bigbit-owned"),
  rejectCustomerWrite: jest.fn(), // no-op: „vlasnik je povukao odluku"
}));

/** Zaokružen slog koji `findOne()` vraća posle upisa. */
function customerRow(over: Record<string, unknown> = {}) {
  return {
    id: 7001,
    name: "Ino Kupac",
    city: null,
    taxId: "XX_7001",
    codeTypeCode: "KUPDOB",
    salespersonId: null,
    paymentAccountId: 0,
    driverId: null,
    creditLimit: null,
    manualMarkupPercent: null,
    ...over,
  };
}

function prismaMock() {
  const client = {
    customer: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(customerRow()),
      create: jest.fn().mockResolvedValue({ id: 7001, driverId: null }),
      update: jest.fn().mockResolvedValue({ id: 7001 }),
    },
    salesperson: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ id: 5 }),
    },
    codeType: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ code: "KUPDOB" }),
    },
    paymentAccount: { findUnique: jest.fn().mockResolvedValue(null) },
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  // Veže se POSLE literala — callback vraća `client`, pa bi unutar literala tip
  // zavisio od samog sebe (TS7022/TS7024).
  client.$transaction.mockImplementation(
    (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof arg === "function" ? arg(client) : Promise.all(arg),
  );
  return client;
}

const USER = { userId: 3, email: "nenad.jarakovic@servoteh.com", role: "admin", workerId: null };

describe("Upis komitenta kad je brana povučena", () => {
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

  it("poravnava sekvencu PRE insert-a (sync upisuje eksplicitne id-jeve)", async () => {
    await service.create({ name: "Servoteh", taxId: "100002887" }, USER);

    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql] = prisma.$executeRawUnsafe.mock.calls[0] as [string];
    expect(sql).toContain("setval");
    expect(sql).toContain("customers");
  });

  it("prazan PIB → privremeno \"\" pa `XX_<Sifra>`, tačno kao BigBit transfer (§5.1)", async () => {
    await service.create({ name: "Ino GmbH", skipTaxIdValidation: true }, USER);

    const [createArgs] = prisma.customer.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data.taxId).toBe("");

    const [updateArgs] = prisma.customer.update.mock.calls[0] as [
      { where: { id: number }; data: Record<string, unknown> },
    ];
    expect(updateArgs.where.id).toBe(7001);
    expect(updateArgs.data.taxId).toBe("XX_7001");
  });

  it("unet PIB se ne dira i nema naknadnog update-a", async () => {
    await service.create({ name: "Servoteh", taxId: "100002887" }, USER);

    const [createArgs] = prisma.customer.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data.taxId).toBe("100002887");
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it("vrsta šifre „Voza*“ bez vozača → `driverId` = sopstvena šifra (§4 :212-219)", async () => {
    prisma.codeType.findUnique.mockResolvedValue({ code: "Vozac" });

    await service.create(
      { name: "Pera Vozač", taxId: "100002887", codeTypeCode: "Vozac" },
      USER,
    );

    const [updateArgs] = prisma.customer.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(updateArgs.data.driverId).toBe(7001);
  });

  it("audit kolone: `PrviUnos`/`PoslednjaIzmena` + korisnik skraćen na VarChar(20)", async () => {
    await service.create({ name: "Servoteh", taxId: "100002887" }, USER);

    const [createArgs] = prisma.customer.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data.createdAt).toBeInstanceOf(Date);
    expect(createArgs.data.updatedAt).toBeInstanceOf(Date);
    expect(createArgs.data.createdBy).toBe("nenad.jarakovic");
    expect((createArgs.data.createdBy as string).length).toBeLessThanOrEqual(20);
    expect(createArgs.data.updatedBy).toBe("nenad.jarakovic");
  });

  it("legacy sentinel `0` ne ide u bazu — FK kolone se upisuju kao NULL", async () => {
    await service.create(
      { name: "Servoteh", taxId: "100002887", salespersonId: 0, driverId: 0 },
      USER,
    );

    const [createArgs] = prisma.customer.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data.salespersonId).toBeNull();
    expect(createArgs.data.driverId).toBeNull();
  });

  it("i kad polja uopšte nema, `salespersonId`/`driverId` idu kao NULL (DEFAULT 0 bi pao na FK)", async () => {
    await service.create({ name: "Servoteh", taxId: "100002887" }, USER);

    const [createArgs] = prisma.customer.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data.salespersonId).toBeNull();
    expect(createArgs.data.driverId).toBeNull();
  });

  it("odgovor je { data, meta } i nosi upozorenje koje IMENUJE komitenta sa istim PIB-om", async () => {
    prisma.customer.findMany.mockResolvedValue([
      { id: 4821, name: "Servoteh d.o.o.", city: "Čačak" },
    ]);

    const res = await service.create(
      { name: "Servoteh 2", taxId: "100002887" },
      USER,
    );

    expect(res.data).toBeDefined();
    expect(res.meta.upozorenja).toHaveLength(1);
    expect(res.meta.upozorenja[0]).toContain("4821");
    expect(res.meta.upozorenja[0]).toContain("Servoteh d.o.o.");
  });

  it("izmena: menja se samo poslato + `PoslednjaIzmena`/`PoslednjaIzmenaUser`", async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce({
        id: 7001,
        taxId: "100002887",
        skipTaxIdValidation: false,
        codeTypeCode: "KUPDOB",
        driverId: null,
      })
      .mockResolvedValueOnce(customerRow({ taxId: "100002887" }));

    await service.update(7001, { city: "Čačak" }, USER);

    const [args] = prisma.customer.update.mock.calls[0] as [
      { where: { id: number }; data: Record<string, unknown> },
    ];
    expect(args.where.id).toBe(7001);
    expect(args.data.city).toBe("Čačak");
    expect(args.data.updatedAt).toBeInstanceOf(Date);
    expect(args.data.updatedBy).toBe("nenad.jarakovic");
    expect("createdBy" in args.data).toBe(false);
    expect("createdAt" in args.data).toBe(false);
  });

  it("izmena: brisanje PIB-a upisuje `XX_<Sifra>`, ne prazan string", async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce({
        id: 7001,
        taxId: "100002887",
        skipTaxIdValidation: true,
        codeTypeCode: "KUPDOB",
        driverId: null,
      })
      .mockResolvedValueOnce(customerRow());

    await service.update(7001, { taxId: "" }, USER);

    const [args] = prisma.customer.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(args.data.taxId).toBe("XX_7001");
  });
});

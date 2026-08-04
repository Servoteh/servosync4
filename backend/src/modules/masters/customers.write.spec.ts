import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  CUSTOMER_SOURCE_BIGBIT,
  CUSTOMER_SOURCE_NATIVE,
  MasterCustomersService,
  NATIVE_CUSTOMER_ID_BASE,
  assertCustomerIsNative,
  bigBitSifraOf,
  isNativeCustomer,
} from "./customers.service";
// Artikli su isti problem rešili istom granicom — jednakost se pinuje, da se dva
// matična podatka ne raziđu na dva „rezervisana opsega".
import { NATIVE_ITEM_ID_BASE } from "./items.write-policy";

/**
 * ŠTA SE DESI KAD SE ODLUKA OD 26.07.2026. POVUČE.
 * =========================================================================
 * `create`/`update` u produkciji nikad ne stignu do upisa — `assertCustomerWriteAllowed()`
 * baca 409 (v. `customers.service.spec.ts`). Da upis ipak ne bi bio nepokriven kod, ovde
 * se ISKLJUČIVO za test neutrališe `rejectCustomerWrite` iz `directory/bigbit-owned.ts`,
 * pa se proverava ono što se stvarno upisuje: šifra iz native opsega, marker porekla,
 * placeholder PIB-a, automatika vozača, audit kolone i legacy `0` sentinel.
 *
 * DRUGA POLOVINA FAJLA je brana koja ostaje i posle otvaranja: BigBit-origin komitent
 * se NE MENJA ovde ni tada, a nov komitent ne sme da dupla PIB koji BigBit već vodi.
 * Te dve provere su jedini razlog zbog kojeg se prekidač sme prebaciti bez novog
 * otkrića — zato su testovi ovde, uz upis, a ne uz čitanje.
 */
jest.mock("../directory/bigbit-owned", () => ({
  ...jest.requireActual("../directory/bigbit-owned"),
  rejectCustomerWrite: jest.fn(), // no-op: „vlasnik je povukao odluku"
}));

/** Šifra koju `nextNativeCustomerId` vrati u testu — prva u rezervisanom opsegu. */
const NATIVE_ID = NATIVE_CUSTOMER_ID_BASE + 1; // 900.000.001

/** Zaokružen slog koji `findOne()` vraća posle upisa (4.0-native komitent). */
function customerRow(over: Record<string, unknown> = {}) {
  return {
    id: NATIVE_ID,
    name: "Ino Kupac",
    city: null,
    taxId: `XX_${NATIVE_ID}`,
    codeTypeCode: "KUPDOB",
    salespersonId: null,
    paymentAccountId: 0,
    driverId: null,
    creditLimit: null,
    manualMarkupPercent: null,
    source: CUSTOMER_SOURCE_NATIVE,
    bbSifra: null,
    ...over,
  };
}

/** Slog koji `update()` učita pre izmene (`select` iz servisa). */
function currentRow(over: Record<string, unknown> = {}) {
  return {
    id: NATIVE_ID,
    name: "Ino Kupac",
    source: CUSTOMER_SOURCE_NATIVE,
    bbSifra: null,
    taxId: "100002887",
    skipTaxIdValidation: false,
    codeTypeCode: "KUPDOB",
    driverId: null,
    ...over,
  };
}

function prismaMock() {
  const client = {
    customer: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(customerRow()),
      create: jest.fn().mockResolvedValue({ id: NATIVE_ID, driverId: null }),
      update: jest.fn().mockResolvedValue({ id: NATIVE_ID }),
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
    // `pg_advisory_xact_lock` + `MAX(id)+1` iz native opsega (tagged template).
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ next_id: NATIVE_ID }]),
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

/** Argumenti poziva `customer.findMany` koji je pitao za BigBit blizance. */
function twinQuery(prisma: ReturnType<typeof prismaMock>) {
  return prisma.customer.findMany.mock.calls
    .map(([args]) => args as { where?: { source?: string } })
    .find((args) => args?.where?.source === CUSTOMER_SOURCE_BIGBIT);
}

/** Telo 409 odgovora (`code` + `message`). */
function body(e: unknown) {
  return (e as ConflictException).getResponse() as {
    code: string;
    message: string;
  };
}

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

  it("šifra dolazi iz REZERVISANOG opsega, pod advisory lock-om — nikad iz BigBit prostora", async () => {
    await service.create({ name: "Servoteh", taxId: "100002887" }, USER);

    const [lockSql] = prisma.$executeRaw.mock.calls[0] as [string[]];
    expect(lockSql.join("")).toContain("pg_advisory_xact_lock");

    const [sqlParts, ...values] = prisma.$queryRaw.mock.calls[0] as [
      string[],
      ...number[],
    ];
    expect(sqlParts.join("?")).toContain("FROM customers");
    // `MAX(id)+1` se traži SAMO unutar opsega — inače bi native red seo na tuđu šifru.
    expect(values).toEqual([NATIVE_CUSTOMER_ID_BASE - 1, NATIVE_CUSTOMER_ID_BASE]);

    const [createArgs] = prisma.customer.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data.id).toBe(NATIVE_ID);
    expect(createArgs.data.id as number).toBeGreaterThanOrEqual(
      NATIVE_CUSTOMER_ID_BASE,
    );
  });

  it("granica native opsega je ISTA kao kod artikala (jedan broj, jedno pravilo)", () => {
    expect(NATIVE_CUSTOMER_ID_BASE).toBe(900_000_000);
    expect(NATIVE_CUSTOMER_ID_BASE).toBe(NATIVE_ITEM_ID_BASE);
  });

  it("upisuje `source = NATIVE`, a `bb_sifra` NE dira (nju postavlja trigger)", async () => {
    await service.create({ name: "Servoteh", taxId: "100002887" }, USER);

    const [createArgs] = prisma.customer.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(createArgs.data.source).toBe(CUSTOMER_SOURCE_NATIVE);
    expect("bbSifra" in createArgs.data).toBe(false);
  });

  it("sekvenca se VIŠE NE poravnava sa MAX(id) — to bi vratilo šifru u BigBit prostor", async () => {
    await service.create({ name: "Servoteh", taxId: "100002887" }, USER);

    // `alignIdSequence` radi `setval(seq, MAX(id))` ≈ 1.006.067 — regresija koju
    // CHECK `chk_customers_native_id_range` hvata tek u bazi, a ovde uopšte ne sme
    // da se desi.
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
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
    expect(updateArgs.where.id).toBe(NATIVE_ID);
    expect(updateArgs.data.taxId).toBe(`XX_${NATIVE_ID}`);
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
    expect(updateArgs.data.driverId).toBe(NATIVE_ID);
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

  it("dupli PIB na DRUGOM 4.0-native komitentu ostaje UPOZORENJE i imenuje ga", async () => {
    // Isti mock odgovara i na upit za blizance i na upit za upozorenja — red je
    // `NATIVE`, pa ga brana propušta, a upozorenje ga i dalje imenuje.
    prisma.customer.findMany.mockResolvedValue([
      {
        id: NATIVE_CUSTOMER_ID_BASE + 4,
        name: "Servoteh d.o.o.",
        city: "Čačak",
        source: CUSTOMER_SOURCE_NATIVE,
        bbSifra: null,
      },
    ]);

    const res = await service.create(
      { name: "Servoteh 2", taxId: "100002887" },
      USER,
    );

    expect(res.data).toBeDefined();
    expect(res.meta.upozorenja).toHaveLength(1);
    expect(res.meta.upozorenja[0]).toContain(String(NATIVE_CUSTOMER_ID_BASE + 4));
    expect(res.meta.upozorenja[0]).toContain("Servoteh d.o.o.");
    expect(prisma.customer.create).toHaveBeenCalled();
  });

  it("izmena: menja se samo poslato + `PoslednjaIzmena`/`PoslednjaIzmenaUser`", async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(currentRow())
      .mockResolvedValueOnce(customerRow({ taxId: "100002887" }));

    await service.update(NATIVE_ID, { city: "Čačak" }, USER);

    const [args] = prisma.customer.update.mock.calls[0] as [
      { where: { id: number }; data: Record<string, unknown> },
    ];
    expect(args.where.id).toBe(NATIVE_ID);
    expect(args.data.city).toBe("Čačak");
    expect(args.data.updatedAt).toBeInstanceOf(Date);
    expect(args.data.updatedBy).toBe("nenad.jarakovic");
    expect("createdBy" in args.data).toBe(false);
    expect("createdAt" in args.data).toBe(false);
    // Poreklo se NE prepisuje pri izmeni — red ostaje ono što jeste.
    expect("source" in args.data).toBe(false);
  });

  it("izmena: brisanje PIB-a upisuje `XX_<Sifra>`, ne prazan string", async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(currentRow({ skipTaxIdValidation: true }))
      .mockResolvedValueOnce(customerRow());

    await service.update(NATIVE_ID, { taxId: "" }, USER);

    const [args] = prisma.customer.update.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(args.data.taxId).toBe(`XX_${NATIVE_ID}`);
  });
});

// ═══════════════════════════════════════════ Poreklo reda (ostaje i posle otvaranja)

describe("Izmena komitenta koji je došao iz BigBit-a", () => {
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

  it("odbija se sa 409, IMENUJE komitenta i kaže da se ispravlja u BigBit-u", async () => {
    prisma.customer.findUnique.mockResolvedValueOnce({
      id: 4821,
      name: "Servoteh d.o.o.",
      source: CUSTOMER_SOURCE_BIGBIT,
      bbSifra: 4821,
      taxId: "100002887",
      skipTaxIdValidation: false,
      codeTypeCode: "KUPDOB",
      driverId: null,
    });

    try {
      await service.update(4821, { bankAccount1: "160-0000000000000-00" }, USER);
      fail("očekivan izuzetak");
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      const res = body(e);
      expect(res.code).toBe("BIGBIT_OWNED_READ_ONLY");
      expect(res.message).toContain("Servoteh d.o.o."); // KO
      expect(res.message).toContain("4821"); // pod kojom šifrom
      expect(res.message).toContain("BigBit"); // GDE se ispravlja
      // Reopen 061/26 (04.08.2026): izmena stiže noćnim .mdb uvozom — dugme
      // „Pokreni sync" je ne može doneti (QBigTehn kopija zamrznuta od 22.07).
      expect(res.message).toContain("noćnim uvozom"); // KADA stiže
    }
    // Ništa nije upisano — greška stiže pre `update` upita.
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it("4.0-native komitent se menja normalno (brana važi samo za BigBit redove)", async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(currentRow())
      .mockResolvedValueOnce(customerRow());

    await service.update(NATIVE_ID, { city: "Čačak" }, USER);

    expect(prisma.customer.update).toHaveBeenCalled();
  });

  it("bez markera (stari `select`) odluku donosi opseg šifre — „ne znam“ znači BigBit", async () => {
    // Red bez `source`: id iz BigBit prostora → odbijeno.
    prisma.customer.findUnique.mockResolvedValueOnce({
      id: 42,
      name: "Stari red",
      taxId: "100002887",
      skipTaxIdValidation: false,
      codeTypeCode: "KUPDOB",
      driverId: null,
    });
    await expect(
      service.update(42, { city: "Niš" }, USER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.customer.update).not.toHaveBeenCalled();

    // Isti red bez markera, ali sa šifrom iz native opsega → propušteno.
    prisma.customer.findUnique
      .mockResolvedValueOnce({
        id: NATIVE_ID,
        name: "Nov red",
        taxId: "100002887",
        skipTaxIdValidation: false,
        codeTypeCode: "KUPDOB",
        driverId: null,
      })
      .mockResolvedValueOnce(customerRow());
    await service.update(NATIVE_ID, { city: "Niš" }, USER);
    expect(prisma.customer.update).toHaveBeenCalledTimes(1);
  });

  it("komitent 0 = Servoteh d.o.o. ostaje BigBit-ov — `bb_sifra = 0` je falsy, ali validna šifra", () => {
    const servoteh = {
      id: 0,
      name: "Servoteh d.o.o.",
      source: CUSTOMER_SOURCE_BIGBIT,
      bbSifra: 0,
    };

    expect(isNativeCustomer(servoteh)).toBe(false);
    expect(bigBitSifraOf(servoteh)).toBe(0);
    expect(() => assertCustomerIsNative(servoteh)).toThrow(ConflictException);
    // `??`, ne `||`: sa `||` bi šifra ispala `id`, a sa `!bbSifra` bi red ispao native.
    expect(bigBitSifraOf({ id: 7, bbSifra: 0 })).toBe(0);
  });

  it("marker je jači od opsega: `source = BIGBIT` u native opsegu se i dalje odbija", () => {
    expect(
      isNativeCustomer({
        id: NATIVE_CUSTOMER_ID_BASE + 9,
        source: CUSTOMER_SOURCE_BIGBIT,
        bbSifra: 5,
      }),
    ).toBe(false);
    expect(
      isNativeCustomer({ id: 12, source: CUSTOMER_SOURCE_NATIVE, bbSifra: null }),
    ).toBe(true);
  });
});

describe("Nov komitent sa PIB-om koji BigBit već vodi", () => {
  let service: MasterCustomersService;
  let prisma: ReturnType<typeof prismaMock>;

  /** Zatečeni BigBit komitent sa istim PIB-om. */
  const BIGBIT_TWIN = {
    id: 4821,
    name: "Servoteh d.o.o.",
    city: "Čačak",
    source: CUSTOMER_SOURCE_BIGBIT,
    bbSifra: 4821,
  };

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

  it("create(): 409 `KOMITENT_VEC_POSTOJI` koji UPUĆUJE na postojećeg, bez upisa", async () => {
    prisma.customer.findMany.mockResolvedValue([BIGBIT_TWIN]);

    try {
      await service.create({ name: "Servoteh 2", taxId: "100002887" }, USER);
      fail("očekivan izuzetak");
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      const res = body(e);
      expect(res.code).toBe("KOMITENT_VEC_POSTOJI");
      expect(res.message).toContain("4821"); // šifra postojećeg
      expect(res.message).toContain("Servoteh d.o.o."); // ime postojećeg
      expect(res.message).toContain("Otvorite postojećeg"); // šta korisnik radi
    }
    expect(prisma.customer.create).not.toHaveBeenCalled();
  });

  it("create(): poreklo se traži i u bazi i u kodu (filter u `where` + provera markera)", async () => {
    prisma.customer.findMany.mockResolvedValue([BIGBIT_TWIN]);

    await expect(
      service.create({ name: "Servoteh 2", taxId: "100002887" }, USER),
    ).rejects.toBeInstanceOf(ConflictException);

    const args = twinQuery(prisma) as
      | { where: { taxId: string; source: string } }
      | undefined;
    expect(args?.where.taxId).toBe("100002887");
    expect(args?.where.source).toBe(CUSTOMER_SOURCE_BIGBIT);
  });

  it("create(): prazan PIB / placeholder se ne provlači kroz brenu duplikata", async () => {
    prisma.customer.findMany.mockResolvedValue([BIGBIT_TWIN]);

    await service.create({ name: "Ino GmbH", skipTaxIdValidation: true }, USER);

    expect(twinQuery(prisma)).toBeUndefined();
    expect(prisma.customer.create).toHaveBeenCalled();
  });

  it("update(): native komitent ne sme da PREUZME PIB koji BigBit vodi", async () => {
    prisma.customer.findUnique.mockResolvedValueOnce(
      currentRow({ taxId: "111111116" }),
    );
    prisma.customer.findMany.mockResolvedValue([BIGBIT_TWIN]);

    try {
      await service.update(NATIVE_ID, { taxId: "100002887" }, USER);
      fail("očekivan izuzetak");
    } catch (e) {
      expect(body(e).code).toBe("KOMITENT_VEC_POSTOJI");
    }
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it("update(): zatečen duplikat NE zaključava izmenu drugog polja (PIB se ne dira)", async () => {
    prisma.customer.findUnique
      .mockResolvedValueOnce(currentRow())
      .mockResolvedValueOnce(customerRow({ taxId: "100002887" }));
    prisma.customer.findMany.mockResolvedValue([BIGBIT_TWIN]);

    const res = await service.update(NATIVE_ID, { phone: "032/123-456" }, USER);

    expect(prisma.customer.update).toHaveBeenCalled();
    expect(twinQuery(prisma)).toBeUndefined();
    // Upozorenje o duplom PIB-u i dalje stiže — korisnik vidi, ali nije zaustavljen.
    expect(res.meta.upozorenja.join(" ")).toContain("Servoteh d.o.o.");
  });
});

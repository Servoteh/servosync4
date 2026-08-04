import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { KamataService, documentGroupKey } from "./kamata.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * OSNOVICA KAMATE = NETO SALDO JEDNOG DOKUMENTA.
 * ============================================================================
 * Dva invarijanta koja se ovde drže i koja vuku u SUPROTNE strane:
 *
 *   1) DVA DOKUMENTA NE SMEJU U ISTU GRUPU — inače kupcu ide obračun na zbir tuđih
 *      dugova, sa najranijim dospećem od svih. Kvar iz 01.08.2026: avansni račun i
 *      faktura sa istim rednim brojem (`7/26`) na istom kupčevom kontu.
 *   2) JEDAN DOKUMENT NE SME U DVE GRUPE — inače uplata ne umanjuje osnovicu i
 *      kamata se računa na već plaćeni deo fakture (raniji nalaz VISOK).
 *
 * Zbog (2) vrsta dokumenta NE može u grupni ključ (uplata je ne nosi), pa (1) mora
 * da reši numeracija — avans ima sopstvenu seriju `A-7/26` (odluka O-F6). Ovi
 * testovi su brana za oba pravca.
 */

const D = Prisma.Decimal;

/** Jedna GK stavka kakvu `compute` čita (samo polja iz `select`-a). */
function entry(over: {
  id: number;
  documentNumber: string | null;
  debit?: string;
  credit?: string;
  dueDate?: Date | null;
}) {
  return {
    id: over.id,
    documentNumber: over.documentNumber,
    debit: new D(over.debit ?? "0"),
    credit: new D(over.credit ?? "0"),
    dueDate: over.dueDate ?? null,
  };
}

/**
 * Lažni Prisma: registar saldakonto konta + zadate GK stavke; `interestCalculation
 * .create` vraća ono što mu servis pošalje (uz `lines` iz nested create), da test
 * gleda tačno one linije koje bi se upisale.
 */
function makePrisma(entries: ReturnType<typeof entry>[]) {
  const created: { data: Record<string, unknown> }[] = [];
  return {
    created,
    prisma: {
      interestRate: {
        findFirst: jest.fn().mockResolvedValue({ ratePct: new D("10") }),
      },
      saldakontoAccount: {
        findMany: jest.fn().mockResolvedValue([{ account: "2040" }]),
      },
      ledgerEntry: { findMany: jest.fn().mockResolvedValue(entries) },
      interestCalculation: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args);
          const lines = (
            args.data.lines as { create: Record<string, unknown>[] }
          ).create;
          return {
            id: 1,
            partnerId: args.data.partnerId,
            kind: args.data.kind,
            method: args.data.method,
            calcDate: args.data.calcDate,
            totalPrincipal: args.data.totalPrincipal,
            totalInterest: args.data.totalInterest,
            status: args.data.status,
            journalEntryId: null,
            lines: lines.map((l, i) => ({ id: i + 1, ...l })),
          };
        }),
      },
    } as unknown as PrismaService,
  };
}

describe("KamataService.compute — grupa je JEDAN dokument", () => {
  const CALC_DATE = "2026-07-01T00:00:00.000Z";
  const DUE_AVANS = new Date("2026-02-10T00:00:00.000Z");
  const DUE_FAKTURA = new Date("2026-06-30T00:00:00.000Z");

  it("SCENARIO: avans A-7/26 i faktura 7/26 su DVA duga, ne jedan od 24.000", async () => {
    // Kupac ima nenaplaćen avansni račun (12.000, dospeće 10.02) i fakturu
    // (12.000, dospeće 30.06). Oba stoje na istom kupčevom kontu 2040. Dok je avans
    // dobijao goli broj `7/26`, obe stavke su padale u istu grupu → jedan dug od
    // 24.000 sa dospećem 10.02 i kamata na duplo veći iznos, mesecima predugo.
    const { prisma } = makePrisma([
      entry({
        id: 1,
        documentNumber: "A-7/26",
        debit: "12000",
        dueDate: DUE_AVANS,
      }),
      entry({
        id: 2,
        documentNumber: "7/26",
        debit: "12000",
        dueDate: DUE_FAKTURA,
      }),
    ]);

    const result = await new KamataService(prisma).compute({
      partnerId: 5,
      calcDate: CALC_DATE,
    });

    expect(result.lines).toHaveLength(2);
    const byDoc = new Map(result.lines.map((l) => [l.documentNumber, l]));
    expect(byDoc.get("A-7/26")?.principal).toBe("12000.00");
    expect(byDoc.get("7/26")?.principal).toBe("12000.00");
    // Nijedna osnovica nije zbir oba dokumenta.
    expect(result.totalPrincipal).toBe("24000.00");
    for (const l of result.lines) expect(l.principal).not.toBe("24000.00");

    // Dospeće je svakom svoje — faktura ne nasleđuje raniji rok avansa.
    expect(byDoc.get("A-7/26")?.daysOverdue).toBeGreaterThan(
      byDoc.get("7/26")!.daysOverdue,
    );
  });

  it("BRANA: isti goli broj na oba dokumenta i dalje bi ih spojio", async () => {
    // Dokaz da je prefiks serije (O-F6) JEDINO što razdvaja avans od fakture na
    // ovom nivou — glavna knjiga nema kolonu vrste dokumenta. Ako neko ukine `A-`,
    // vraća se kvar iz gornjeg testa, i ovaj test to čini vidljivim.
    const { prisma } = makePrisma([
      entry({ id: 1, documentNumber: "7/26", debit: "12000", dueDate: DUE_AVANS }),
      entry({
        id: 2,
        documentNumber: "7/26",
        debit: "12000",
        dueDate: DUE_FAKTURA,
      }),
    ]);

    const result = await new KamataService(prisma).compute({
      partnerId: 5,
      calcDate: CALC_DATE,
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].principal).toBe("24000.00");
    expect(result.lines[0].dueDate).toEqual(DUE_AVANS);
  });

  it("uplata BEZ vrste dokumenta i dalje umanjuje osnovicu (netiranje očuvano)", async () => {
    // Zašto vrsta ne sme u grupni ključ: uplata sa izvoda nosi samo broj dokumenta.
    // Da je ključ (broj + vrsta), ovaj kredit bi ostao u svojoj grupi i kamata bi
    // se računala na punih 12.000 umesto na neplaćeni ostatak (nalaz VISOK).
    const { prisma } = makePrisma([
      entry({
        id: 1,
        documentNumber: "7/26",
        debit: "12000",
        dueDate: DUE_FAKTURA,
      }),
      entry({ id: 2, documentNumber: "7/26", credit: "9000" }), // uplata, bez dospeća
    ]);

    const result = await new KamataService(prisma).compute({
      partnerId: 5,
      calcDate: CALC_DATE,
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].principal).toBe("3000.00");
  });

  it("stavke BEZ broja dokumenta se ne netuju međusobno (svaka je svoja grupa)", () => {
    expect(documentGroupKey(null, 11)).not.toBe(documentGroupKey(null, 12));
    expect(documentGroupKey("7/26", 11)).toBe(documentGroupKey("7/26", 12));
    // Fallback ključ ne sme da se sudari sa stvarnim brojem dokumenta.
    expect(documentGroupKey(null, 11)).not.toBe("11");
  });
});

/**
 * OSNOVICA KAMATE = SAMO KUPČEVA KONTA (D1 / nalaz K-1, 04.08.2026).
 * ============================================================================
 * ŠTA SE DEŠAVALO PRE POPRAVKE: konta su se birala po `side: "receivable"`, a to je
 * STRANA SALDA — u registru tom uslovu odgovara PET konta, jer su i avansi koje smo MI
 * PLATILI dobavljaču (1520/1521/1530) aktiva sa dugovnim saldom. Dobavljač je zato
 * dobijao kamatni list: stavka `1520 / AV-3/26 / 500.000,00 / dospeće 01.03.2026` je na
 * presek 02.08.2026 ulazila kao glavnica 500.000,00 / 154 dana.
 *
 * Uslov je sada `side + partner_scope = 'customer'` NAD REGISTROM (nikad spisak konta u
 * kodu). `partner_scope = NULL` ne ulazi — Prisma jednakost NULL ne hvata, i to je
 * namerno: kamatni list ide partneru, pa se kupac ne pretpostavlja.
 */
describe("KamataService.compute — kamata samo po kupčevim kontima", () => {
  const CALC_DATE = "2026-08-02T00:00:00.000Z";

  const reg = (account: string, side: string, partnerScope: string | null) => ({
    account,
    side,
    partnerScope,
    tracksOpenItems: true,
  });

  /** Registar kakav je seedovan na produkciji (migracija 20260726100000). */
  const REGISTRY = [
    reg("1520", "receivable", "supplier"), // avans PLAĆEN dobavljaču (aktiva!)
    reg("1530", "receivable", "supplier"), // isto, inostranstvo
    reg("2040", "receivable", "customer"), // kupci u zemlji
    reg("4350", "payable", "supplier"), // dobavljači u zemlji
    reg("2049", "receivable", null), // ručno dodat konto bez scope-a
  ];

  /** GK stavka SA kontom (mock filtrira po `accountCode.in`, kao baza). */
  function ledger(over: {
    id: number;
    accountCode: string;
    documentNumber: string | null;
    debit?: string;
    credit?: string;
    dueDate?: Date | null;
  }) {
    return {
      id: over.id,
      accountCode: over.accountCode,
      documentNumber: over.documentNumber,
      debit: new D(over.debit ?? "0"),
      credit: new D(over.credit ?? "0"),
      dueDate: over.dueDate ?? null,
    };
  }

  const AVANS_DOBAVLJACU = ledger({
    id: 9,
    accountCode: "1520",
    documentNumber: "AV-3/26",
    debit: "500000",
    dueDate: new Date("2026-03-01T00:00:00.000Z"),
  });
  const KUPCEVA_FAKTURA = ledger({
    id: 1,
    accountCode: "2040",
    documentNumber: "7/26",
    debit: "12000",
    dueDate: new Date("2026-06-01T00:00:00.000Z"),
  });
  const BEZ_SCOPE = ledger({
    id: 3,
    accountCode: "2049",
    documentNumber: "9/26",
    debit: "7000",
    dueDate: new Date("2026-06-01T00:00:00.000Z"),
  });

  /** Prisma mock koji STVARNO primenjuje `where` nad registrom i nad GK stavkama. */
  function makePrismaWithRegistry(entries: ReturnType<typeof ledger>[]) {
    const findManyAccounts = jest.fn(
      ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          REGISTRY.filter((a) =>
            Object.entries(where).every(
              ([k, v]) => (a as Record<string, unknown>)[k] === v,
            ),
          ).map((a) => ({ account: a.account })),
        ),
    );
    return {
      findManyAccounts,
      prisma: {
        interestRate: {
          findFirst: jest.fn().mockResolvedValue({ ratePct: new D("9.5") }),
        },
        saldakontoAccount: { findMany: findManyAccounts },
        ledgerEntry: {
          findMany: jest.fn(
            ({ where }: { where: { accountCode: { in: string[] } } }) =>
              Promise.resolve(
                entries.filter((e) =>
                  where.accountCode.in.includes(e.accountCode),
                ),
              ),
          ),
        },
        interestCalculation: {
          create: jest.fn((args: { data: Record<string, unknown> }) => {
            const lines = (
              args.data.lines as { create: Record<string, unknown>[] }
            ).create;
            return Promise.resolve({
              ...args.data,
              id: 1,
              journalEntryId: null,
              lines: lines.map((l, i) => ({ id: i + 1, ...l })),
            });
          }),
        },
      } as unknown as PrismaService,
    };
  }

  it("dati avans dobavljaču (1520) NIJE u osnovici — kupčeva faktura jeste", async () => {
    const { prisma, findManyAccounts } = makePrismaWithRegistry([
      AVANS_DOBAVLJACU,
      KUPCEVA_FAKTURA,
    ]);

    const res = await new KamataService(prisma).compute({
      partnerId: 77,
      calcDate: CALC_DATE,
    });

    // Registar je sužen na kupčeva konta (ne po spisku konta u kodu).
    expect(findManyAccounts.mock.calls[0][0].where).toMatchObject({
      side: "receivable",
      partnerScope: "customer",
      tracksOpenItems: true,
    });
    expect(res.lines.map((l) => l.documentNumber)).toEqual(["7/26"]);
    expect(res.totalPrincipal).toBe("12000.00");
    // Pre popravke: glavnica 500.000,00 na 154 dana → kamata 20.041,10.
    expect(res.lines.some((l) => l.documentNumber === "AV-3/26")).toBe(false);
    expect(res.totalPrincipal).not.toBe("512000.00");
  });

  it("partner sa SAMO datim avansom nema šta da se obračuna (400, ne kamatni list)", async () => {
    const { prisma } = makePrismaWithRegistry([AVANS_DOBAVLJACU]);

    await expect(
      new KamataService(prisma).compute({ partnerId: 77, calcDate: CALC_DATE }),
    ).rejects.toThrow(BadRequestException);
  });

  it("konto bez partner_scope (NULL) ne ulazi u osnovicu", async () => {
    const { prisma } = makePrismaWithRegistry([BEZ_SCOPE, KUPCEVA_FAKTURA]);

    const res = await new KamataService(prisma).compute({
      partnerId: 77,
      calcDate: CALC_DATE,
    });

    expect(res.lines.map((l) => l.documentNumber)).toEqual(["7/26"]);
  });
});

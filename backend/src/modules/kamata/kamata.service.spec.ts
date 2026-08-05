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

describe("Osnovica kamate ne uzima avanse koje smo MI platili dobavljaču (K-1)", () => {
  /**
   * IZMERENO (05.08.2026) nad registrom na produkciji: `side = 'receivable'` hvata PET
   * konta, ne dva — pored kupaca 2040/2050 i **1520/1521/1530**, koji su avansi DATI
   * dobavljačima (`partner_scope = 'supplier'`).
   *
   * Nad celim skupom: 522 nezatvorene stavke → posle netiranja 46.689.255,50 RSD na 64
   * dokumenta → kamata po 9,5 % bila bi 2.492.005 RSD poslata SOPSTVENIM DOBAVLJAČIMA.
   * Kvar je bio latentan samo zato što je tabela stopa prazna; budi ga prvi unos stope.
   *
   * Knjigovođa (odgovor 15): „Nemamo za sada" — dati avans jeste potraživanje, ali za
   * isporuku robe, ne dospelo novčano potraživanje.
   */
  it("upit za konta traži i partnerScope = customer, ne samo receivable", async () => {
    const { prisma } = makePrisma([]);

    await new KamataService(prisma as never)
      .compute({ partnerId: 5, calcDate: "2026-07-01T00:00:00.000Z" })
      .catch(() => undefined); // ishod nije bitan — gleda se ARGUMENT upita

    const arg = (prisma.saldakontoAccount.findMany.mock.calls as unknown[][])[0]?.[0] as
      | { where?: Record<string, unknown> }
      | undefined;

    expect(arg?.where).toMatchObject({
      side: "receivable",
      partnerScope: "customer",
      tracksOpenItems: true,
    });
  });
});

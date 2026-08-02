import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import { BankStatementService } from "./bank-statement.service";
import type { BankStatementParserService } from "./bank-statement-parser.service";
import type { ExchangeRateService } from "./exchange-rate.service";

/**
 * KNJIŽENJE IZVODA — KOJI BROJ DOKUMENTA IDE U GLAVNU KNJIGU (nalaz N1, 03.08.2026).
 * ============================================================================
 * `postStatement` je upisivao SIROV poziv na broj i onda kad je uparivanje tačno
 * pogodilo otvorenu stavku (`matchedLedgerEntryId` nije imao nijednog čitaoca).
 *
 * SCENARIO KOJI SE OVDE ZAKLJUČAVA (izmereno nad produkcijskim brojevima): faktura
 * `657/25`, kupac 4711, 120.000,00. Naš nalog za plaćanje nosi model 97, pa banka u
 * PNB-u vrati `6572527` (`computeReferenceNumber("97","657/25")`). Taj niz nema
 * separatora, `parseReference` iz njega ne izvodi `657/25`, pa uparivanje padne na
 * fallback po iznosu i NAĐE tačnu fakturu — a knjiženje je pogodak bacalo.
 * Rezultat su bile DVE otvorene grupe umesto nule: `657/25` +120.000 i `6572527`
 * −120.000; kamata je išla na punih 120.000, opomena takođe.
 *
 * Testovi gledaju TAČNO ono što bi se upisalo u `ledger_entries` (nested create koji
 * servis šalje Prismi), jer je kvar bio isključivo na upisu.
 */

const D = Prisma.Decimal;

/** GK stavka kakvu razrešavanje broja čita (samo polja iz `select`-a). */
interface FakeLedger {
  id: number;
  documentNumber: string | null;
  analyticalCode: number | null;
  reconciledAt: Date | null;
}

function ledger(
  id: number,
  documentNumber: string | null,
  analyticalCode: number | null,
  reconciledAt: Date | null = null,
): FakeLedger {
  return { id, documentNumber, analyticalCode, reconciledAt };
}

/** Jedna stavka izvoda; podrazumevano priliv 120.000 od kupca 4711 sa model-97 PNB-om. */
function line(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    statementId: 1,
    lineNo: 1,
    partnerAccount: "205-1234567890-11",
    partnerName: "Metalprodukt d.o.o.",
    amount: new D("120000"),
    direction: "CREDIT",
    referenceNumber: "6572527",
    documentDate: null,
    matchedCustomerId: 4711,
    matchedLedgerEntryId: null,
    status: "MATCHED",
    currency: null,
    foreignAmount: null,
    exchangeRate: null,
    deletedAt: null,
    deletedByUserId: null,
    ...over,
  };
}

interface LedgerLineDraft {
  accountCode: string;
  analyticalCode: number | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string;
  documentNumber: string | null;
}

function makeService(
  lines: ReturnType<typeof line>[],
  ledgerRows: FakeLedger[],
) {
  const created: { data: { lines: { create: LedgerLineDraft[] } } }[] = [];

  const statement = {
    id: 1,
    bankAccount: "160-0000000000000-00",
    statementNumber: "042",
    statementDate: new Date(Date.UTC(2026, 6, 15)),
    status: "IMPORTED",
    currency: "RSD",
    openingBalance: new D(0),
    closingBalance: new D(0),
    importedFileName: null,
    createdByUserId: null,
    lines,
  };

  // Jedan lažni `ledgerEntry.findMany` opslužuje oba upita razrešavanja:
  //   (1) po `id: { in }`  — potvrđene veze stavki izvoda;
  //   (2) po (analitika, broj dokumenta) — dokaz da je sirov PNB stvarno broj otvorene
  //       stavke tog komitenta.
  const ledgerFindMany = jest.fn(
    async (args: {
      where: {
        id?: { in: number[] };
        analyticalCode?: { in: number[] };
        documentNumber?: { in: string[] };
      };
    }) => {
      const w = args.where ?? {};
      if (w.id?.in) return ledgerRows.filter((e) => w.id!.in.includes(e.id));
      const partners = w.analyticalCode?.in ?? [];
      const docs = w.documentNumber?.in ?? [];
      return ledgerRows.filter(
        (e) =>
          e.reconciledAt == null &&
          e.analyticalCode != null &&
          partners.includes(e.analyticalCode) &&
          e.documentNumber != null &&
          docs.includes(e.documentNumber),
      );
    },
  );

  const client = {
    bankStatement: {
      findUnique: jest.fn(async () => statement),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    bankStatementLine: {
      updateMany: jest.fn(async () => ({ count: lines.length })),
    },
    ledgerEntry: { findMany: ledgerFindMany },
    journalEntry: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(
        async (args: { data: { lines: { create: LedgerLineDraft[] } } }) => {
          created.push(args);
          return {
            id: 99,
            number: "0001",
            lines: args.data.lines.create.map((l, i) => ({ id: i + 1, ...l })),
          };
        },
      ),
    },
    $executeRaw: jest.fn(async () => 1),
  };

  const prisma = {
    ...client,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  } as unknown as PrismaService;

  const service = new BankStatementService(
    prisma,
    {} as BankStatementParserService,
    {} as ExchangeRateService,
  );

  return {
    service,
    ledgerFindMany,
    /** Stavke GK koje bi se upisale (bez protivstavke banke). */
    partnerLines: () =>
      created[0].data.lines.create.filter((l) => l.analyticalCode != null),
    allLines: () => created[0].data.lines.create,
  };
}

/** Knjiži izvod sa eksplicitnim kontom banke (da test ne zavisi od PaymentAccount). */
async function post(h: ReturnType<typeof makeService>) {
  await h.service.postStatement(1, { bankAccountCode: "2410" });
}

describe("BankStatementService.postStatement — broj dokumenta u GK (N1)", () => {
  it("UPARENA stavka: upisuje se broj FAKTURE, ne sirov poziv na broj", async () => {
    // Uparivanje je fakturu našlo (fallback po iznosu — PNB `6572527` nema kandidata),
    // pa knjiženje mora da upiše broj koji glavna knjiga poznaje. Inače nastaju dve
    // grupe (`657/25` +120.000 i `6572527` −120.000) i plaćen kupac dobija opomenu.
    const h = makeService(
      [line({ matchedLedgerEntryId: 7001 })],
      [ledger(7001, "657/25", 4711)],
    );

    await post(h);

    const [partner] = h.partnerLines();
    expect(partner.documentNumber).toBe("657/25");
    expect(partner.documentNumber).not.toBe("6572527");
    // Uplata potražuje na kupčevom kontu — netiranje sa fakturom radi samo pod istim brojem.
    expect(partner.accountCode).toBe("2040");
    expect(partner.credit.toFixed(2)).toBe("120000.00");
  });

  it("BEZ pogotka: broj ostaje PRAZAN (neraspoređena uplata), PNB ide u opis", async () => {
    // Sirov PNB je ono što je platilac otkucao. Upisan kao broj dokumenta pravi fantomsku
    // otvorenu stavku i može da zatvori BUDUĆI dokument koji slučajno dobije taj broj.
    // Kupčev saldo ostaje tačan (uplata i dalje potražuje), a otkucani broj se ne gubi.
    const h = makeService(
      [line()], // bez matchedLedgerEntryId; PNB `6572527` nije broj nijedne stavke
      [ledger(7001, "657/25", 4711)],
    );

    await post(h);

    const [partner] = h.partnerLines();
    expect(partner.documentNumber).toBeNull();
    expect(partner.description).toContain("NERASPOREĐENO");
    expect(partner.description).toContain("6572527");
  });

  it("PNB koji JESTE broj otvorene stavke tog komitenta se i dalje upisuje", async () => {
    // Jedini slučaj u kom je stari kod bio tačan (kupac otkuca baš naš broj) mora da
    // preživi ispravku — inače bi ispravka pokvarila netiranje koje je radilo.
    const h = makeService(
      [line({ referenceNumber: "657/25" })],
      [ledger(7001, "657/25", 4711)],
    );

    await post(h);

    const [partner] = h.partnerLines();
    expect(partner.documentNumber).toBe("657/25");
    expect(partner.description).not.toContain("NERASPOREĐENO");
  });

  it("ZASTARELA veza (stavka drugog komitenta) se NE koristi", async () => {
    // `updateLine` menja `matchedCustomerId`, a `matchedLedgerEntryId` briše samo kad se
    // komitent skida na null — prepravka komitenta ostavlja vezu na tuđu stavku. Po njoj
    // bi uplata zatvorila tuđi dug.
    const h = makeService(
      [line({ matchedLedgerEntryId: 7002 })],
      [ledger(7002, "999/25", 999), ledger(7001, "657/25", 4711)],
    );

    await post(h);

    const [partner] = h.partnerLines();
    expect(partner.documentNumber).not.toBe("999/25");
    expect(partner.documentNumber).toBeNull();
  });

  it("ODLIV (plaćanje dobavljaču) ide istim pravilom", async () => {
    const h = makeService(
      [
        line({
          direction: "DEBIT",
          matchedLedgerEntryId: 8001,
          referenceNumber: "9711223344",
          partnerName: "Elektrodistribucija",
        }),
      ],
      [ledger(8001, "UF-88/26", 4711)],
    );

    await post(h);

    const [partner] = h.partnerLines();
    expect(partner.accountCode).toBe("4350");
    expect(partner.documentNumber).toBe("UF-88/26");
    expect(partner.debit.toFixed(2)).toBe("120000.00");
  });

  it("protivstavka banke nosi broj IZVODA i nema analitiku", async () => {
    const h = makeService(
      [line({ matchedLedgerEntryId: 7001 })],
      [ledger(7001, "657/25", 4711)],
    );

    await post(h);

    const bank = h.allLines().find((l) => l.accountCode === "2410");
    expect(bank).toBeDefined();
    expect(bank!.analyticalCode).toBeNull();
    expect(bank!.documentNumber).toBe("042");
    expect(bank!.debit.toFixed(2)).toBe("120000.00");
  });

  it("razrešavanje je BATCH — najviše dva upita bez obzira na broj stavki", async () => {
    // Izvod ume da ima stotine stavki; razrešavanje po stavci bi bilo N+1 u transakciji
    // koja drži nalog GK.
    const h = makeService(
      [
        line({ id: 1, matchedLedgerEntryId: 7001 }),
        line({ id: 2, matchedLedgerEntryId: 7002, matchedCustomerId: 5100 }),
        line({ id: 3, referenceNumber: "657/25" }),
        line({ id: 4, referenceNumber: "6572527" }),
      ],
      [
        ledger(7001, "657/25", 4711),
        ledger(7002, "658/25", 5100),
        ledger(7003, "657/25", 4711),
      ],
    );

    await post(h);

    expect(h.ledgerFindMany).toHaveBeenCalledTimes(2);
    expect(h.partnerLines().map((l) => l.documentNumber)).toEqual([
      "657/25",
      "658/25",
      "657/25",
      null,
    ]);
  });
});

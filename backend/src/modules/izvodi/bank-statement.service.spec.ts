import type { ModuleRef } from "@nestjs/core";
import { Prisma } from "@prisma/client";
import { UnprocessableEntityException } from "@nestjs/common";
import type { PrismaService } from "../../prisma/prisma.service";
import { BankStatementService } from "./bank-statement.service";
import type {
  BankStatementParserService,
  ParseStatementResult,
} from "./bank-statement-parser.service";
import type { ExchangeRateService } from "./exchange-rate.service";
import { ReconciliationService } from "../saldakonti/reconciliation.service";

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

/**
 * GK stavka kakvu razrešavanje broja čita (+ dug/pot i `reconciliationGroupId`, koje čita
 * zatvaranje uparivanja — D3).
 */
interface FakeLedger {
  id: number;
  documentNumber: string | null;
  analyticalCode: number | null;
  reconciledAt: Date | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  reconciliationGroupId?: number | null;
}

/** Otvorena stavka kupca: dugovna (faktura). `debit` se može pregaziti za delimičnu uplatu. */
function ledger(
  id: number,
  documentNumber: string | null,
  analyticalCode: number | null,
  reconciledAt: Date | null = null,
  debit: Prisma.Decimal = new D("120000"),
): FakeLedger {
  return {
    id,
    documentNumber,
    analyticalCode,
    reconciledAt,
    debit,
    credit: new D(0),
    reconciliationGroupId: null,
  };
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

/**
 * Lažni `ReconciliationService` koji radi ono što pravi radi za naš slučaj: proveri balans
 * (Σdug == Σpot u granici pare) i postavi `reconciled_at` na obe stavke. Test time meri
 * POSLEDICU (stavka je zatvorena), ne samo da je metod pozvan — v. defekt D3.
 */
function fakeReconciliation(ledgerRows: FakeLedger[]) {
  let nextGroupId = 500;
  const calls: { entryIds: number[]; note?: string }[] = [];
  const autoReconcile = jest.fn(
    async (entryIds: number[], _userId?: number, note?: string) => {
      calls.push({ entryIds, note });
      const rows = entryIds.map((id) => {
        const row = ledgerRows.find((r) => r.id === id);
        if (!row) throw new Error(`Stavke glavne knjige ne postoje: ${id}.`);
        if (row.reconciledAt != null)
          throw new UnprocessableEntityException(
            `Stavka ${id} je već zatvorena (uparena).`,
          );
        return row;
      });
      let debit = new D(0);
      let credit = new D(0);
      for (const r of rows) {
        debit = debit.add(r.debit ?? new D(0));
        credit = credit.add(r.credit ?? new D(0));
      }
      const residual = debit.sub(credit);
      if (residual.abs().greaterThan(new D("0.01")))
        throw new UnprocessableEntityException(
          `Stavke ne balansiraju u granici tolerancije: ostatak=${residual.toFixed(2)} > 0.01.`,
        );
      const groupId = (nextGroupId += 1);
      const now = new Date();
      for (const r of rows) {
        r.reconciledAt = now;
        r.reconciliationGroupId = groupId;
      }
      return { groupId, entryIds, totalDebit: debit, totalCredit: credit, residual, balanced: residual.isZero() };
    },
  );
  return { service: { autoReconcile } as unknown as ReconciliationService, autoReconcile, calls };
}

function makeService(
  lines: ReturnType<typeof line>[],
  ledgerRows: FakeLedger[],
  statementOver: Partial<{
    openingBalance: Prisma.Decimal;
    closingBalance: Prisma.Decimal;
  }> = {},
) {
  const created: { data: { lines: { create: LedgerLineDraft[] } } }[] = [];
  const recon = fakeReconciliation(ledgerRows);

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
    ...statementOver,
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
          // Upisane stavke ULAZE u glavnu knjigu — posle commit-a ih zatvaranje uparivanja
          // čita po id-u, pa lažna baza mora da ih zna (ids 9001+ da ne udare u fakture).
          const rows = args.data.lines.create.map((l, i) => {
            const row: FakeLedger = {
              id: 9001 + i,
              documentNumber: l.documentNumber,
              analyticalCode: l.analyticalCode,
              reconciledAt: null,
              debit: l.debit,
              credit: l.credit,
              reconciliationGroupId: null,
            };
            ledgerRows.push(row);
            return { id: row.id, ...l };
          });
          return { id: 99, number: "0001", lines: rows };
        },
      ),
    },
    $executeRaw: jest.fn(async () => 1),
  };

  const prisma = {
    ...client,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  } as unknown as PrismaService;

  // ModuleRef vraća `ReconciliationService` — servis ga tako vadi jer bi uvoz
  // SaldakontiModule-a napravio ciklus modula (v. `resolveReconciliationService`).
  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (token === ReconciliationService) return recon.service;
      throw new Error("nepoznat token");
    }),
  } as unknown as ModuleRef;

  const service = new BankStatementService(
    prisma,
    {} as BankStatementParserService,
    {} as ExchangeRateService,
    moduleRef,
  );

  return {
    service,
    ledgerFindMany,
    ledgerRows,
    autoReconcile: recon.autoReconcile,
    reconcileCalls: recon.calls,
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

// ═══════════════════════════════════════════════════════════════════════════════
// D1/D2 — UVOZ: nepročitan red i kontrola salda
// ═══════════════════════════════════════════════════════════════════════════════

/** Servis za testove uvoza: parser je lažan (vraća zadat rezultat), upis se samo hvata. */
function makeImportService(parseResult: ParseStatementResult) {
  const created: { data: Record<string, unknown> }[] = [];
  const parser = {
    parse: jest.fn(() => parseResult),
  } as unknown as BankStatementParserService;

  const prisma = {
    bankStatement: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args);
        return { id: 7, ...args.data, lines: [] };
      }),
    },
  } as unknown as PrismaService;

  const service = new BankStatementService(
    prisma,
    parser,
    {} as ExchangeRateService,
    { get: jest.fn() } as unknown as ModuleRef,
  );
  return { service, created, parser };
}

/** Draft stavka kakvu parser vraća (priliv 120.000). */
function parsedLine(over: Partial<{ amount: Prisma.Decimal; direction: string }> = {}) {
  return {
    lineNo: 1,
    partnerAccount: "205-1234567890-11",
    partnerName: "Metalprodukt d.o.o.",
    amount: new D("120000"),
    direction: "CREDIT" as const,
    referenceNumber: "6572527",
    model: "97",
    documentDate: new Date(Date.UTC(2026, 6, 24)),
    ...over,
  } as ParseStatementResult["lines"][number];
}

const IMPORT_BASE = {
  bankAccount: "160-0000000000000-00",
  statementNumber: "042",
  statementDate: "2026-07-24",
  txtContent: "nebitno — parser je lažan",
};

/**
 * Poruke iz `BadRequestException(errors[])` — Nest ih stavlja u `response.message`, a
 * `err.message` je samo „Bad Request Exception". Test mora da gleda ono što korisnik vidi.
 */
async function badRequestMessages(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const res = (err as { getResponse?: () => unknown }).getResponse?.();
    const message = (res as { message?: unknown })?.message;
    return Array.isArray(message) ? message.join(" | ") : String(message ?? err);
  }
  throw new Error("Očekivana je greška, a poziv je prošao.");
}

describe("BankStatementService.importStatement — nepročitan red obara uvoz (D1)", () => {
  it("(a) TXT sa PREKRATKIM redom: uvoz NE prolazi, poruka nosi broj reda i razlog", async () => {
    // Pre popravke je prekratak red nestajao u `logger.debug`, izvod se uvozio bez te
    // uplate, a kontrola salda je (jer je uvoz nije punio) pokazivala zeleno.
    const h = makeImportService({
      lines: [parsedLine()],
      skipped: [
        {
          fileLineNo: 2,
          reason: "dužina 31 < 196 znakova (nije puna FX stavka)",
          excerpt: "160000000011061083 KRATAK RED",
        },
      ],
    });

    await expect(
      h.service.importStatement({
        ...IMPORT_BASE,
        openingBalance: 0,
        closingBalance: 120000,
      }),
    ).rejects.toThrow(UnprocessableEntityException);

    // I dalje ništa nije upisano — delimično uvezen izvod je gori od nijednog.
    expect(h.created).toHaveLength(0);

    await expect(
      h.service.importStatement({
        ...IMPORT_BASE,
        openingBalance: 0,
        closingBalance: 120000,
      }),
    ).rejects.toThrow(/red 2.*dužina.*196/s);
  });

  it("čist TXT sa usklađenim stanjima se uvozi (kontrolna grupa)", async () => {
    const h = makeImportService({ lines: [parsedLine()], skipped: [] });

    await h.service.importStatement({
      ...IMPORT_BASE,
      openingBalance: 1500,
      closingBalance: 121500,
    });

    expect(h.created).toHaveLength(1);
  });
});

describe("BankStatementService.importStatement — kontrola salda je brana (D2)", () => {
  it("(c) uvoz iz TXT-a BEZ početnog/krajnjeg stanja se ODBIJA", async () => {
    // Pre popravke su padali na 0, a kontrola salda poredi upravo njih — pa je jedina
    // brana koja bi uhvatila nestalu stavku bila uvek zadovoljena (0 = 0).
    const h = makeImportService({ lines: [parsedLine()], skipped: [] });

    const messages = await badRequestMessages(
      h.service.importStatement({ ...IMPORT_BASE }),
    );
    expect(messages).toMatch(/Početno stanje je obavezno za uvoz izvoda iz TXT-a/);
    expect(messages).toMatch(/Krajnje stanje je obavezno/);
    expect(h.created).toHaveLength(0);
    // Parser se ni ne poziva — zahtev pada na validaciji DTO-a.
    expect(h.parser.parse).not.toHaveBeenCalled();
  });

  it("samo JEDNO stanje nije dovoljno", async () => {
    const h = makeImportService({ lines: [parsedLine()], skipped: [] });

    const messages = await badRequestMessages(
      h.service.importStatement({ ...IMPORT_BASE, openingBalance: 0 }),
    );
    expect(messages).toMatch(/Krajnje stanje je obavezno/);
    expect(messages).not.toMatch(/Početno stanje je obavezno/);
  });

  it("RUČNI izvod (bez TXT-a) NAMERNO ostaje bez stanja — prazan izvod za kucanje stavki", async () => {
    const h = makeImportService({ lines: [], skipped: [] });

    await h.service.importStatement({
      bankAccount: IMPORT_BASE.bankAccount,
      statementNumber: "043",
      statementDate: IMPORT_BASE.statementDate,
      currency: "EUR",
    });

    expect(h.created).toHaveLength(1);
  });

  it("uvoz se odbija kad promet FAJLA ne daje uneto krajnje stanje (fali stavka)", async () => {
    // Ovo je scenario iz sažetka: novac je stigao na račun, ali ga u fajlu/stavkama nema.
    const h = makeImportService({
      lines: [parsedLine(), parsedLine({ amount: new D("50000") })],
      skipped: [],
    });

    await expect(
      h.service.importStatement({
        ...IMPORT_BASE,
        openingBalance: 0,
        closingBalance: 120000, // 120.000 + 50.000 ≠ 120.000
      }),
    ).rejects.toThrow(/Kontrola salda ne prolazi/);
    expect(h.created).toHaveLength(0);
  });

  it("tolerancija pola pare (devizno zaokruživanje) ne obara uvoz", async () => {
    const h = makeImportService({
      lines: [parsedLine({ amount: new D("120000.004") })],
      skipped: [],
    });

    await h.service.importStatement({
      ...IMPORT_BASE,
      openingBalance: 0,
      closingBalance: 120000,
    });

    expect(h.created).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D3 — UPARIVANJE: fallback po iznosu i zatvaranje (`reconciled_at`)
// ═══════════════════════════════════════════════════════════════════════════════

/** Servis za `matchLines`: komitent se uparuje po žiro računu, otvorene stavke iz registra. */
function makeMatchService(
  openItems: FakeLedger[],
  opts: { saldakontoAccounts?: string[] } = {},
) {
  const statementLines = [
    {
      id: 11,
      lineNo: 1,
      partnerAccount: "205-1234567890-11",
      partnerName: "Metalprodukt d.o.o.",
      amount: new D("120000"),
      direction: "CREDIT",
      referenceNumber: "6572527", // PNB bez separatora → nema kandidata po broju
      matchedCustomerId: null as number | null,
      matchedLedgerEntryId: null as number | null,
      status: "UNMATCHED",
    },
  ];
  const statement = {
    id: 1,
    bankAccount: "160-0000000000000-00",
    statementNumber: "042",
    statementDate: new Date(Date.UTC(2026, 6, 15)),
    status: "IMPORTED",
    currency: "RSD",
    openingBalance: new D(0),
    closingBalance: new D(0),
    lines: statementLines,
  };

  const updates: { where: { id: number }; data: Record<string, unknown> }[] = [];
  const accounts = opts.saldakontoAccounts ?? ["2040", "4350"];

  const prisma = {
    bankStatement: { findUnique: jest.fn(async () => statement) },
    saldakontoAccount: {
      findMany: jest.fn(async () => accounts.map((account) => ({ account }))),
    },
    customer: {
      findMany: jest.fn(async () => [
        {
          id: 4711,
          bankAccount1: "205-1234567890-11",
          bankAccount2: null,
          bankAccount3: null,
        },
      ]),
    },
    ledgerEntry: {
      findMany: jest.fn(
        async (args: {
          where: {
            documentNumber?: { in: string[] };
            debit?: Prisma.Decimal;
            credit?: Prisma.Decimal;
            accountCode?: { in: string[] };
          };
          take?: number;
        }) => {
          const w = args.where ?? {};
          const inRegistry = (e: FakeLedger) =>
            (w.accountCode?.in ?? []).includes("2040") || false;
          if (w.documentNumber?.in) {
            return openItems.filter(
              (e) =>
                inRegistry(e) &&
                e.documentNumber != null &&
                w.documentNumber!.in.includes(e.documentNumber),
            );
          }
          // Fallback po iznosu: pogodak samo na strani koju smer zatvara.
          const hits = openItems.filter((e) => {
            if (!inRegistry(e)) return false;
            if (w.debit != null) return e.debit.equals(w.debit);
            if (w.credit != null) return e.credit.equals(w.credit);
            return false;
          });
          return args.take ? hits.slice(0, args.take) : hits;
        },
      ),
    },
    bankStatementLine: {
      update: jest.fn(
        async (args: { where: { id: number }; data: Record<string, unknown> }) => {
          updates.push(args);
          return args.data;
        },
      ),
    },
  } as unknown as PrismaService;

  const service = new BankStatementService(
    prisma,
    {} as BankStatementParserService,
    {} as ExchangeRateService,
    { get: jest.fn() } as unknown as ModuleRef,
  );
  return { service, updates, prisma };
}

describe("BankStatementService.matchLines — fallback po iznosu (D3)", () => {
  it("(d) DVE otvorene fakture istog iznosa: NE uparuje ni jednu, prijavljuje za ručno", async () => {
    // Pre popravke je fallback bio `findFirst` bez `orderBy` — druga uplata istog iznosa
    // sedala je na već plaćenu januarsku fakturu: nova ostajala 100% otvorena za kamatu i
    // opomenu, stara nosila lažnu preplatu.
    const h = makeMatchService([
      ledger(7001, "12/26", 4711),
      ledger(7002, "657/26", 4711),
    ]);

    const res = (await h.service.matchLines(1)) as unknown as {
      needsManualMatch: { lineNo: number; reason: string; amount: string }[];
    };

    // Komitent JE uparen (žiro se poklapa), ali otvorena stavka NIJE.
    expect(h.updates[0].data.matchedCustomerId).toBe(4711);
    expect(h.updates[0].data.matchedLedgerEntryId).toBeNull();
    expect(res.needsManualMatch).toHaveLength(1);
    expect(res.needsManualMatch[0].lineNo).toBe(1);
    expect(res.needsManualMatch[0].reason).toContain("više otvorenih stavki istog iznosa");
    expect(res.needsManualMatch[0].amount).toBe("120000.00");
  });

  it("JEDINSTVEN pogodak po iznosu se i dalje uparuje (nema regresije)", async () => {
    const h = makeMatchService([
      ledger(7001, "657/26", 4711),
      ledger(7002, "658/26", 4711, null, new D("55000")), // drugi iznos
    ]);

    const res = (await h.service.matchLines(1)) as unknown as {
      needsManualMatch: unknown[];
    };

    expect(h.updates[0].data.matchedLedgerEntryId).toBe(7001);
    expect(res.needsManualMatch).toHaveLength(0);
  });

  it("VEĆ ZATVORENA stavka nije kandidat (to je bio drugi deo kvara)", async () => {
    // Januarska faktura je plaćena; `reconciled_at` je postavljen (v. D3 u knjiženju), pa
    // druga uplata istog iznosa više ne može da sedne na nju.
    const closed = ledger(7001, "12/26", 4711, new Date(Date.UTC(2026, 0, 31)));
    const h = makeMatchService([closed, ledger(7002, "657/26", 4711)]);

    // Lažna baza poštuje `reconciledAt: null` iz `baseWhere` — filtriramo je ovde.
    const prisma = h.prisma as unknown as {
      ledgerEntry: { findMany: jest.Mock };
    };
    const original = prisma.ledgerEntry.findMany;
    prisma.ledgerEntry.findMany = jest.fn(async (args: unknown) => {
      const rows = (await original(args)) as FakeLedger[];
      return rows.filter((r) => r.reconciledAt == null);
    });

    await h.service.matchLines(1);

    expect(h.updates[0].data.matchedLedgerEntryId).toBe(7002);
  });

  it("PRAZAN saldakonto registar se PRIJAVLJUJE (ne uparuje „na slepo“)", async () => {
    const h = makeMatchService([ledger(7001, "657/26", 4711)], {
      saldakontoAccounts: [],
    });
    jest
      .spyOn(h.service["logger"], "warn")
      .mockImplementation(() => undefined); // warn je očekivan, ne treba u izlazu testa

    const res = (await h.service.matchLines(1)) as unknown as {
      needsManualMatch: { reason: string }[];
    };

    expect(h.updates[0].data.matchedLedgerEntryId).toBeNull();
    expect(res.needsManualMatch[0].reason).toContain("saldakonto registar je prazan");
  });
});

describe("BankStatementService.postStatement — zatvaranje uparivanja (D3)", () => {
  it("(e) posle knjiženja uparena stavka IMA reconciled_at", async () => {
    // Pre popravke je na tom mestu bio TODO: plaćena faktura je zauvek ostajala „otvorena",
    // pa je sledeća uplata istog iznosa sedala na nju.
    const invoice = ledger(7001, "657/25", 4711);
    const h = makeService([line({ matchedLedgerEntryId: 7001 })], [invoice]);

    const res = (await h.service.postStatement(1, {
      bankAccountCode: "2410",
    })) as unknown as {
      reconciliation: { closedGroups: number; groupIds: number[]; skipped: unknown[] };
    };

    expect(invoice.reconciledAt).not.toBeNull();
    expect(invoice.reconciliationGroupId).not.toBeNull();
    // I sama uplata je zatvorena u istoj grupi (inače bi ostala kao otvorena preplata).
    const payment = h.ledgerRows.find((r) => r.id === 9001);
    expect(payment?.reconciledAt).not.toBeNull();
    expect(payment?.reconciliationGroupId).toBe(invoice.reconciliationGroupId);

    expect(res.reconciliation.closedGroups).toBe(1);
    expect(res.reconciliation.skipped).toHaveLength(0);
    // Zatvaranje ide kroz POSTOJEĆI servis (ne nov upis nad `reconciled_at`).
    expect(h.autoReconcile).toHaveBeenCalledTimes(1);
    expect(h.reconcileCalls[0].entryIds).toEqual([7001, 9001]);
    expect(h.reconcileCalls[0].note).toContain("Izvod 042");
  });

  it("DELIMIČNA uplata ne zatvara stavku, ali se PRIJAVLJUJE (ne ćuti)", async () => {
    // Faktura 120.000, uplata 50.000: stavka mora ostati otvorena za ostatak duga, a
    // knjigovođa to mora da vidi u odgovoru — tiho hvatanje greške bio bi isti kvar kao D1.
    const invoice = ledger(7001, "657/25", 4711);
    const h = makeService(
      [line({ matchedLedgerEntryId: 7001, amount: new D("50000") })],
      [invoice],
    );

    const res = (await h.service.postStatement(1, {
      bankAccountCode: "2410",
    })) as unknown as {
      reconciliation: {
        closedGroups: number;
        skipped: { statementLineNo: number; reason: string }[];
      };
    };

    expect(invoice.reconciledAt).toBeNull();
    expect(res.reconciliation.closedGroups).toBe(0);
    expect(res.reconciliation.skipped[0].statementLineNo).toBe(1);
    expect(res.reconciliation.skipped[0].reason).toContain("ne balansiraju");
  });

  it("NERASPOREĐENA uplata (bez uparene stavke) se prijavljuje, ne zatvara ništa", async () => {
    const h = makeService([line()], [ledger(7001, "657/25", 4711)]);

    const res = (await h.service.postStatement(1, {
      bankAccountCode: "2410",
    })) as unknown as {
      reconciliation: {
        closedGroups: number;
        skipped: { statementLineNo: number; reason: string }[];
      };
    };

    expect(h.autoReconcile).not.toHaveBeenCalled();
    expect(res.reconciliation.closedGroups).toBe(0);
    expect(res.reconciliation.skipped[0].reason).toContain("neraspoređena");
  });

  it("kontrola salda koja NE ŠTIMA blokira knjiženje (D2 posle uvoza)", async () => {
    // Stanja su uneta (kontrola je „dostupna"), a promet ne daje krajnje stanje — npr.
    // stavka je posle uvoza ručno obrisana. Zeleno je moralo biti crveno i pre popravke.
    const h = makeService([line({ matchedLedgerEntryId: 7001 })], [ledger(7001, "657/25", 4711)], {
      openingBalance: new D("1500"),
      closingBalance: new D("999999"),
    });

    await expect(
      h.service.postStatement(1, { bankAccountCode: "2410" }),
    ).rejects.toThrow(/Kontrola salda ne prolazi/);
    expect(h.autoReconcile).not.toHaveBeenCalled();
  });
});

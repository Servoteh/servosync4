import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ExchangeRateService } from "../izvodi/exchange-rate.service";
import {
  convertSalesLedgerLinesToRsd,
  FakturisanjeService,
} from "./fakturisanje.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * DEVIZNI RAČUN U GLAVNOJ KNJIZI — DINARSKA PROTIVVREDNOST PO SREDNJEM KURSU.
 * =============================================================================
 *
 * ⚠️ IZMEREN KVAR (04.08.2026): `postManualLedger` je u `debit`/`credit` upisivao iznos u
 * VALUTI DOKUMENTA (broj iz `documentVatTotals` nad stavkama — isti koji UBL šalje sa
 * `currencyID="EUR"`), `fx_debit`/`fx_credit`/`fx_currency` nije punio nikad, a
 * `invoice.exchange_rate` nije čitao nigde (0 pogodaka u fajlu). Izvozni račun od
 * **10.000 EUR zaduživao je kupca sa 10.000 RSD**, a nalog je balansirao zato što je
 * balans-kontrola sabirala BAŠ te iste brojeve s obe strane. Red je nosio `currency='EUR'`,
 * ali po pravilu kuće (`gl-write.service.ts` → `normalizeLineFx`) stavka BEZ ijednog
 * deviznog IZNOSA nije devizna — pa je FX revalorizacija (filter `{ fxCurrency }`,
 * `fx-revaluation.service.ts`) tu stavku nije viđala, a otvorena stavka joj nije
 * prikazivala devizni saldo (`open-items.service.ts`).
 *
 * ODLUKA VLASNIKA: **srednji NBS kurs** na datum dokumenta (= datum koji nalog i nosi).
 * Nema kursa → knjiženje PADA; kurs se NIKAD ne pretpostavlja na 1.
 *
 * ZAŠTO OVDE STOJI PRAVI `ExchangeRateService` (a ne mock): tvrdnje (d) i (e) su tvrdnje
 * O RESOLVERU — da nema kursa i da red sa `middleRate = 0` NE VAŽI (guard nulte stope,
 * inače 100 EUR × 0 = 0 RSD prolazi balans-kontrolu kao 0 = 0). Mock resolvera bi
 * testirao mock. Lažna je samo Prisma pod njim, i to tako da poštuje BAŠ te uslove
 * (`currency`, `rateDate <= on`, tražena kolona `> 0`).
 */

const D = (v: string | number) => new Prisma.Decimal(v);

const ACTOR: AuthUser = {
  userId: 7,
  email: "fakturista@servoteh.com",
  role: "racunovodja",
  workerId: null,
};

/** Dan izdavanja računa u svim scenarijima. */
const DOC_DATE = new Date("2026-07-15T00:00:00.000Z");

/** Red kursne liste (samo kolone koje resolver gleda). */
interface RateRow {
  rateDate: Date;
  currency: string;
  buyRate: Prisma.Decimal;
  middleRate: Prisma.Decimal;
  sellRate: Prisma.Decimal;
}

/**
 * Kursna lista za 15.07.2026 sa TRI RAZLIČITE stope: ako se uzme kupovni ili prodajni
 * kurs umesto srednjeg, protivvrednost je drugi broj i test pada. Zato se tip kursa ne
 * proverava špijuniranjem argumenta nego IZMERENIM iznosom.
 */
const RATES_EUR: RateRow[] = [
  {
    rateDate: DOC_DATE,
    currency: "EUR",
    buyRate: D("116.500000"),
    middleRate: D("117.200000"),
    sellRate: D("117.900000"),
  },
];

/** Pravi `ExchangeRateService` nad lažnom Prismom koja poštuje uslove resolvera. */
function exchangeRatesOver(rows: RateRow[]): ExchangeRateService {
  const RATE_FIELDS = ["buyRate", "middleRate", "sellRate"] as const;
  const prisma = {
    exchangeRate: {
      findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
        const where = args.where as {
          currency: string;
          rateDate: { lte: Date };
        } & Partial<Record<(typeof RATE_FIELDS)[number], { gt: number }>>;
        const hit = rows
          .filter((r) => r.currency === where.currency)
          .filter((r) => r.rateDate.getTime() <= where.rateDate.lte.getTime())
          // Guard nulte stope: važi samo red čija je TRAŽENA kolona > 0.
          .filter((r) =>
            RATE_FIELDS.every((f) => {
              const cond = where[f];
              return cond === undefined || r[f].greaterThan(cond.gt);
            }),
          )
          .sort((a, b) => b.rateDate.getTime() - a.rateDate.getTime());
        return Promise.resolve(hit[0] ?? null);
      }),
    },
  };
  return new ExchangeRateService(prisma as never);
}

/** Stavka 8.333,33 po šifri „3" (= 20 %, v. `gl/posting/vat-rates.ts`). */
const ITEM_20 = { vatRateCode: "3", vatBase: D("8333.33") };
/** Stavka 10.000,00 bez PDV-a (izvoz, čl. 24 — šifra se ionako obara na 0 %). */
const ITEM_EXPORT = { vatRateCode: "3", vatBase: D("10000") };

/** Nacrt spreman za knjiženje ručnom granom (bez robnog izlaza). */
function draftInvoice(over: Record<string, unknown> = {}) {
  return {
    id: 300,
    documentType: "IFUSL",
    documentNumber: "DRAFT-300",
    level: 250,
    companyId: 0,
    customerId: 42,
    documentDate: DOC_DATE,
    supplyDate: null,
    dueDate: null,
    currency: "RSD",
    isExport: false,
    status: "DRAFT",
    isLocked: false,
    stockDocumentId: null,
    workOrderId: null,
    journalEntryId: null,
    netTotal: D("100000"),
    vatTotal: D("20000"),
    grossTotal: D("120000"),
    items: [{ vatRateCode: "3", vatBase: D("100000") }],
    ...over,
  };
}

/** Izvozna usluga 10.000 EUR (bez PDV-a, kupac 2050, prihod 6140). */
function eurExportInvoice(over: Record<string, unknown> = {}) {
  return draftInvoice({
    documentType: "IZVUS",
    currency: "EUR",
    isExport: true,
    netTotal: D("10000"),
    vatTotal: D("0"),
    grossTotal: D("10000"),
    items: [ITEM_EXPORT],
    ...over,
  });
}

/** Domaća usluga fakturisana u EUR (valutna klauzula): ima i PDV liniju. */
function eurDomesticInvoice(over: Record<string, unknown> = {}) {
  return draftInvoice({
    currency: "EUR",
    isExport: false,
    netTotal: D("8333.33"),
    vatTotal: D("1666.67"),
    grossTotal: D("10000"),
    items: [ITEM_20],
    ...over,
  });
}

interface WrittenLine {
  accountCode: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  currency: string;
  fxDebit?: Prisma.Decimal | null;
  fxCredit?: Prisma.Decimal | null;
  fxCurrency?: string | null;
}

function makeHarness(opts: {
  invoice?: Record<string, unknown>;
  rates?: RateRow[];
  /** Kreditni limit kupca u DINARIMA (`null` = bez kontrole). */
  creditLimit?: Prisma.Decimal | null;
  /** Zatečeni dinarski saldo kupca iz `ledger_entries`. */
  customerBalance?: Prisma.Decimal;
}) {
  const invoice = opts.invoice ?? draftInvoice();
  const createdEntries: Record<string, unknown>[] = [];

  const client = {
    invoice: {
      findUnique: jest.fn().mockResolvedValue(invoice),
      findUniqueOrThrow: jest.fn().mockResolvedValue(invoice),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...invoice, ...data }),
        ),
    },
    customer: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ creditLimit: opts.creditLimit ?? null }),
    },
    // Zatečeni dinarski saldo kupca (agregat nad `ledger_entries`) — kreditni limit.
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ balance: opts.customerBalance ?? D(0) }]),
    invoiceItem: { findMany: jest.fn().mockResolvedValue(invoice.items) },
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          createdEntries.push(data);
          return Promise.resolve({ id: 900 });
        }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    ...client,
    $transaction: jest.fn((cb: (tx: typeof client) => unknown) => cb(client)),
  };

  const numbering = { next: jest.fn().mockResolvedValue("657/26") };
  const exchangeRates = exchangeRatesOver(opts.rates ?? RATES_EUR);
  const resolveSpy = jest.spyOn(exchangeRates, "resolve");
  const service = new FakturisanjeService(
    prisma as never,
    {} as never, // pricing
    numbering,
    {} as never, // posting
    { reverse: jest.fn(), reverseWithin: jest.fn() } as never,
    {} as never, // sef
    {} as never, // reservation
    exchangeRates,
  );

  /** Linije naloga koje bi otišle u bazu (`journalEntry.create`). */
  const writtenLines = (): WrittenLine[] =>
    (createdEntries[0]?.lines as { create: WrittenLine[] } | undefined)
      ?.create ?? [];

  return { service, prisma, numbering, resolveSpy, writtenLines };
}

/** Σ jedne strane linija naloga. */
function sumSide(
  lines: ReadonlyArray<WrittenLine>,
  side: "debit" | "credit",
): Prisma.Decimal {
  return lines.reduce((s, l) => s.add(l[side]), new Prisma.Decimal(0));
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) + (b) Devizni račun: dinari po srednjem kursu, devizni par u fx kolonama
// ─────────────────────────────────────────────────────────────────────────────

describe("postInvoice — devizni račun se u GK knjiži u DINARIMA", () => {
  it("10.000 EUR uz srednji kurs 117,20 → kupac DUG 1.172.000,00 i fxDebit 10.000,00", async () => {
    // Ovo je ceo kvar u jednom broju: pre ispravke je na kontu 2050 stajalo `10000`
    // (deset hiljada DINARA za fakturu od deset hiljada EVRA), bez ijednog deviznog
    // iznosa — pa ni revalorizacija ni devizni saldo otvorene stavke nisu imali šta da
    // vide, a kupčev dug u dinarima je bio 117 puta manji od stvarnog.
    const h = makeHarness({ invoice: eurExportInvoice() });

    await h.service.postInvoice(300, ACTOR);

    const lines = h.writtenLines();
    expect(lines.map((l) => l.accountCode)).toEqual(["2050", "6140"]);

    const kupac = lines[0];
    expect(kupac.debit.toFixed(4)).toBe("1172000.0000");
    expect(kupac.fxDebit?.toFixed(2)).toBe("10000.00");
    expect(kupac.fxCredit ?? null).toBeNull();
    expect(kupac.fxCurrency).toBe("EUR");
    // `currency` na stavci ostaje (nije zamena za devizni iznos, v. uvod fajla).
    expect(kupac.currency).toBe("EUR");

    // Prihod ide istom protivvrednošću, sa deviznim parom na POTRAŽNOJ strani.
    const prihod = lines[1];
    expect(prihod.credit.toFixed(4)).toBe("1172000.0000");
    expect(prihod.fxCredit?.toFixed(2)).toBe("10000.00");
    expect(prihod.fxDebit ?? null).toBeNull();
  });

  it("nalog balansira i u dinarima i u valuti (PDV linija uključena)", async () => {
    // Balans-kontrola je pre ispravke merila devizne iznose s obe strane, pa je „nalog
    // balansira" bila tvrdnja o EVRIMA, a u bazu su išli isti brojevi kao DINARI.
    const h = makeHarness({ invoice: eurDomesticInvoice() });

    await h.service.postInvoice(300, ACTOR);

    const lines = h.writtenLines();
    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6140", "4702"]);

    // DINARSKA strana — ono što se stvarno upisuje.
    expect(sumSide(lines, "debit").toFixed(4)).toBe(
      sumSide(lines, "credit").toFixed(4),
    );
    expect(sumSide(lines, "debit").toFixed(4)).toBe("1172000.0000");
    // 8.333,33 × 117,20 = 976.666,276  |  1.666,67 × 117,20 = 195.333,724
    expect(lines[1].credit.toFixed(4)).toBe("976666.2760");
    expect(lines[2].credit.toFixed(4)).toBe("195333.7240");

    // DEVIZNA strana — original, nezaokružen, i takođe u balansu.
    const fx = lines.map((l) => ({
      debit: l.fxDebit ?? new Prisma.Decimal(0),
      credit: l.fxCredit ?? new Prisma.Decimal(0),
      accountCode: l.accountCode,
      currency: l.currency,
    }));
    expect(sumSide(fx as never, "debit").toFixed(2)).toBe("10000.00");
    expect(sumSide(fx as never, "credit").toFixed(2)).toBe("10000.00");
    expect(lines.every((l) => l.fxCurrency === "EUR")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) DOMAĆI PROMET (99 % dokumenata) — ni jedan bajt drugačije
// ─────────────────────────────────────────────────────────────────────────────

describe("postInvoice — RSD račun je nepromenjen", () => {
  it("kurs se NE traži i fx kolone se NE upisuju (nema ni ključa u upisu)", async () => {
    const h = makeHarness({ invoice: draftInvoice() });

    await h.service.postInvoice(300, ACTOR);

    // Resolver se ne zove ni jednom: domaći promet ne zavisi od kursne liste. (Da se
    // zove, jedan dan bez unete liste bi zaustavio celo fakturisanje.)
    expect(h.resolveSpy).not.toHaveBeenCalled();

    const lines = h.writtenLines();
    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6140", "4702"]);
    expect(lines[0].debit.toFixed(4)).toBe("120000.0000");
    // Ne „null" nego BEZ KLJUČA — upis je identičan onom pre ispravke.
    for (const l of lines) {
      expect(l).not.toHaveProperty("fxDebit");
      expect(l).not.toHaveProperty("fxCredit");
      expect(l).not.toHaveProperty("fxCurrency");
      expect(l.currency).toBe("RSD");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) + (e) BEZ KURSA SE NE KNJIŽI — kurs se ne pretpostavlja na 1
// ─────────────────────────────────────────────────────────────────────────────

describe("postInvoice — devizni račun bez kursa PADA", () => {
  it("nema kursne liste za taj dan → 422 koji imenuje valutu i datum, bez ijednog upisa", async () => {
    const h = makeHarness({ invoice: eurExportInvoice(), rates: [] });

    const err = await h.service.postInvoice(300, ACTOR).catch((e: Error) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toMatch(/EUR/);
    expect((err as Error).message).toMatch(/2026-07-15/);
    expect((err as Error).message).toMatch(/srednjeg kursa/);

    // NIJEDAN red: ni nalog, ni CAS claim, ni potrošen broj dokumenta.
    expect(h.prisma.journalEntry.create).not.toHaveBeenCalled();
    expect(h.prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.invoice.update).not.toHaveBeenCalled();
    expect(h.numbering.next).not.toHaveBeenCalled();
  });

  it("red postoji ali je srednji kurs 0 → isto pada (guard nulte stope)", async () => {
    // Bez guarda: 10.000 EUR × 0 = 0 RSD na obe strane, nalog „balansira" (0 = 0), a
    // faktura završi u glavnoj knjizi kao da je vredna ništa.
    const h = makeHarness({
      invoice: eurExportInvoice(),
      rates: [
        {
          rateDate: DOC_DATE,
          currency: "EUR",
          buyRate: D("116.5"),
          middleRate: D("0"), // nije uneta srednja kolona
          sellRate: D("117.9"),
        },
      ],
    });

    const err = await h.service.postInvoice(300, ACTOR).catch((e: Error) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toMatch(/EUR/);
    expect(h.prisma.journalEntry.create).not.toHaveBeenCalled();
    expect(h.numbering.next).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KREDITNI LIMIT — meri se u DINARIMA, jer su limit i saldo dinarski
// ─────────────────────────────────────────────────────────────────────────────

describe("postInvoice — kreditni limit devizne fakture", () => {
  it("10.000 EUR nasuprot limita od 500.000 RSD → brana pada (pre ispravke je prolazilo)", async () => {
    // ⚠️ IZMERENO: `assertCreditLimit` poredi bruto u VALUTI DOKUMENTA sa `creditLimit`
    // kupca i sa saldom iz `ledger_entries` — a to su dinari. Faktura od 10.000 EUR je
    // limit trošila kao 10.000 RSD, pa je kupac sa limitom od 500.000 RSD mogao da
    // nakupi 4.270.000 RSD izloženosti bez jednog jedinog 422.
    const h = makeHarness({
      invoice: eurExportInvoice(),
      creditLimit: D("500000"),
      customerBalance: D("0"),
    });

    const err = await h.service.postInvoice(300, ACTOR).catch((e: Error) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({
      code: "CREDIT_LIMIT_EXCEEDED",
      // Dinarska protivvrednost, ne 10.000: 10.000 × 117,20.
      amount: "1172000.00",
      projected: "1172000.00",
    });
    expect(h.prisma.journalEntry.create).not.toHaveBeenCalled();
  });

  it("ista faktura ispod limita se knjiži (brana ne postaje prepreka)", async () => {
    const h = makeHarness({
      invoice: eurExportInvoice(),
      creditLimit: D("2000000"),
    });

    await h.service.postInvoice(300, ACTOR);

    expect(h.writtenLines()[0].debit.toFixed(4)).toBe("1172000.0000");
  });

  it("RSD faktura: limit se meri unetim bruto iznosom, bez kursa", async () => {
    const h = makeHarness({
      invoice: draftInvoice(),
      creditLimit: D("500000"),
    });

    await h.service.postInvoice(300, ACTOR);

    expect(h.resolveSpy).not.toHaveBeenCalled();
    expect(h.writtenLines()[0].debit.toFixed(4)).toBe("120000.0000");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RAZLIKA ZAOKRUŽIVANJA — kolona nosi 4 decimale, proizvod ih ima do 8
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ISTA BRANA, DRUGI ULAZ — KREIRANJE PREDRAČUNA (nalaz pri pregledu diff-a, 04.08.2026).
 * =============================================================================
 * Konverzija u dinare je prvo bila napisana NA POZIVAOCU (`postInvoice`), a drugi pozivalac
 * — `createProforma` — ju je izostavio. Predračun sme biti u EUR (`createProforma`
 * podrazumeva EUR kad je `isExport`), pa je EUR predračun trošio DINARSKI limit: kupac sa
 * limitom od 500.000 RSD prolazio je sa predračunom od 10.000 EUR (≈ 1,17 mil. RSD).
 *
 * Zato je konverzija PREMEŠTENA U SAMU BRANU (`assertCreditLimit` prima valutu dokumenta i
 * sam razrešava kurs) — četvrti pozivalac je ne može zaboraviti. Ovaj test čuva baš to.
 */
describe("assertCreditLimit — konverzija je U BRANI, ne na pozivaocu", () => {
  /**
   * Zove se PRIVATNA brana (obrazac `callGuard` iz `robno/robno.service.spec.ts`), a ne
   * `createProforma`, i to namerno: invarijanta koja se meri je „brana sama zna svoju
   * valutu", i ona mora važiti za SVAKI ulaz — uključujući i one koji još ne postoje.
   * Test kroz `createProforma` bi merio i ceo put cena/numeracije, pa bi pao iz deset
   * razloga koji sa ovim nalazom nemaju veze.
   */
  /** Dokument iz koga brana izvodi valutu — imenovan tip, ne `typeof doc`. */
  interface LimitDoc {
    currency?: string | null;
    documentDate?: Date | null;
    documentNumber?: string | null;
  }

  function callLimit(
    service: FakturisanjeService,
    grossTotal: Prisma.Decimal,
    doc: LimitDoc,
  ): Promise<void> {
    return (
      service as unknown as {
        assertCreditLimit: (
          customerId: number,
          grossTotal: Prisma.Decimal,
          force: boolean,
          doc: LimitDoc,
        ) => Promise<void>;
      }
    ).assertCreditLimit(5, grossTotal, false, doc);
  }

  it("EUR iznos 10.000 nasuprot limita 500.000 RSD → 422 sa dinarskom protivvrednošću", async () => {
    const h = makeHarness({ creditLimit: D("500000"), customerBalance: D("0") });

    const err = await callLimit(h.service, D("10000"), {
      currency: "EUR",
      documentDate: DOC_DATE,
      documentNumber: "DRAFT-300",
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({
      code: "CREDIT_LIMIT_EXCEEDED",
      // 10.000 × 117,20 — a ne 10.000, kako je merila pre ispravke.
      amount: "1172000.00",
    });
  });

  it("isti EUR iznos prolazi kad je limit dovoljan (brana ne postaje prepreka)", async () => {
    const h = makeHarness({ creditLimit: D("2000000"), customerBalance: D("0") });
    await expect(
      callLimit(h.service, D("10000"), {
        currency: "EUR",
        documentDate: DOC_DATE,
        documentNumber: "DRAFT-300",
      }),
    ).resolves.toBeUndefined();
  });

  it("kupac BEZ limita ne traži kurs — neuneta kursna lista ga NE blokira", async () => {
    // Kurs se razrešava TEK POSLE izlaza „nema limita": inače bi kupac bez limita bio
    // blokiran zbog podatka koji se u njegovom slučaju ni sa čim ne poredi.
    const h = makeHarness({ creditLimit: null, rates: [] });
    await expect(
      callLimit(h.service, D("10000"), {
        currency: "EUR",
        documentDate: DOC_DATE,
        documentNumber: "DRAFT-300",
      }),
    ).resolves.toBeUndefined();
  });

  it("kupac SA limitom i devizni iznos BEZ kursa → pada, ne propušta se nemereno", async () => {
    const h = makeHarness({ creditLimit: D("500000"), rates: [] });
    await expect(
      callLimit(h.service, D("10000"), {
        currency: "EUR",
        documentDate: DOC_DATE,
        documentNumber: "DRAFT-300",
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("RSD iznos se meri kako je unet i resolver se ne zove", async () => {
    const h = makeHarness({ creditLimit: D("500000"), customerBalance: D("0") });
    await expect(
      callLimit(h.service, D("120000"), { currency: "RSD", documentDate: DOC_DATE }),
    ).resolves.toBeUndefined();
    // 120.000 < 500.000 → prolazi; da je bilo konverzije, bilo bi 14 miliona i padalo bi.
  });
});

describe("convertSalesLedgerLinesToRsd — dinarska strana MORA da balansira", () => {
  it("razlika zaokruživanja sedne na najveću potražnu liniju, kupac i PDV ostaju tačni", () => {
    // Konstruisano: kurs sa 5. decimalom = 5 obara nezavisno zaokruživanje po redu.
    //   3 × 1,00005 = 3,00015 → 3,0002        (dugovna strana)
    //   1 × 1,00005 = 1,00005 → 1,0001  × 3   = 3,0003  (potražna strana)
    // Razlika −0,0001 ide na prvu najveću potražnu liniju; bez toga nalog ne balansira
    // i knjiženje pada na balans-kontroli.
    const lines = convertSalesLedgerLinesToRsd(
      [
        {
          accountCode: "2040",
          analyticalCode: 42,
          debit: D(3),
          credit: D(0),
          description: "Kupac",
        },
        {
          accountCode: "6140",
          analyticalCode: null,
          debit: D(0),
          credit: D(1),
          description: "Prihod",
        },
        {
          accountCode: "4702",
          analyticalCode: null,
          debit: D(0),
          credit: D(1),
          description: "PDV 20%",
        },
        {
          accountCode: "4710",
          analyticalCode: null,
          debit: D(0),
          credit: D(1),
          description: "PDV 10%",
        },
      ],
      D("1.00005"),
      "EUR",
    );

    const debit = lines.reduce((s, l) => s.add(l.debit), D(0));
    const credit = lines.reduce((s, l) => s.add(l.credit), D(0));
    expect(debit.toFixed(4)).toBe(credit.toFixed(4));
    // Kupčev dug ostaje TAČNO round4(iznos × kurs) — njega čitaju saldakonti.
    expect(lines[0].debit.toFixed(4)).toBe("3.0002");
    // Razliku nosi prihod, ne PDV (POPDV osnovicu izvodi iz PDV konta deljenjem stopom).
    expect(lines[1].credit.toFixed(4)).toBe("1.0000");
    expect(lines[2].credit.toFixed(4)).toBe("1.0001");
    expect(lines[3].credit.toFixed(4)).toBe("1.0001");
    // Devizni original je nezaokružen i uvek na strani dinarskog iznosa.
    expect(lines[0].fxDebit?.toFixed(2)).toBe("3.00");
    expect(lines[0].fxCredit).toBeNull();
    expect(lines[1].fxCredit?.toFixed(2)).toBe("1.00");
    expect(lines.every((l) => l.fxCurrency === "EUR")).toBe(true);
  });
});

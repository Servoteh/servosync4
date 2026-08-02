import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  KNOWN_VAT_CODES,
  VAT_PERCENT_BY_CODE,
  VAT_RATE_BY_CODE,
} from "../gl/posting/vat-rates";
import { PostingEngineService } from "../gl/posting/posting.service";
import { CalculationService } from "../robno/calculation.service";
import { RobnoService } from "../robno/robno.service";
import { ItemsService } from "../masters/items.service";
import { DocumentNumberSequenceService } from "./numbering.service";
import { AdvanceInvoiceService } from "./advance-invoice.service";
import {
  validateCreateInvoiceItem,
  validateUpdateInvoiceItem,
} from "./dto/update-invoice.dto";
import { documentVatTotals } from "./vat-totals";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * JEDNA MAPA PORESKIH STOPA ZA CEO SISTEM (nalazi V1, V2, S3 — sedmi krug, 02.08.2026).
 * =============================================================================
 * SVI TESTOVI ISPOD PADAJU NA KODU OD PRE OVE ISPRAVKE.
 *
 * Ispravka mape (`2eb53bcd`) je pogodila `gl/posting/vat-rates.ts`, ali NE i dva
 * PREPISA koja su živela mimo nje:
 *
 *   V1 · `sales/advance-invoice.service.ts` — svoj `VAT_PERCENT_BY_CODE`
 *        („1”→20, „2”→10, „4”→8, bez „5”/„6”). Posledica je bila DVA POREZA NA ISTI
 *        PROMET: predračun po ispravljenoj mapi, avans po njemu — po staroj.
 *   V2 · `sales/dto/update-invoice.dto.ts` — svoj `KNOWN_VAT_CODES` ({0,1,2,3,4}).
 *        Gejt je primao „2” (koja u `R_Tarife` ne postoji) → `VAT_RATE_BY_CODE["2"]`
 *        je `undefined` → stavka tiho na 0 % PDV. Rupa je bila NOVA: pre ispravke
 *        mape je „2” značila 10 %. Istovremeno je odbijao legitimne „5” i „6”.
 *   S3 · Nepoznata šifra je davala TIHU NULU na četiri mesta koja rade novac
 *        (cena, glavna knjiga, kalkulacija, cena na polici), dok je ulaz bio otvoren:
 *        provera tarife artikla je bila vezana za PRAZNU tabelu `tax_rates`.
 *
 * ⚠️ SVI TESTOVI KOJI NABRAJAJU ŠIFRE IH ČITAJU IZ `VAT_RATE_BY_CODE`, ne iz literala.
 * To je i poenta paketa: kad se mapa sledeći put dopuni ili ispravi, testovi se pomere
 * SA njom — a svaki prepis koji ne prati mapu padne isti čas.
 */

const D = Prisma.Decimal;

/** Šifre koje mapa ZNA — izvor za sve „mora da prođe” provere. */
const POZNATE = [...KNOWN_VAT_CODES];

/**
 * Šifre koje mapa NE zna. „2” je ključna: nikad nije postojala u `R_Tarife`, a oba
 * prepisa su je nosila. „15”/„18” su istekle tarife koje i dalje žive u BigBit
 * podacima; „99” je čista greška u unosu.
 */
const NEPOZNATE = ["2", "15", "18", "99", "x"].filter(
  (c) => !KNOWN_VAT_CODES.has(c),
);

// ═══════════════════════════════════════════════ 0 · IZVEDENICE SE NE MOGU RAZIĆI

describe("0 · spisak i procenti su IZVEDENI iz `VAT_RATE_BY_CODE`", () => {
  it("`KNOWN_VAT_CODES` ima tačno ključeve mape — ni jedan više, ni jedan manje", () => {
    expect([...KNOWN_VAT_CODES].sort()).toEqual(
      Object.keys(VAT_RATE_BY_CODE).sort(),
    );
  });

  it("`VAT_PERCENT_BY_CODE` je ista mapa × 100 (ne drugi katalog)", () => {
    expect(Object.keys(VAT_PERCENT_BY_CODE).sort()).toEqual(
      Object.keys(VAT_RATE_BY_CODE).sort(),
    );
    for (const code of POZNATE) {
      expect(VAT_PERCENT_BY_CODE[code]).toBe(
        VAT_RATE_BY_CODE[code].mul(100).toNumber(),
      );
    }
  });

  it("„2” nije nigde — ni u mapi, ni u spisku, ni u procentima", () => {
    // Ova šifra je bila u OBA prepisa i ni u jednom izvoru podataka.
    expect(VAT_RATE_BY_CODE["2"]).toBeUndefined();
    expect(KNOWN_VAT_CODES.has("2")).toBe(false);
    expect(VAT_PERCENT_BY_CODE["2"]).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════ V2 · GEJT ŠIFARA NA STAVKAMA

describe("V2 · gejt stavke prodaje prima tačno ono što mapa zna", () => {
  const stavka = (code: string) => ({
    itemId: 1,
    quantity: 1,
    vatRateCode: code,
  });

  it.each(POZNATE)("šifra „%s” (poznata mapi) PROLAZI kroz `addItem`", (code) => {
    // Staro: „5” (POLJO 8 %) i „6” (bezcarinska zona 20 %) su odbijane — legitimne
    // šifre se nisu mogle uneti ni na jedan način.
    expect(validateCreateInvoiceItem(stavka(code)).vatRateCode).toBe(code);
  });

  it.each(POZNATE)("šifra „%s” PROLAZI i kroz `updateItem`", (code) => {
    expect(validateUpdateInvoiceItem({ vatRateCode: code }).vatRateCode).toBe(
      code,
    );
  });

  it.each(NEPOZNATE)("šifra „%s” (nepoznata mapi) SE ODBIJA", (code) => {
    // Staro: „2” je prolazila, a `VAT_RATE_BY_CODE["2"]` je `undefined` → stavka je
    // tiho išla na 0 % PDV. `assertTotalsMatchItems` to ne hvata: i zaglavlje i stavke
    // se slože — na nuli.
    expect(() => validateCreateInvoiceItem(stavka(code))).toThrow(
      BadRequestException,
    );
    expect(() => validateUpdateInvoiceItem({ vatRateCode: code })).toThrow(
      BadRequestException,
    );
  });

  it("poruka nabraja dozvoljene šifre IZ MAPE (ne iz literala u poruci)", () => {
    try {
      validateCreateInvoiceItem(stavka("2"));
      throw new Error("gejt nije reagovao");
    } catch (e) {
      const msg = JSON.stringify((e as BadRequestException).getResponse());
      // Staro: „dozvoljeno: 0, 1, 2, 3, 4” — spisak zakucan u tekstu poruke.
      for (const code of POZNATE) expect(msg).toContain(`${code}`);
      expect(msg).toContain("2");
    }
  });

  /**
   * NAJVAŽNIJI TEST PAKETA — brana koja pada kad se mapa promeni a spisak ne.
   * Svaka šifra koju gejt propusti MORA imati stopu, jer posle gejta nema više
   * nijedne provere: `PricingService` bi je video kao 0 %.
   */
  it("nijedna propuštena šifra ne može da ostane bez stope", () => {
    for (const code of POZNATE) {
      expect(VAT_RATE_BY_CODE[code]).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════ V1 · AVANSNI RAČUN

describe("V1 · avans računa po ISTOJ mapi kao predračun po kome je izdat", () => {
  let service: AdvanceInvoiceService;
  let prisma: {
    invoice: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
    };
    customer: { findUnique: jest.Mock };
    $executeRaw: jest.Mock;
    $transaction: jest.Mock;
  };

  /** Poslednji `invoice.create` — zaglavlje avansa kakvo bi otišlo u bazu. */
  function createdAdvance(): Record<string, Prisma.Decimal> {
    return prisma.invoice.create.mock.calls[0][0].data;
  }

  beforeEach(async () => {
    prisma = {
      invoice: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn((args: { data: unknown }) => ({
          id: 50,
          ...(args.data as Record<string, unknown>),
          items: [],
        })),
      },
      customer: {
        findUnique: jest.fn().mockResolvedValue({ id: 5, name: "Kupac" }),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((arg: unknown) =>
      (arg as (tx: unknown) => unknown)(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdvanceInvoiceService,
        { provide: PrismaService, useValue: prisma },
        { provide: PostingEngineService, useValue: { postManualEntry: jest.fn() } },
        {
          provide: DocumentNumberSequenceService,
          useValue: { next: jest.fn().mockResolvedValue("A-1/26") },
        },
      ],
    }).compile();
    service = module.get(AdvanceInvoiceService);
  });

  const actor: AuthUser = {
    userId: 7,
    email: "knjigovodja@servoteh",
    role: "racunovodja",
    workerId: null,
  };

  function proforma(vatRateCode: string, net: string, gross: string) {
    return {
      id: 10,
      documentType: "PROF",
      documentNumber: "12/26",
      level: 250,
      status: "DRAFT",
      companyId: 0,
      customerId: 5,
      documentDate: new Date("2026-08-01T00:00:00Z"),
      dueDate: null,
      currency: "RSD",
      exchangeRate: new D(1),
      accountingExchangeRate: new D(1),
      isExport: false,
      netTotal: new D(net),
      vatTotal: new D(gross).sub(new D(net)),
      grossTotal: new D(gross),
      poNumber: null,
      salespersonId: null,
      items: [{ vatRateCode, vatBase: new D(net) }],
    };
  }

  /**
   * ULAZ KOJI POSTOJI DANAS NA PRODUKCIJI: artikal `id=12852` (`DPTR10-04612`) je
   * JEDINI sa šifrom „4” (izmereno 02.08.2026, 1 od 92.575). Predračun sa njim
   * računa 10 % (ispravljena mapa), a avans je računao 8 % (prepis) — dva različita
   * poreza na isti promet, i to na dokumentima koji jedan drugog citiraju.
   */
  it("šifra „4” (NIZA): avans nosi 10 %, isto kao predračun — ne 8 %", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      proforma("4", "10000.00", "11000.00"),
    );

    await service.createAdvanceInvoice({ proformaId: 10 }, actor);

    const avr = createdAdvance();
    // Staro (8 %): osnovica 10.185,19 + PDV 814,81.
    expect(avr.netTotal.toFixed(2)).toBe("10000.00");
    expect(avr.vatTotal.toFixed(2)).toBe("1000.00");
    expect(avr.grossTotal.toFixed(2)).toBe("11000.00");
  });

  it("avans i predračun se slažu do na paru (zbirovi iz iste mape)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      proforma("4", "10000.00", "11000.00"),
    );
    await service.createAdvanceInvoice({ proformaId: 10 }, actor);

    // Isti promet, dva računara: `documentVatTotals` (predračun) i `grossToNet`
    // (avans). Dok su čitali dve mape, razlika je bila 185,19 na 11.000.
    const predracun = documentVatTotals([
      { vatRateCode: "4", vatBase: new D("10000.00") },
    ]);
    expect(createdAdvance().vatTotal.toFixed(2)).toBe(
      predracun.vatTotal.toFixed(2),
    );
  });

  /**
   * NAJTEŽI SLUČAJ: šifra „1” je BEZPDV (0 %), a prepis ju je držao kao „alt kod za
   * osnovnu” → 20 %. Avans bi tako NAPLATIO 20 % poreza na promet koji je oslobođen,
   * i to iz bruta koji je kupac stvarno uplatio.
   */
  it("šifra „1” (BEZPDV): avans je 0 % — ne 20 % na oslobođen promet", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      proforma("1", "10000.00", "10000.00"),
    );

    await service.createAdvanceInvoice({ proformaId: 10 }, actor);

    const avr = createdAdvance();
    // Staro (20 %): osnovica 8.333,33 + PDV 1.666,67 — poreska obaveza niotkuda.
    expect(avr.netTotal.toFixed(2)).toBe("10000.00");
    expect(avr.vatTotal.toFixed(2)).toBe("0.00");
  });

  it.each(POZNATE)(
    "avans po ugovoru PRIMA šifru „%s” (poznata mapi)",
    async (code) => {
      // Staro: „5” i „6” su odbijane sa 422 — a to su legitimne tarife.
      await expect(
        service.createAdvanceInvoice(
          {
            customerId: 5,
            amount: "12000",
            basis: "Ugovor 1/26",
            vatRateCode: code,
          },
          actor,
        ),
      ).resolves.toBeDefined();
    },
  );

  it("avans po ugovoru ODBIJA „2” (šifre nema u `R_Tarife`)", async () => {
    // Staro: prolazila je i računala 10 % — porez po stopi koja ne postoji.
    await expect(
      service.createAdvanceInvoice(
        {
          customerId: 5,
          amount: "12000",
          basis: "Ugovor 1/26",
          vatRateCode: "2",
        },
        actor,
      ),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it("nepoznata šifra NA STAVCI predračuna se odbija (ne daje tihih 20 %)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      proforma("18", "10000.00", "11800.00"),
    );

    // Staro: `VAT_PERCENT_BY_CODE[code] ?? 20` — istekla tarifa „18” iz BigBita bi
    // tiho dala 20 % preračunate stope. Tiha DVADESETKA je gora od tihe nule:
    // ne može se prepoznati kao izostanak, izgleda kao ispravan avans.
    await expect(
      service.createAdvanceInvoice({ proformaId: 10 }, actor),
    ).rejects.toThrow(UnprocessableEntityException);
  });
});

// ═════════════════════════════════ S3 · GLASNO TAMO GDE JE NOVAC, KNJIGA I CENA

describe("S3 · nepoznata šifra pada glasno u glavnoj knjizi", () => {
  /** `aggregateDocAmounts` je privatna — zove se direktno, bez lažiranja cele šeme. */
  type Aggregator = {
    aggregateDocAmounts(
      doc: { isImport: boolean; documentTypeCode: string },
      items: Array<Record<string, unknown>>,
      isInbound: boolean,
    ): unknown;
  };

  const stavka = (goodsTaxRateCode: string) => ({
    quantity: new D(1),
    purchasePriceNet: new D(100),
    dependentCostOwn: new D(0),
    dependentCostSupplier: new D(0),
    calculatedWholesalePrice: new D(120),
    actualWholesalePrice: new D(120),
    fee: new D(0),
    goodsTaxRateCode,
  });

  function engine(): Aggregator {
    return new PostingEngineService(
      {} as unknown as PrismaService,
    ) as unknown as Aggregator;
  }

  it.each(POZNATE)("šifra „%s” se agregira bez greške", (code) => {
    expect(() =>
      engine().aggregateDocAmounts(
        { isImport: false, documentTypeCode: "UFROB" },
        [stavka(code)],
        true,
      ),
    ).not.toThrow();
  });

  it("nepoznata šifra → 422, a ne nalog BEZ PDV LINIJE", () => {
    // Staro: `?? ZERO` — nemo. Nalog bi pritom BALANSIRAO (PDV kofe su nula na obe
    // strane), pa ga ni kontrola ΣDug==ΣPot ne bi zaustavila; greška bi izašla tek
    // u POPDV obrascu, mesecima kasnije.
    expect(() =>
      engine().aggregateDocAmounts(
        { isImport: false, documentTypeCode: "UFROB" },
        [stavka("18")],
        true,
      ),
    ).toThrow(UnprocessableEntityException);
  });
});

describe("S3 · nepoznata šifra pada glasno u kalkulaciji (cena na polici)", () => {
  type RateResolver = {
    taxRateOf(
      tx: unknown,
      goodsTaxRateCode: string,
      asOf: Date,
    ): Promise<Prisma.Decimal>;
  };

  /** `tax_rates` je na produkciji PRAZNA (N1-a) — upit uvek promaši. */
  const tx = { taxRate: { findFirst: jest.fn().mockResolvedValue(null) } };

  function calc(): RateResolver {
    return new CalculationService(
      {} as unknown as PrismaService,
    ) as unknown as RateResolver;
  }

  it("poznata šifra „4” daje 10 % iz mape (registar je prazan)", async () => {
    const pct = await calc().taxRateOf(tx, "4", new Date("2026-08-01"));
    expect(pct.toFixed(2)).toBe("10.00");
  });

  it("nepoznata šifra → 422, a ne maloprodajna cena BEZ PDV-a", async () => {
    // Staro: `?? ZERO` → `KalkMP = Taksa + FiksniPorez + KalkVP × (1 + 0/100)`,
    // dakle cena na polici bez poreza — i to upisana kao ispravna.
    await expect(
      calc().taxRateOf(tx, "99", new Date("2026-08-01")),
    ).rejects.toThrow(UnprocessableEntityException);
  });
});

describe("S3 · ulaz je zatvoren — šifra se proverava PRE upisa", () => {
  type ItemBuilder = {
    buildItemData(
      it: Record<string, unknown>,
      headerWarehouseId: number,
      idx: number,
    ): unknown;
  };

  function robno(): ItemBuilder {
    return new RobnoService(
      {} as unknown as PrismaService,
      {} as never,
      {} as never,
    ) as unknown as ItemBuilder;
  }

  it("robni dokument: stavka sa nepoznatom šifrom se odbija na UNOSU", () => {
    // `CreateStockDocumentItemDto` je INTERFEJS bez `class-validator` dekoratora, pa
    // ga globalni `ValidationPipe` uopšte ne gleda — do ove izmene je „99” ulazila
    // nepregledana i ćutala tek na kalkulaciji i knjiženju.
    expect(() =>
      robno().buildItemData(
        { itemId: 1, quantity: 1, goodsTaxRateCode: "99" },
        1,
        0,
      ),
    ).toThrow(UnprocessableEntityException);
  });

  it.each(POZNATE)("robni dokument prima poznatu šifru „%s”", (code) => {
    expect(() =>
      robno().buildItemData(
        { itemId: 1, quantity: 1, goodsTaxRateCode: code },
        1,
        0,
      ),
    ).not.toThrow();
  });

  it("šifarnik artikala odbija nepoznatu tarifu i kad je `tax_rates` PRAZNA", async () => {
    // Staro: `const total = await this.prisma.taxRate.count(); if (total === 0) continue;`
    // Tabela na produkciji ima 0 redova (N1-a), pa je provera bila POTPUNO isključena —
    // artikal je mogao da dobije šifru „18” i da je onda nosi u svaki dokument.
    const prisma = {
      taxRate: { count: jest.fn().mockResolvedValue(0), findFirst: jest.fn() },
    };
    const items = new ItemsService(
      prisma as unknown as PrismaService,
    ) as unknown as {
      assertCodebookRefs(dto: unknown, existing: unknown): Promise<void>;
    };

    await expect(
      items.assertCodebookRefs({ goodsTaxRateCode: "18" }, null),
    ).rejects.toThrow(BadRequestException);
    // Poznata šifra prolazi i sa praznim registrom (inače bi unos artikala stao).
    await expect(
      items.assertCodebookRefs({ goodsTaxRateCode: "4" }, null),
    ).resolves.toBeUndefined();
  });
});

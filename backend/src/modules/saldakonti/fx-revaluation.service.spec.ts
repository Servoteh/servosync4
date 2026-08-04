import {
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import type { PostingEngineService } from "../gl/posting/posting.service";
import type { GlWriteService } from "../gl/gl-write.service";
import type { ExchangeRateService } from "../izvodi/exchange-rate.service";
import type {
  OpenItemsService,
  OpenItem,
  MixedFxCurrencyGroup,
} from "./open-items.service";
import {
  FxRevaluationService,
  FX_GAIN_ACCOUNT,
  FX_LOSS_ACCOUNT,
} from "./fx-revaluation.service";

const D = Prisma.Decimal;

/** Presek u prošlosti — budući presek je namerno zabranjen (guard). */
const AS_OF = "2025-12-31";

/** Otvorena devizna stavka (izlaz OpenItemsService.listOpenItems). */
function openItem(over: Partial<OpenItem> = {}): OpenItem {
  return {
    accountCode: "2050",
    analyticalCode: 100,
    documentNumber: "F-1/2025",
    balance: new D(117000),
    totalDebit: new D(117000),
    totalCredit: new D(0),
    dueDate: null,
    daysOverdue: null,
    currency: "EUR",
    side: "receivable",
    // Revalorizacija ne bira po vrsti partnera (i kupčeve i dobavljačke devizne
    // stavke se preračunavaju) — polje je tu jer ga tip nosi od 04.08.2026.
    partnerScope: "customer",
    ledgerEntryIds: [1],
    fxAmount: new D(1000),
    fxCurrency: "EUR",
    ...over,
  };
}

interface PostedLine {
  accountCode: string;
  analyticalCode?: number | null;
  debit?: number | string;
  credit?: number | string;
  description?: string;
  documentNumber?: string | null;
  currency?: string | null;
}

interface Harness {
  service: FxRevaluationService;
  postManualEntry: jest.Mock;
  reverse: jest.Mock;
  listOpenItems: jest.Mock;
  listMixedFxCurrencyGroups: jest.Mock;
  /** Poslednji skup linija prosleđen knjižnom motoru. */
  lastLines: () => PostedLine[];
  runs: Array<Record<string, unknown>>;
}

/**
 * Harness: pravi Prisma mock sa STVARNOM bravom idempotencije — `create` baca P2002
 * kad već postoji aktivan (asOfDate, currency, companyId) red, tačno kao parcijalni
 * unique `uq_fx_revaluation_runs_active`.
 */
function makeService(
  opts: {
    items?: OpenItem[];
    rate?: string;
    /** Datum kursne liste koju resolver vraća (default = dan preseka). */
    rateDate?: string;
    mixed?: MixedFxCurrencyGroup[];
  } = {},
): Harness {
  const items = opts.items ?? [openItem()];
  const runs: Array<Record<string, unknown>> = [];
  let nextRunId = 1;

  const key = (r: { asOfDate: Date; currency: string; companyId: number }) =>
    `${new Date(r.asOfDate).toISOString().slice(0, 10)}|${r.currency}|${r.companyId}`;

  const fxRevaluationRun = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const candidate = data as unknown as {
        asOfDate: Date;
        currency: string;
        companyId: number;
      };
      const clash = runs.some(
        (r) => r.status !== "REVERSED" && key(r as never) === key(candidate),
      );
      if (clash)
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
          code: "P2002",
          clientVersion: "6.19.3",
        });
      const row = { id: nextRunId++, journalEntryId: null, ...data };
      runs.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: number };
        data: Record<string, unknown>;
      }) => {
        const row = runs.find((r) => r.id === where.id);
        Object.assign(row as object, data);
        return Promise.resolve(row);
      },
    ),
    findUnique: jest.fn(({ where }: { where: { id: number } }) =>
      Promise.resolve(runs.find((r) => r.id === where.id) ?? null),
    ),
    findMany: jest.fn(() => Promise.resolve(runs)),
  };

  const prisma = {
    fxRevaluationRun,
    account: {
      findMany: jest.fn(({ where }: { where: { code: { in: string[] } } }) =>
        Promise.resolve(where.code.in.map((code) => ({ code }))),
      ),
    },
    journalEntry: {
      findUnique: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve({ id: where.id, reversedByEntryId: null }),
      ),
    },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
      fn({ fxRevaluationRun }),
    ),
  } as unknown as PrismaService;

  const listOpenItems = jest.fn().mockResolvedValue(items);
  const listMixedFxCurrencyGroups = jest
    .fn()
    .mockResolvedValue(opts.mixed ?? []);
  const openItems = {
    listOpenItems,
    listMixedFxCurrencyGroups,
  } as unknown as OpenItemsService;

  const exchangeRates = {
    resolve: jest.fn().mockResolvedValue({
      currency: "EUR",
      type: "middle",
      rate: new D(opts.rate ?? "120"),
      rateDate: new Date(`${opts.rateDate ?? AS_OF}T00:00:00Z`),
      requestedOn: new Date(AS_OF),
      row: {},
    }),
  } as unknown as ExchangeRateService;

  let nextJournalId = 500;
  const postManualEntry = jest.fn(
    (_tx: unknown, params: { lines: PostedLine[] }) =>
      Promise.resolve({
        journalEntryId: nextJournalId++,
        number: "0001",
        lineCount: params.lines.length,
      }),
  );
  const posting = { postManualEntry } as unknown as PostingEngineService;

  const reverse = jest.fn().mockResolvedValue({
    stornoEntryId: 999,
    number: "0002",
    reversedEntryId: 500,
  });
  const glWrite = { reverse } as unknown as GlWriteService;

  const service = new FxRevaluationService(
    prisma,
    openItems,
    exchangeRates,
    posting,
    glWrite,
  );

  return {
    service,
    postManualEntry,
    reverse,
    listOpenItems,
    listMixedFxCurrencyGroups,
    lastLines: () =>
      (postManualEntry.mock.calls.at(-1)?.[1] as { lines: PostedLine[] }).lines,
    runs,
  };
}

/** Σ duguje / Σ potražuje nad linijama naloga (Decimal — nikad Float). */
function totals(lines: PostedLine[]) {
  let debit = new D(0);
  let credit = new D(0);
  for (const l of lines) {
    debit = debit.add(new D(l.debit ?? 0));
    credit = credit.add(new D(l.credit ?? 0));
  }
  return { debit, credit };
}

describe("FxRevaluationService", () => {
  describe("preview", () => {
    it("EUR 1.000 knjižen po 117 (117.000 RSD) → kurs 120 daje razliku 3.000", async () => {
      const h = makeService();

      const preview = await h.service.preview({
        asOfDate: AS_OF,
        currency: "eur", // normalizacija valute
      });

      expect(preview.currency).toBe("EUR");
      expect(preview.rate.toFixed(2)).toBe("120.00");
      expect(preview.itemsCount).toBe(1);

      const item = preview.items[0];
      expect(item.fxAmount.toFixed(2)).toBe("1000.00");
      expect(item.bookedAmount.toFixed(2)).toBe("117000.00");
      expect(item.revaluedAmount.toFixed(2)).toBe("120000.00");
      expect(item.difference.toFixed(2)).toBe("3000.00");

      expect(preview.gainTotal.toFixed(2)).toBe("3000.00");
      expect(preview.lossTotal.toFixed(2)).toBe("0.00");
      expect(preview.netAmount.toFixed(2)).toBe("3000.00");
    });

    it("obaveza (potražni saldo) pri rastu kursa daje GUBITAK", async () => {
      const h = makeService({
        items: [
          openItem({
            accountCode: "4360",
            side: "payable",
            balance: new D(-117000),
            totalDebit: new D(0),
            totalCredit: new D(117000),
            fxAmount: new D(-1000),
          }),
        ],
      });

      const preview = await h.service.preview({
        asOfDate: AS_OF,
        currency: "EUR",
      });

      expect(preview.items[0].difference.toFixed(2)).toBe("-3000.00");
      expect(preview.lossTotal.toFixed(2)).toBe("3000.00");
      expect(preview.gainTotal.toFixed(2)).toBe("0.00");
    });

    it("presek u budućnosti se odbija", async () => {
      const h = makeService();
      const future = new Date(Date.now() + 30 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      await expect(
        h.service.preview({ asOfDate: future, currency: "EUR" }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("otvorene stavke se čitaju sa presekom i filterom valute (posted+locked je u OpenItemsService)", async () => {
      const h = makeService();
      await h.service.preview({
        asOfDate: AS_OF,
        currency: "EUR",
        companyId: 0,
      });
      expect(h.listOpenItems).toHaveBeenCalledWith(
        undefined,
        undefined,
        expect.any(Date),
        { fxCurrency: "EUR", companyId: 0 },
      );
    });
  });

  describe("run", () => {
    it("knjiži razliku 3.000 na 663 i BALANSIRA nalog", async () => {
      const h = makeService();

      const res = await h.service.run(
        { asOfDate: AS_OF, currency: "EUR" },
        { userId: 7 },
      );

      expect(res.gainAmount.toFixed(2)).toBe("3000.00");
      expect(res.lossAmount.toFixed(2)).toBe("0.00");
      expect(res.itemsCount).toBe(1);
      expect(res.status).toBe("POSTED");
      expect(res.journalEntryId).toBe(500);

      const lines = h.lastLines();
      // Protivstavka = konto SAME otvorene stavke (2050 + komitent + broj dokumenta).
      const itemLine = lines.find((l) => l.accountCode === "2050");
      expect(itemLine).toBeDefined();
      expect(itemLine?.analyticalCode).toBe(100);
      expect(itemLine?.documentNumber).toBe("F-1/2025");
      expect(new D(itemLine?.debit ?? 0).toFixed(2)).toBe("3000.00");

      // Prihod od pozitivnih kursnih razlika.
      const gainLine = lines.find((l) => l.accountCode === FX_GAIN_ACCOUNT);
      expect(new D(gainLine?.credit ?? 0).toFixed(2)).toBe("3000.00");
      expect(lines.some((l) => l.accountCode === FX_LOSS_ACCOUNT)).toBe(false);

      const t = totals(lines);
      expect(t.debit.toFixed(2)).toBe(t.credit.toFixed(2));
      expect(t.debit.toFixed(2)).toBe("3000.00");
    });

    it("mešoviti skup (dobitak + gubitak) daje balansiran nalog sa 663 i 563", async () => {
      const h = makeService({
        items: [
          openItem(),
          openItem({
            accountCode: "4360",
            analyticalCode: 200,
            documentNumber: "UF-9/2025",
            side: "payable",
            balance: new D(-58500),
            totalDebit: new D(0),
            totalCredit: new D(58500),
            fxAmount: new D(-500),
            ledgerEntryIds: [2],
          }),
        ],
      });

      const res = await h.service.run({ asOfDate: AS_OF, currency: "EUR" });

      expect(res.gainAmount.toFixed(2)).toBe("3000.00"); // 120.000 − 117.000
      expect(res.lossAmount.toFixed(2)).toBe("1500.00"); // −60.000 − (−58.500)
      expect(res.itemsCount).toBe(2);

      const lines = h.lastLines();
      const gain = lines.find((l) => l.accountCode === FX_GAIN_ACCOUNT);
      const loss = lines.find((l) => l.accountCode === FX_LOSS_ACCOUNT);
      expect(new D(gain?.credit ?? 0).toFixed(2)).toBe("3000.00");
      expect(new D(loss?.debit ?? 0).toFixed(2)).toBe("1500.00");

      const t = totals(lines);
      expect(t.debit.toFixed(2)).toBe(t.credit.toFixed(2));
      expect(t.debit.toFixed(2)).toBe("4500.00");
    });

    it("bez ijedne razlike (isti kurs) → 422, ništa se ne knjiži", async () => {
      const h = makeService({ rate: "117" });
      await expect(
        h.service.run({ asOfDate: AS_OF, currency: "EUR" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(h.postManualEntry).not.toHaveBeenCalled();
    });

    it("ponovni obračun istog (datum, valuta) → 409", async () => {
      const h = makeService();
      await h.service.run({ asOfDate: AS_OF, currency: "EUR" });

      await expect(
        h.service.run({ asOfDate: AS_OF, currency: "EUR" }),
      ).rejects.toBeInstanceOf(ConflictException);
      // Drugi nalog NIJE proknjižen (brava puca pre knjiženja).
      expect(h.postManualEntry).toHaveBeenCalledTimes(1);
    });
  });

  describe("reverse", () => {
    it("stornira nalog, prevodi obračun u REVERSED i oslobađa presek za ponovni obračun", async () => {
      const h = makeService();
      const first = await h.service.run({ asOfDate: AS_OF, currency: "EUR" });

      const rev = await h.service.reverse(
        { runId: first.runId, reason: "pogrešan kurs" },
        { userId: 7 },
      );

      // Datum knjiženja storna = PRESEK izvornog obračuna (regresija §1).
      const call = h.reverse.mock.calls[0] as [
        number,
        number | undefined,
        { postingDate: Date; documentDate: Date },
      ];
      expect(call[0]).toBe(first.journalEntryId);
      expect(call[1]).toBe(7);
      expect(call[2].postingDate).toBeInstanceOf(Date);
      expect(rev.status).toBe("REVERSED");
      expect(rev.stornoEntryId).toBe(999);

      // Slot je oslobođen — ponovni obračun istog preseka sada prolazi.
      const second = await h.service.run({ asOfDate: AS_OF, currency: "EUR" });
      expect(second.runId).not.toBe(first.runId);
      expect(second.status).toBe("POSTED");
      expect(h.postManualEntry).toHaveBeenCalledTimes(2);
    });

    it("dvostruki storno istog obračuna → 409", async () => {
      const h = makeService();
      const first = await h.service.run({ asOfDate: AS_OF, currency: "EUR" });
      await h.service.reverse({ runId: first.runId });

      await expect(
        h.service.reverse({ runId: first.runId }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ── Regresioni testovi adversarial review-a (C2) ────────────────────────────
  // Svaki blok zaključava JEDAN dokazan nalaz; bez njih se bag vraća prvom izmenom.

  describe("regresija §1 — storno mora biti vidljiv na presek", () => {
    it("storno obračuna nosi PRESEK obračuna kao datum knjiženja, ne današnji dan", async () => {
      const h = makeService();
      const first = await h.service.run({ asOfDate: AS_OF, currency: "EUR" });

      await h.service.reverse({ runId: first.runId }, { userId: 3 });

      const [, , opts] = h.reverse.mock.calls[0] as [
        number,
        number | undefined,
        { postingDate: Date; documentDate: Date },
      ];
      // Bez ovoga storno pada u naredni period (open-items filtrira
      // je.posting_date <= presek) → original uđe u ponovni obračun, storno ne.
      expect(opts.postingDate.toISOString().slice(0, 10)).toBe(AS_OF);
      expect(opts.documentDate.toISOString().slice(0, 10)).toBe(AS_OF);
    });
  });

  describe("regresija §3 — grupa sa više valuta", () => {
    it("mešane grupe se prijavljuju u pregledu (ne nestaju tiho)", async () => {
      const h = makeService({
        mixed: [
          {
            accountCode: "2040",
            analyticalCode: 100,
            documentNumber: null,
            currencies: ["EUR", "USD"],
            balance: new D(234000),
            ledgerEntryIds: [11, 12],
          },
        ],
      });

      const preview = await h.service.preview({
        asOfDate: AS_OF,
        currency: "EUR",
      });

      expect(preview.mixedCurrencyGroups).toHaveLength(1);
      expect(preview.mixedCurrencyGroups[0].code).toBe("MIXED_CURRENCY");
      expect(preview.mixedCurrencyGroups[0].included).toBe(false);
      expect(preview.mixedCurrencyGroups[0].message).toContain("EUR, USD");
      // Traži se SAMO za valutu obračuna i isti presek.
      expect(h.listMixedFxCurrencyGroups).toHaveBeenCalledWith(
        expect.any(Date),
        { fxCurrency: "EUR", companyId: undefined },
      );
    });

    it("mešane grupe stižu i u rezultat obračuna", async () => {
      const h = makeService({
        mixed: [
          {
            accountCode: "2040",
            analyticalCode: 100,
            documentNumber: null,
            currencies: ["CHF", "EUR"],
            balance: new D(1000),
            ledgerEntryIds: [11],
          },
        ],
      });

      const res = await h.service.run({ asOfDate: AS_OF, currency: "EUR" });
      expect(res.mixedCurrencyGroups).toHaveLength(1);
      // Mešana grupa NIJE proknjižena — nalog ima samo ispravnu stavku + 663.
      expect(h.lastLines().some((l) => l.accountCode === "2040")).toBe(false);
    });
  });

  describe("regresija §4 — zaokruživanje po stavci pre sabiranja", () => {
    it("dve stavke sa razlikom 0,0040 ne prave nebalansiran nalog (422, ništa se ne knjiži)", async () => {
      // 1.000 EUR × 120 = 120.000,00; knjiženo 119.999,9960 → razlika 0,0040 po stavci.
      const h = makeService({
        items: [
          openItem({ balance: new D("119999.9960") }),
          openItem({
            documentNumber: "F-2/2025",
            balance: new D("119999.9960"),
            ledgerEntryIds: [2],
          }),
        ],
      });

      const preview = await h.service.preview({
        asOfDate: AS_OF,
        currency: "EUR",
      });
      // Razlika ispod para se zaokružuje na 0 — i u stavci i u zbiru.
      expect(preview.items[0].difference.toFixed(2)).toBe("0.00");
      expect(preview.gainTotal.toFixed(2)).toBe("0.00");

      await expect(
        h.service.run({ asOfDate: AS_OF, currency: "EUR" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(h.postManualEntry).not.toHaveBeenCalled();
    });

    it("dve stavke sa razlikom 0,005 daju BALANSIRAN nalog (0,01 + 0,01 = 0,02)", async () => {
      const h = makeService({
        items: [
          openItem({ balance: new D("119999.995") }),
          openItem({
            documentNumber: "F-2/2025",
            balance: new D("119999.995"),
            ledgerEntryIds: [2],
          }),
        ],
      });

      const res = await h.service.run({ asOfDate: AS_OF, currency: "EUR" });

      expect(res.gainAmount.toFixed(2)).toBe("0.02");
      const t = totals(h.lastLines());
      expect(t.debit.toFixed(4)).toBe(t.credit.toFixed(4));
      expect(t.debit.toFixed(2)).toBe("0.02");
    });
  });

  describe("regresija §5 — stavka bez ispravnog deviznog para", () => {
    /** 1.000 EUR sa dinarskim saldom 58.500 → implicitna stopa 58,5 vs kurs 120. */
    const brokenPair = () =>
      openItem({
        documentNumber: "F-9/2025",
        balance: new D(58500),
        totalDebit: new D(117000),
        totalCredit: new D(58500),
        ledgerEntryIds: [9],
      });

    it("sporna grupa se NE knjiži nego se vraća u listi spornih", async () => {
      const h = makeService({ items: [openItem(), brokenPair()] });

      const res = await h.service.run({ asOfDate: AS_OF, currency: "EUR" });

      expect(res.flagged).toHaveLength(1);
      expect(res.flagged[0].code).toBe("RATE_MISMATCH");
      expect(res.flagged[0].included).toBe(false);
      // Knjiži se samo ispravna stavka (3.000), ne 61.500 lažne razlike.
      expect(res.gainAmount.toFixed(2)).toBe("3000.00");
      expect(res.itemsCount).toBe(1);
      expect(h.lastLines().some((l) => l.documentNumber === "F-9/2025")).toBe(
        false,
      );
    });

    it("force svesno uključuje spornu grupu u obračun", async () => {
      const h = makeService({ items: [openItem(), brokenPair()] });

      const res = await h.service.run({
        asOfDate: AS_OF,
        currency: "EUR",
        force: true,
      });

      expect(res.flagged[0].included).toBe(true);
      // 3.000 + (120.000 − 58.500) = 64.500
      expect(res.gainAmount.toFixed(2)).toBe("64500.00");
      expect(res.itemsCount).toBe(2);
      const t = totals(h.lastLines());
      expect(t.debit.toFixed(2)).toBe(t.credit.toFixed(2));
    });

    it("dinarski saldo bez deviznog salda je sporan (NO_FX_PAIR)", async () => {
      const h = makeService({
        items: [
          openItem(),
          openItem({ fxAmount: new D(0), ledgerEntryIds: [3] }),
        ],
      });

      const preview = await h.service.preview({
        asOfDate: AS_OF,
        currency: "EUR",
      });
      expect(preview.flagged.map((f) => f.code)).toEqual(["NO_FX_PAIR"]);
      expect(preview.itemsCount).toBe(1);
    });

    it("devizni i dinarski saldo suprotnog predznaka je sporan (FX_SIGN_MISMATCH)", async () => {
      const h = makeService({
        items: [openItem({ fxAmount: new D(-1000) })],
      });

      const preview = await h.service.preview({
        asOfDate: AS_OF,
        currency: "EUR",
      });
      expect(preview.flagged.map((f) => f.code)).toEqual(["FX_SIGN_MISMATCH"]);
      expect(preview.itemsCount).toBe(0);
    });
  });

  describe("regresija §6 — kurs mora biti sa dana preseka", () => {
    it("kurs sa ranijeg dana → 409 sa datumom zatečene kursne liste", async () => {
      const h = makeService({ rateDate: "2025-12-20" });

      await expect(
        h.service.preview({ asOfDate: AS_OF, currency: "EUR" }),
      ).rejects.toThrow(/20\.12\.2025/);
      await expect(
        h.service.run({ asOfDate: AS_OF, currency: "EUR" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(h.postManualEntry).not.toHaveBeenCalled();
    });

    it("allowStaleRate propušta obračun i upisuje rateDate u zapis obračuna", async () => {
      const h = makeService({ rateDate: "2025-12-20" });

      const preview = await h.service.preview({
        asOfDate: AS_OF,
        currency: "EUR",
        allowStaleRate: true,
      });
      expect(preview.staleRate).toBe(true);
      expect(preview.rateDate.toISOString().slice(0, 10)).toBe("2025-12-20");

      const res = await h.service.run({
        asOfDate: AS_OF,
        currency: "EUR",
        allowStaleRate: true,
      });
      expect(res.rateDate?.toISOString().slice(0, 10)).toBe("2025-12-20");
      expect(h.runs[0].rateDate).toBeInstanceOf(Date);
    });

    it("kurs sa dana preseka prolazi bez ikakve zastavice", async () => {
      const h = makeService();
      const preview = await h.service.preview({
        asOfDate: AS_OF,
        currency: "EUR",
      });
      expect(preview.staleRate).toBe(false);
    });
  });

  describe("regresija §7 — knjiži se ono što je odobreno u pregledu", () => {
    it("promenjen kurs između pregleda i potvrde → 409", async () => {
      const h = makeService();
      await expect(
        h.service.run({
          asOfDate: AS_OF,
          currency: "EUR",
          expectedRate: "117.000000", // pregled je bio po 117, sada važi 120
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(h.postManualEntry).not.toHaveBeenCalled();
    });

    it("promenjen neto efekat između pregleda i potvrde → 409", async () => {
      const h = makeService();
      await expect(
        h.service.run({
          asOfDate: AS_OF,
          currency: "EUR",
          expectedRate: "120",
          expectedNetAmount: "2500.00", // pregled je pokazivao 2.500, sada je 3.000
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(h.postManualEntry).not.toHaveBeenCalled();
    });

    it("poklapanje sa pregledom prolazi", async () => {
      const h = makeService();
      const res = await h.service.run({
        asOfDate: AS_OF,
        currency: "EUR",
        expectedRate: "120",
        expectedNetAmount: "3000",
      });
      expect(res.status).toBe("POSTED");
    });

    it("bez očekivanih vrednosti ponašanje je nepromenjeno (stari klijent)", async () => {
      const h = makeService();
      const res = await h.service.run({ asOfDate: AS_OF, currency: "EUR" });
      expect(res.status).toBe("POSTED");
    });
  });
});

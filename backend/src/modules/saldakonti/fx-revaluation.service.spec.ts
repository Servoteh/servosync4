import {
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import type { PostingEngineService } from "../gl/posting/posting.service";
import type { GlWriteService } from "../gl/gl-write.service";
import type { ExchangeRateService } from "../izvodi/exchange-rate.service";
import type { OpenItemsService, OpenItem } from "./open-items.service";
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
  opts: { items?: OpenItem[]; rate?: string } = {},
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
  const openItems = { listOpenItems } as unknown as OpenItemsService;

  const exchangeRates = {
    resolve: jest.fn().mockResolvedValue({
      currency: "EUR",
      type: "middle",
      rate: new D(opts.rate ?? "120"),
      rateDate: new Date("2025-12-31T00:00:00Z"),
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

      expect(h.reverse).toHaveBeenCalledWith(first.journalEntryId, 7);
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
});

import { Test, TestingModule } from "@nestjs/testing";
import {
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import { DocumentNumberSequenceService } from "./numbering.service";
import { AdvanceInvoiceService } from "./advance-invoice.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * Avansni račun (AVR) — poslovni tok, Batch C §C1a.
 * Pokriveno: preračunata stopa (12.000 bruto @20% → 10.000 + 2.000), anti-duplo
 * AVR po predračunu (409), odbijanje NENAPLAĆENOG avansa (422), iznos za plaćanje
 * 0 kad avans pokriva ceo račun, konta naloga naplate i anti-dvoklik CAS.
 */

const D = Prisma.Decimal;

const actor: AuthUser = {
  userId: 7,
  email: "knjigovodja@servoteh",
  role: "racunovodja",
  workerId: null,
};

/** Predračun 12.000 bruto (10.000 osnovica + 2.000 PDV 20%). */
function proformaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    documentType: "PROF",
    documentNumber: "PROF0001/2026",
    level: 250,
    status: "DRAFT",
    companyId: 0,
    customerId: 5,
    documentDate: new Date("2026-07-01T00:00:00Z"),
    dueDate: null,
    currency: "RSD",
    exchangeRate: new D(1),
    accountingExchangeRate: new D(1),
    isExport: false,
    netTotal: new D(10000),
    vatTotal: new D(2000),
    grossTotal: new D(12000),
    poNumber: null,
    salespersonId: null,
    items: [{ vatRateCode: "3", vatBase: new D(10000) }],
    ...overrides,
  };
}

/** Naplaćen avansni račun 12.000 bruto. */
function advanceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 50,
    documentType: "AVR",
    documentNumber: "AVR0001/2026",
    level: 0,
    status: "PAID",
    companyId: 0,
    customerId: 5,
    documentDate: new Date("2026-07-02T00:00:00Z"),
    dueDate: null,
    currency: "RSD",
    isExport: false,
    netTotal: new D(10000),
    vatTotal: new D(2000),
    grossTotal: new D(12000),
    advanceDirection: "out",
    advancePaidAt: new Date("2026-07-03T00:00:00Z"),
    advancePaidAmount: new D(12000),
    items: [{ vatRateCode: "3", vatBase: new D(10000) }],
    ...overrides,
  };
}

/** Konačni (proknjižen) račun 12.000 bruto, bez odbijenog avansa. */
function finalInvoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    documentType: "IFR",
    documentNumber: "IFR0007/2026",
    level: 0,
    status: "POSTED",
    companyId: 0,
    customerId: 5,
    documentDate: new Date("2026-07-05T00:00:00Z"),
    dueDate: null,
    currency: "RSD",
    isExport: false,
    netTotal: new D(10000),
    vatTotal: new D(2000),
    grossTotal: new D(12000),
    advanceInvoiceId: null,
    advanceAppliedAmount: new D(0),
    items: [],
    ...overrides,
  };
}

interface PrismaMock {
  invoice: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
}

function prismaMock(): PrismaMock {
  const mock: PrismaMock = {
    invoice: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  // Interaktivna transakcija: callback dobija isti mock kao `tx`.
  mock.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: PrismaMock) => unknown)(mock),
  );
  return mock;
}

/** Linija naloga kakvu servis šalje PostingEngine-u (debit/credit su stringovi). */
interface PostedLine {
  accountCode: string;
  analyticalCode?: number | null;
  debit?: number | string;
  credit?: number | string;
}

/** Parametri poziva `PostingEngineService.postManualEntry`. */
interface PostedEntryParams {
  orderType: string;
  lines: PostedLine[];
}

/** Prvi argument prvog poziva mock-a, tipiziran (bez `any` pristupa na mock.calls). */
function firstArg<T>(fn: jest.Mock): T {
  return (fn.mock.calls as unknown as [T][])[0][0];
}

/** Drugi argument prvog poziva mock-a (postManualEntry prima `tx` pa parametre). */
function secondArg<T>(fn: jest.Mock): T {
  return (fn.mock.calls as unknown as [unknown, T][])[0][1];
}

/** Mapa konto → linija naloga (za provere knjiženja). */
function linesByAccount(params: PostedEntryParams): Map<string, PostedLine> {
  return new Map(params.lines.map((l) => [l.accountCode, l]));
}

describe("AdvanceInvoiceService", () => {
  let service: AdvanceInvoiceService;
  let prisma: PrismaMock;
  let posting: { postManualEntry: jest.Mock };
  let numbering: { next: jest.Mock };

  beforeEach(async () => {
    prisma = prismaMock();
    posting = {
      postManualEntry: jest.fn().mockResolvedValue({
        journalEntryId: 77,
        number: "0012",
        lineCount: 3,
      }),
    };
    numbering = { next: jest.fn().mockResolvedValue("AVR0001/2026") };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdvanceInvoiceService,
        { provide: PrismaService, useValue: prisma },
        { provide: PostingEngineService, useValue: posting },
        { provide: DocumentNumberSequenceService, useValue: numbering },
      ],
    }).compile();

    service = module.get(AdvanceInvoiceService);
  });

  // ── 1) kreiranje AVR: bruto → osnovica + PDV preračunatom stopom ────────────

  describe("createAdvanceInvoice", () => {
    it("razbija 12.000 bruto @20% na osnovicu 10.000 i PDV 2.000", async () => {
      prisma.invoice.findUnique.mockResolvedValue(proformaRow());
      prisma.invoice.create.mockImplementation((args: { data: unknown }) => ({
        id: 50,
        ...(args.data as Record<string, unknown>),
        items: [],
      }));

      await service.createAdvanceInvoice({ proformaId: 10 }, actor);

      const { data } = firstArg<{
        data: {
          documentType: string;
          documentNumber: string;
          level: number;
          advanceDirection: string;
          copiedFromDocId: number;
          netTotal: Prisma.Decimal;
          vatTotal: Prisma.Decimal;
          grossTotal: Prisma.Decimal;
        };
      }>(prisma.invoice.create);

      expect(data.documentType).toBe("AVR");
      expect(data.advanceDirection).toBe("out");
      expect(data.level).toBe(0);
      expect(data.documentNumber).toBe("AVR0001/2026");
      expect(data.copiedFromDocId).toBe(10);
      expect(data.netTotal.toFixed(2)).toBe("10000.00");
      expect(data.vatTotal.toFixed(2)).toBe("2000.00");
      expect(data.grossTotal.toFixed(2)).toBe("12000.00");
      // Broj se traži po šifri 'AVR' i godini datuma dokumenta.
      expect(numbering.next).toHaveBeenCalledWith(
        expect.anything(),
        "AVR",
        expect.any(Number),
        0,
      );
    });

    it("delimičan avans (6.000 od 12.000) daje 5.000 + 1.000", async () => {
      prisma.invoice.findUnique.mockResolvedValue(proformaRow());
      prisma.invoice.create.mockImplementation((args: { data: unknown }) => ({
        id: 51,
        ...(args.data as Record<string, unknown>),
        items: [],
      }));

      await service.createAdvanceInvoice(
        { proformaId: 10, amount: 6000 },
        actor,
      );

      const { data } = firstArg<{
        data: {
          netTotal: Prisma.Decimal;
          vatTotal: Prisma.Decimal;
          grossTotal: Prisma.Decimal;
        };
      }>(prisma.invoice.create);
      expect(data.netTotal.toFixed(2)).toBe("5000.00");
      expect(data.vatTotal.toFixed(2)).toBe("1000.00");
      expect(data.grossTotal.toFixed(2)).toBe("6000.00");
    });

    it("drugi AVR iz istog predračuna → 409", async () => {
      prisma.invoice.findUnique.mockResolvedValue(proformaRow());
      prisma.invoice.findFirst.mockResolvedValue({
        id: 50,
        documentNumber: "AVR0001/2026",
      });

      await expect(
        service.createAdvanceInvoice({ proformaId: 10 }, actor),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("avans veći od bruto predračuna → 422", async () => {
      prisma.invoice.findUnique.mockResolvedValue(proformaRow());

      await expect(
        service.createAdvanceInvoice(
          { proformaId: 10, amount: "12000.01" },
          actor,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("izvor koji nije predračun (level 0) → 422", async () => {
      prisma.invoice.findUnique.mockResolvedValue(
        proformaRow({ documentType: "IFR", level: 0 }),
      );

      await expect(
        service.createAdvanceInvoice({ proformaId: 10 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  // ── 2) naplata avansa: PDV obaveza nastaje NAPLATOM ─────────────────────────

  describe("markAdvancePaid", () => {
    it("knjiži kupca 2040 DUG = bruto, 4300 POT = osnovica, 4720 POT = PDV", async () => {
      prisma.invoice.findUnique.mockResolvedValue(
        advanceRow({
          status: "POSTED",
          advancePaidAt: null,
          advancePaidAmount: new D(0),
        }),
      );
      prisma.invoice.update.mockResolvedValue(advanceRow());

      await service.markAdvancePaid(
        {
          advanceInvoiceId: 50,
          paidAt: "2026-07-03T00:00:00Z",
          amount: 12000,
        },
        actor,
      );

      const params = secondArg<PostedEntryParams>(posting.postManualEntry);
      expect(params.orderType).toBe("IF");

      const byAccount = linesByAccount(params);
      expect(byAccount.get("2040")?.debit).toBe("12000.0000");
      expect(byAccount.get("2040")?.analyticalCode).toBe(5);
      expect(byAccount.get("4300")?.credit).toBe("10000.0000");
      expect(byAccount.get("4720")?.credit).toBe("2000.0000");

      // Nalog balansira (ΣDug = ΣPot).
      const sum = (key: "debit" | "credit") =>
        params.lines.reduce((acc, l) => acc.add(new D(l[key] ?? 0)), new D(0));
      expect(sum("debit").equals(sum("credit"))).toBe(true);
    });

    it("PDV 10% ide na konto 4730", async () => {
      prisma.invoice.findUnique.mockResolvedValue(
        advanceRow({
          status: "POSTED",
          advancePaidAt: null,
          advancePaidAmount: new D(0),
          grossTotal: new D(11000),
          items: [{ vatRateCode: "2", vatBase: new D(10000) }],
        }),
      );
      prisma.invoice.update.mockResolvedValue(advanceRow());

      await service.markAdvancePaid(
        {
          advanceInvoiceId: 50,
          paidAt: "2026-07-03T00:00:00Z",
          amount: 11000,
        },
        actor,
      );

      const byAccount = linesByAccount(
        secondArg<PostedEntryParams>(posting.postManualEntry),
      );
      expect(byAccount.get("4300")?.credit).toBe("10000.0000");
      expect(byAccount.get("4730")?.credit).toBe("1000.0000");
      expect(byAccount.has("4720")).toBe(false);
    });

    it("već naplaćen avans → 409 (bez drugog naloga)", async () => {
      prisma.invoice.findUnique.mockResolvedValue(advanceRow());

      await expect(
        service.markAdvancePaid(
          {
            advanceInvoiceId: 50,
            paidAt: "2026-07-04T00:00:00Z",
            amount: 12000,
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(posting.postManualEntry).not.toHaveBeenCalled();
    });

    it("dvoklik: CAS ne prelomi (count 0) → 409, nalog se ne knjiži", async () => {
      prisma.invoice.findUnique.mockResolvedValue(
        advanceRow({
          status: "POSTED",
          advancePaidAt: null,
          advancePaidAmount: new D(0),
        }),
      );
      prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.markAdvancePaid(
          {
            advanceInvoiceId: 50,
            paidAt: "2026-07-03T00:00:00Z",
            amount: 12000,
          },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(posting.postManualEntry).not.toHaveBeenCalled();
    });
  });

  // ── 3) odbijanje avansa na konačnom računu ─────────────────────────────────

  describe("applyAdvance", () => {
    /** findUnique po id-ju: konačni račun (100) i AVR (50). */
    function wireLookup(invoice: unknown, advance: unknown) {
      prisma.invoice.findUnique.mockImplementation(
        (args: { where: { id: number } }) =>
          Promise.resolve(args.where.id === 100 ? invoice : advance),
      );
    }

    it("odbijanje NENAPLAĆENOG avansa → 422", async () => {
      wireLookup(
        finalInvoiceRow(),
        advanceRow({
          status: "POSTED",
          advancePaidAt: null,
          advancePaidAmount: new D(0),
        }),
      );

      await expect(
        service.applyAdvance({ invoiceId: 100, advanceInvoiceId: 50 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
      expect(posting.postManualEntry).not.toHaveBeenCalled();
    });

    it("payableAmount = 0 kad je avans jednak iznosu računa; grossTotal netaknut", async () => {
      const posted = finalInvoiceRow({
        advanceInvoiceId: 50,
        advanceAppliedAmount: new D(12000),
      });
      prisma.invoice.findUnique.mockImplementation(
        (args: { where: { id: number } }) =>
          Promise.resolve(
            args.where.id === 100
              ? // prvi poziv = stanje pre odbijanja, poziv u tx = posle CAS-a
                prisma.invoice.updateMany.mock.calls.length === 0
                ? finalInvoiceRow()
                : posted
              : advanceRow(),
          ),
      );

      const result = await service.applyAdvance(
        { invoiceId: 100, advanceInvoiceId: 50 },
        actor,
      );

      expect(result.payableAmount.toFixed(2)).toBe("0.00");
      expect(result.grossTotal.toFixed(2)).toBe("12000.00");
      expect(result.advanceInvoiceNumber).toBe("AVR0001/2026");

      // Upisana su SAMO polja veze avansa (grossTotal se ne dira).
      const updateArgs = firstArg<{ data: Record<string, unknown> }>(
        prisma.invoice.updateMany,
      );
      expect(updateArgs.data.advanceInvoiceId).toBe(50);
      expect(
        (updateArgs.data.advanceAppliedAmount as Prisma.Decimal).toFixed(2),
      ).toBe("12000.00");
      expect(updateArgs.data).not.toHaveProperty("grossTotal");
    });

    it("GL storno avansa: 4300 DUG = osnovica, 4720 DUG = PDV, 2040 POT = bruto", async () => {
      prisma.invoice.findUnique.mockImplementation(
        (args: { where: { id: number } }) =>
          Promise.resolve(
            args.where.id === 100
              ? // pre CAS-a = račun bez avansa; posle CAS-a = sa upisanim avansom
                prisma.invoice.updateMany.mock.calls.length === 0
                ? finalInvoiceRow()
                : finalInvoiceRow({
                    advanceInvoiceId: 50,
                    advanceAppliedAmount: new D(12000),
                  })
              : advanceRow(),
          ),
      );

      await service.applyAdvance(
        { invoiceId: 100, advanceInvoiceId: 50 },
        actor,
      );

      const byAccount = linesByAccount(
        secondArg<PostedEntryParams>(posting.postManualEntry),
      );
      expect(byAccount.get("4300")?.debit).toBe("10000.0000");
      expect(byAccount.get("4720")?.debit).toBe("2000.0000");
      expect(byAccount.get("2040")?.credit).toBe("12000.0000");
      // Prihod se NE priznaje ovde (samo na konačnom računu).
      expect(byAccount.has("6040")).toBe(false);
    });

    it("avans većeg iznosa od računa → 422", async () => {
      wireLookup(finalInvoiceRow({ grossTotal: new D(5000) }), advanceRow());

      await expect(
        service.applyAdvance({ invoiceId: 100, advanceInvoiceId: 50 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("avans drugog kupca → 422", async () => {
      wireLookup(finalInvoiceRow(), advanceRow({ customerId: 9 }));

      await expect(
        service.applyAdvance({ invoiceId: 100, advanceInvoiceId: 50 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("neproknjižen (DRAFT) konačni račun → 422", async () => {
      wireLookup(
        finalInvoiceRow({ status: "DRAFT", level: 250 }),
        advanceRow(),
      );

      await expect(
        service.applyAdvance({ invoiceId: 100, advanceInvoiceId: 50 }, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("avans već odbijen na ovom računu → 409", async () => {
      wireLookup(
        finalInvoiceRow({
          advanceInvoiceId: 50,
          advanceAppliedAmount: new D(12000),
        }),
        advanceRow(),
      );

      await expect(
        service.applyAdvance({ invoiceId: 100, advanceInvoiceId: 50 }, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("P2002 nad uq_invoices_advance_applied_once → 409", async () => {
      wireLookup(finalInvoiceRow(), advanceRow());
      prisma.invoice.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "6.19.3",
        }),
      );

      await expect(
        service.applyAdvance({ invoiceId: 100, advanceInvoiceId: 50 }, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

import {
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AdvanceVatService } from "./advance-vat.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * Spec ulaznog avansa (C1b) — PRETPOREZ PO PLAĆANJU.
 * Fokus:
 *   1) evidencija bez plaćanja NE pravi KUF stavku,
 *   2) posle plaćanja KUF stavka postoji, i to u periodu po `paidAt` (ne po datumu
 *      dokumenta),
 *   3) dvostruko označavanje plaćanja pada na 409 (CAS), bez duple KUF stavke.
 *
 * Prisma i TaxRatesService su mockovani (bez baze) — logika servisa je čista.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

const ACTOR: AuthUser = {
  userId: 7,
  email: "test@servoteh.com",
  role: "admin",
  workerId: null,
};

/** AVR dobavljača: 12.000 bruto @20% (10.000 osnovica + 2.000 PDV), datum 10.07.2026. */
function makeAdvance(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    documentType: "AVR",
    documentNumber: "AV-DOB-1/2026",
    level: 0,
    customerId: 501,
    documentDate: new Date("2026-07-10T00:00:00.000Z"),
    currency: "RSD",
    netTotal: D("10000"),
    vatTotal: D("2000"),
    grossTotal: D("12000"),
    advanceDirection: "in",
    advanceInvoiceId: null,
    advanceAppliedAmount: D(0),
    advancePaidAt: null as Date | null,
    advancePaidAmount: D(0),
    status: "POSTED",
    note: null,
    items: [{ id: 1, lineNo: 1, vatRateCode: "20" }],
    ...overrides,
  };
}

/**
 * Mock Prisma klijent. `$transaction(cb)` prosleđuje isti objekat kao `tx` — svi
 * pozivi (updateMany/create/vatReturn.findMany) se broje na istim jest mock-ovima.
 */
function makePrisma(
  opts: {
    advance?: ReturnType<typeof makeAdvance> | null;
    claimCount?: number;
  } = {},
) {
  const prisma = {
    invoice: {
      create: jest.fn().mockResolvedValue({ id: 42 }),
      findUnique: jest
        .fn()
        .mockResolvedValue(
          opts.advance === undefined ? makeAdvance() : opts.advance,
        ),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
    },
    vatLedgerEntry: { create: jest.fn().mockResolvedValue({ id: 900 }) },
    vatReturn: { findMany: jest.fn().mockResolvedValue([]) }, // nijedan period nije zaključan
    customer: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
    cb(prisma),
  );
  return prisma;
}

/** TaxRatesService mock — jedna stopa 20%. */
function makeTaxRates() {
  return {
    resolve: jest
      .fn()
      .mockResolvedValue({ data: { code: "20", ratePct: "20.00" } }),
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const taxRates = makeTaxRates();
  const service = new AdvanceVatService(prisma as never, taxRates as never);
  return { service, taxRates };
}

/** Prvi argument prvog poziva mock-a, tipiziran (jest.Mock inače vraća `any`). */
function firstArg<T>(fn: jest.Mock): T {
  return (fn.mock.calls[0] as unknown[])[0] as T;
}

describe("AdvanceVatService.recordIncomingAdvance", () => {
  it("bez plaćanja NE kreira KUF stavku (pretporez tek po plaćanju)", async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);

    const res = await service.recordIncomingAdvance(
      {
        partnerId: 501,
        documentNumber: "AV-DOB-1/2026",
        documentDate: "2026-07-10",
        grossAmount: 12000,
        vatRateCode: "20",
      },
      ACTOR,
    );

    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    expect(prisma.vatLedgerEntry.create).not.toHaveBeenCalled();
    expect(res.vatLedgerEntryId).toBeNull();
    expect(res.paidAt).toBeNull();
    // Bruto → neto ide kroz vat-bridge: 12.000 @20% = 10.000 + 2.000.
    expect(res.netTotal.toFixed(2)).toBe("10000.00");
    expect(res.vatTotal.toFixed(2)).toBe("2000.00");
  });

  it("upisuje AVR sa smerom 'in' i jednom stavkom koja nosi šifru stope", async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);

    await service.recordIncomingAdvance(
      {
        partnerId: 501,
        documentNumber: "AV-DOB-1/2026",
        documentDate: "2026-07-10",
        grossAmount: 12000,
        vatRateCode: "20",
      },
      ACTOR,
    );

    const { data } = firstArg<{
      data: {
        documentType: string;
        advanceDirection: string;
        customerId: number;
        items: { create: { vatRateCode: string }[] };
      };
    }>(prisma.invoice.create);
    expect(data.documentType).toBe("AVR");
    expect(data.advanceDirection).toBe("in");
    expect(data.customerId).toBe(501);
    expect(data.items.create[0].vatRateCode).toBe("20");
  });

  it("sa `paidAt` odmah priznaje pretporez (jedna KUF stavka)", async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);

    const res = await service.recordIncomingAdvance(
      {
        partnerId: 501,
        documentNumber: "AV-DOB-1/2026",
        documentDate: "2026-07-10",
        grossAmount: 12000,
        vatRateCode: "20",
        paidAt: "2026-08-05",
      },
      ACTOR,
    );

    expect(prisma.vatLedgerEntry.create).toHaveBeenCalledTimes(1);
    expect(res.vatLedgerEntryId).toBe(900);
  });
});

describe("AdvanceVatService.markIncomingAdvancePaid", () => {
  it("posle plaćanja postoji KUF stavka u periodu po `paidAt`, ne po datumu dokumenta", async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);

    // Dokument je iz jula, plaćanje iz avgusta → KUF period mora biti 2026-08.
    const res = await service.markIncomingAdvancePaid(
      { id: 42, paidAt: "2026-08-05", amount: 12000 },
      ACTOR,
    );

    expect(prisma.vatLedgerEntry.create).toHaveBeenCalledTimes(1);
    const { data } = firstArg<{
      data: {
        direction: string;
        taxPeriodYear: number;
        taxPeriodMonth: number;
        vatBase: Prisma.Decimal;
        vatAmount: Prisma.Decimal;
        partnerId: number | null;
      };
    }>(prisma.vatLedgerEntry.create);
    expect(data.direction).toBe("input"); // KUF
    expect(data.taxPeriodYear).toBe(2026);
    expect(data.taxPeriodMonth).toBe(8); // avgust (plaćanje), a ne 7 (dokument)
    expect(data.vatBase.toFixed(2)).toBe("10000.00");
    expect(data.vatAmount.toFixed(2)).toBe("2000.00");
    expect(data.partnerId).toBe(501);

    expect(res.taxPeriodMonth).toBe(8);
    expect(res.vatLedgerEntryId).toBe(900);
  });

  it("CAS upis: `advancePaidAt: null` je u WHERE uslovu", async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);

    await service.markIncomingAdvancePaid(
      { id: 42, paidAt: "2026-08-05", amount: 12000 },
      ACTOR,
    );

    const { where } = firstArg<{
      where: { id: number; advancePaidAt: null; advanceDirection: string };
    }>(prisma.invoice.updateMany);
    expect(where.id).toBe(42);
    expect(where.advancePaidAt).toBeNull();
    expect(where.advanceDirection).toBe("in");
  });

  it("delimično plaćanje razbija bruto po istoj stopi", async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);

    const res = await service.markIncomingAdvancePaid(
      { id: 42, paidAt: "2026-08-05", amount: 6000 },
      ACTOR,
    );

    expect(res.vatBase.toFixed(2)).toBe("5000.00");
    expect(res.vatAmount.toFixed(2)).toBe("1000.00");
  });

  it("dvostruko označavanje plaćanja → 409 (već upisan `advancePaidAt`)", async () => {
    const prisma = makePrisma({
      advance: makeAdvance({
        advancePaidAt: new Date("2026-08-05T00:00:00.000Z"),
        advancePaidAmount: D("12000"),
        status: "PAID",
      }),
    });
    const { service } = makeService(prisma);

    await expect(
      service.markIncomingAdvancePaid(
        { id: 42, paidAt: "2026-08-06", amount: 12000 },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.vatLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("trka dve sesije: CAS count = 0 → 409, bez druge KUF stavke", async () => {
    const prisma = makePrisma({ claimCount: 0 });
    const { service } = makeService(prisma);

    await expect(
      service.markIncomingAdvancePaid(
        { id: 42, paidAt: "2026-08-05", amount: 12000 },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.vatLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("odbija plaćanje veće od bruto iznosa avansa (422)", async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);

    await expect(
      service.markIncomingAdvancePaid(
        { id: 42, paidAt: "2026-08-05", amount: 15000 },
        ACTOR,
      ),
    ).rejects.toThrow(/veći od bruto iznosa avansa/);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("zaključan poreski period plaćanja → 409, bez CAS upisa", async () => {
    const prisma = makePrisma();
    prisma.vatReturn.findMany.mockResolvedValue([
      { id: 3, periodMonth: 8, periodQuarter: null },
    ]);
    const { service } = makeService(prisma);

    await expect(
      service.markIncomingAdvancePaid(
        { id: 42, paidAt: "2026-08-05", amount: 12000 },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(prisma.vatLedgerEntry.create).not.toHaveBeenCalled();
  });
});

describe("AdvanceVatService.linkIncomingAdvanceToFinal", () => {
  const FINAL = {
    id: 77,
    documentType: "IFR",
    documentNumber: "UF-100/2026",
    customerId: 501,
    documentDate: new Date("2026-09-01T00:00:00.000Z"),
    advanceInvoiceId: null as number | null,
  };

  // Tabela `invoices` sadrži ISKLJUČIVO naša izlazna dokumenta, pa je jedini
  // dokument koji se ovde može izabrati NAŠ račun kupcu. Vezivanje ulaznog
  // (dobavljačevog) avansa na njega postavilo bi `advanceAppliedAmount` na izlazni
  // račun → na SEF bi otišao umanjen PayableAmount i PrepaidAmount za avans koji
  // smo MI platili dobavljaču. Zato je veza ZATVORENA dok konačni ULAZNI račun ne
  // postoji kao zaseban zapis (adversarial review Batch C, nalaz 4).
  // Testovi ispod zaključavaju upravo to odbijanje — ranija verzija je knjižila.

  it("ulazni avans na NAŠ izlazni račun → 422 (nema ispravnog cilja veze)", async () => {
    const prisma = makePrisma({
      advance: makeAdvance({
        advancePaidAt: new Date("2026-08-05T00:00:00.000Z"),
        advancePaidAmount: D("12000"),
        status: "PAID",
      }),
    });
    prisma.invoice.findUnique
      .mockResolvedValueOnce(
        makeAdvance({
          advancePaidAt: new Date("2026-08-05T00:00:00.000Z"),
          advancePaidAmount: D("12000"),
          status: "PAID",
        }),
      )
      .mockResolvedValueOnce(FINAL);
    const { service } = makeService(prisma);

    await expect(
      service.linkIncomingAdvanceToFinal({ advanceId: 42, finalInvoiceId: 77 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // Ništa se ne knjiži i ništa se ne veže — ni KUF storno ni upis na fakturu.
    expect(prisma.vatLedgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("nenaplaćen ulazni avans → takođe 422, bez ikakvog upisa", async () => {
    const prisma = makePrisma();
    prisma.invoice.findUnique
      .mockResolvedValueOnce(makeAdvance())
      .mockResolvedValueOnce(FINAL);
    const { service } = makeService(prisma);

    await expect(
      service.linkIncomingAdvanceToFinal({ advanceId: 42, finalInvoiceId: 77 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.vatLedgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("veza na drugi AVANSNI račun → 422 (guard ostaje ispred provere smera)", async () => {
    const prisma = makePrisma();
    prisma.invoice.findUnique
      .mockResolvedValueOnce(makeAdvance())
      .mockResolvedValueOnce({ ...FINAL, documentType: "AVR" });
    const { service } = makeService(prisma);

    await expect(
      service.linkIncomingAdvanceToFinal({ advanceId: 42, finalInvoiceId: 77 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
});

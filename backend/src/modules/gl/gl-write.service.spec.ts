import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import type { PostingEngineService } from "./posting/posting.service";
import { GlWriteService } from "./gl-write.service";

const D = Prisma.Decimal;

/**
 * GL WRITE — storno naloga. Testovi zaključavaju dva dokazana nalaza review-a C2:
 *   §1 datum knjiženja storna (podrazumevano DANAS, uz `opts` presek izvornog naloga);
 *   §2 storno mora da ogleda i DEVIZNE kolone + da prenese mesto troška.
 * Ostali pozivaoci (`storno fakture` i sl.) moraju raditi tačno kao pre — otud i
 * test „bez opts ponašanje je nepromenjeno".
 */

interface CreatedLine {
  accountCode: string;
  analyticalCode: number | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  fxDebit: Prisma.Decimal | null;
  fxCredit: Prisma.Decimal | null;
  fxCurrency: string | null;
  description: string;
  documentNumber: string | null;
  dueDate: Date | null;
  currency: string | null;
  costCenter: string | null;
}

interface CreatedEntry {
  number: string;
  orderTypeCode: string;
  year: number;
  companyId: number;
  documentDate: Date;
  postingDate: Date;
  status: string;
  reversesEntryId: number;
  lines: { create: CreatedLine[] };
}

/** Izvorna stavka naloga sa deviznim parom i mestom troška. */
function sourceLine(over: Partial<CreatedLine> = {}): CreatedLine {
  return {
    accountCode: "2050",
    analyticalCode: 100,
    debit: new D(117000),
    credit: new D(0),
    fxDebit: new D(1000),
    fxCredit: null,
    fxCurrency: "EUR",
    description: "Faktura F-1/2025",
    documentNumber: "F-1/2025",
    dueDate: null,
    currency: "EUR",
    costCenter: "POS-1",
    ...over,
  };
}

function makeService(
  over: {
    status?: string;
    reversedByEntryId?: number | null;
    lines?: CreatedLine[];
    documentDate?: Date;
  } = {},
) {
  const source = {
    id: 500,
    number: "0001",
    orderTypeCode: "KR",
    companyId: 0,
    documentDate: over.documentDate ?? new Date("2025-12-31T00:00:00Z"),
    postingDate: new Date("2025-12-31T00:00:00Z"),
    status: over.status ?? "POSTED",
    reversedByEntryId: over.reversedByEntryId ?? null,
    lines: over.lines ?? [sourceLine()],
  };

  const created: CreatedEntry[] = [];
  const journalEntry = {
    findUnique: jest.fn(() => Promise.resolve(source)),
    create: jest.fn(({ data }: { data: CreatedEntry }) => {
      created.push(data);
      return Promise.resolve({ id: 900, ...data });
    }),
    update: jest.fn(() => Promise.resolve({ id: source.id })),
  };

  const prisma = {
    journalEntry,
    $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
      fn({ journalEntry }),
    ),
  } as unknown as PrismaService;

  const nextJournalNumber = jest.fn(() => Promise.resolve("0002"));
  const posting = { nextJournalNumber } as unknown as PostingEngineService;

  return {
    service: new GlWriteService(prisma, posting),
    created,
    nextJournalNumber,
  };
}

describe("GlWriteService.reverse", () => {
  describe("regresija §2 — storno stornira i devizne kolone", () => {
    it("ogleda fxDebit↔fxCredit, zadržava fxCurrency i mesto troška", async () => {
      const h = makeService();

      await h.service.reverse(500, 7);

      const line = h.created[0].lines.create[0];
      // Dinarska strana (kao i do sada).
      expect(new D(line.debit).toFixed(2)).toBe("0.00");
      expect(new D(line.credit).toFixed(2)).toBe("117000.00");
      // DEVIZNA strana — bez ovoga devizni saldo otvorene stavke ostaje udvostručen.
      expect(line.fxDebit).toBeNull();
      expect(new D(line.fxCredit ?? 0).toFixed(2)).toBe("1000.00");
      expect(line.fxCurrency).toBe("EUR");
      // Mesto troška prati stavku (salda po poslovima B2).
      expect(line.costCenter).toBe("POS-1");
    });

    it("potražna devizna stavka se ogleda u dugovnu", async () => {
      const h = makeService({
        lines: [
          sourceLine({
            accountCode: "4360",
            debit: new D(0),
            credit: new D(117000),
            fxDebit: null,
            fxCredit: new D(1000),
            costCenter: null,
          }),
        ],
      });

      await h.service.reverse(500);

      const line = h.created[0].lines.create[0];
      expect(new D(line.fxDebit ?? 0).toFixed(2)).toBe("1000.00");
      expect(line.fxCredit).toBeNull();
      expect(line.costCenter).toBeNull();
    });

    it("čisto dinarska stavka ostaje bez deviznih kolona", async () => {
      const h = makeService({
        lines: [
          sourceLine({
            fxDebit: null,
            fxCredit: null,
            fxCurrency: null,
            currency: null,
          }),
        ],
      });

      await h.service.reverse(500);

      const line = h.created[0].lines.create[0];
      expect(line.fxDebit).toBeNull();
      expect(line.fxCredit).toBeNull();
      expect(line.fxCurrency).toBeNull();
    });
  });

  describe("regresija §1 — datum knjiženja storna", () => {
    it("BEZ opts: postingDate = danas, documentDate izvornog (nepromenjeno ponašanje)", async () => {
      const h = makeService();
      const before = Date.now();

      await h.service.reverse(500, 7);

      const entry = h.created[0];
      expect(entry.documentDate.toISOString().slice(0, 10)).toBe("2025-12-31");
      expect(entry.postingDate.getTime()).toBeGreaterThanOrEqual(before);
      // Godina numeracije se i dalje izvodi iz documentDate izvornog naloga.
      expect(entry.year).toBe(2025);
    });

    it("SA opts: postingDate/documentDate su prosleđeni presek", async () => {
      const h = makeService();
      const asOf = new Date("2025-12-31T00:00:00Z");

      await h.service.reverse(500, 7, {
        postingDate: asOf,
        documentDate: asOf,
      });

      const entry = h.created[0];
      expect(entry.postingDate.toISOString().slice(0, 10)).toBe("2025-12-31");
      expect(entry.documentDate.toISOString().slice(0, 10)).toBe("2025-12-31");
      expect(entry.year).toBe(2025);
    });

    it("opts.documentDate određuje godinu numeracije", async () => {
      const h = makeService({ documentDate: new Date("2026-02-01T00:00:00Z") });

      await h.service.reverse(500, 7, {
        documentDate: new Date("2025-12-31T00:00:00Z"),
      });

      expect(h.nextJournalNumber).toHaveBeenCalledWith(
        expect.anything(),
        0,
        "KR",
        2025,
      );
      expect(h.created[0].year).toBe(2025);
    });

    it("nevalidan datum u opts → 400 (ne tihi Invalid Date u knjizi)", async () => {
      const h = makeService();
      await expect(
        h.service.reverse(500, 7, { postingDate: new Date("nije-datum") }),
      ).rejects.toThrow(/Neispravan datum storna/);
    });
  });

  describe("postojeće kontrole ostaju", () => {
    it("zaključan nalog se ne stornira bez otključavanja", async () => {
      const h = makeService({ status: "LOCKED" });
      await expect(h.service.reverse(500)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it("već storniran nalog → 409", async () => {
      const h = makeService({ reversedByEntryId: 901 });
      await expect(h.service.reverse(500)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
